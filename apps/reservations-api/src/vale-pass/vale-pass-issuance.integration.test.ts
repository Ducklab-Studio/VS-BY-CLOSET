import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import type { ValePassCampaign } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REQUIRE_ROLE_KEY } from '../admin/require-role.decorator';
import { lockShopifyOrder } from '../webhooks/shopify-order-lock';
import { ValePassWebhookService } from './vale-pass-webhook.service';
import { purgeLedgerForTest } from './ledger/ledger-test-utils';
import { ValePassIssuanceService, type IssuanceOutcome } from './vale-pass-issuance.service';
import { ValePassHoldsService, type IssueHoldExpected, type IssueHoldInput } from './vale-pass-holds.service';
import { ValePassHoldsController } from './vale-pass-holds.controller';
import { ValePassBenefitsService } from './vale-pass-benefits.service';
import { ValePassCampaignsController } from './vale-pass-campaigns.controller';
import { ValePassCampaignsService } from './vale-pass-campaigns.service';
import { ValePassLotsService } from './vale-pass-lots.service';
import { ValePassVouchersService } from './vale-pass-vouchers.service';

/**
 * Valle Pass 2027 — emissão de DOIS vouchers por unidade comercial, em PostgreSQL LOCAL descartável (sem `DATABASE_URL` de loopback com
 * nome de teste o arquivo é pulado). Linhas COMMITADAS com prefixo exclusivo desta bateria; a limpeza só apaga o que tem o prefixo.
 * Nenhuma Shopify, nenhum e-mail. O serviço de emissão NÃO está ligado ao webhook: cada teste o chama do jeito que o webhook chamaria
 * (mesma transação, lock do pedido e depois a emissão).
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const issuance = new ValePassIssuanceService();
const holds = new ValePassHoldsService(prisma, issuance);
const benefits = new ValePassBenefitsService(prisma);
const lots = new ValePassLotsService(prisma);
const campaigns = new ValePassCampaignsService(prisma);
const vouchers = new ValePassVouchersService(prisma);

const TAG = `VPI-${Date.now()}`;
let counter = 0;
let webhookCounter = 0;
let adminId: string;
let storeId: string;
const ADMIN_NAME = 'Admin Teste Emissão';
const createdCampaigns: string[] = [];
const orderIds: string[] = [];

interface Setup { globalLimit?: number | null; quantityLimit?: number | null; window?: [string, string] | null; withBenefits?: boolean }

/** Campanha no modelo Valle Pass 2027: voucher R$ 500 Valle Showroom + voucher R$ 50 VS BY CLOSET + 10% em passeios (sem voucher). */
async function newCampaign(setup: Setup = {}): Promise<ValePassCampaign> {
  const window = setup.window === undefined ? (['2027-01-01', '2027-12-31'] as [string, string]) : setup.window;
  const campaign = await prisma.valePassCampaign.create({
    data: {
      name: `${TAG}-camp-${counter++}`,
      amountCents: 35_000,
      validityDays: 30,
      globalLimit: setup.globalLimit === undefined ? null : setup.globalLimit,
      quantityLimit: setup.quantityLimit,
      voucherValidFrom: window ? new Date(`${window[0]}T00:00:00.000Z`) : null,
      voucherValidUntil: window ? new Date(`${window[1]}T00:00:00.000Z`) : null,
      shopifyVariantId: `${TAG}-var-${counter++}`,
    },
  });
  createdCampaigns.push(campaign.id);
  if (setup.withBenefits !== false) {
    await prisma.valePassCampaignBenefit.createMany({
      data: [
        { campaignId: campaign.id, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 },
        { campaignId: campaign.id, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 },
        { campaignId: campaign.id, code: 'desconto_passeios', kind: 'DISCOUNT', label: '10% de desconto em passeios', discountPercent: 10, terms: 'Condições a definir', sortOrder: 2 },
      ],
    });
  }
  return campaign;
}

interface OrderRow { id: string; quantity: number }

/** Pedidos cujo registro só nasce DENTRO da transação de emissão — como no webhook real, que registra o pedido e emite na mesma transação. */
const deferredOrders = new Map<string, Parameters<typeof prisma.valePassOrder.create>[0]['data']>();

/** Pedido PAGO registrado (CONFIRMED) com o webhook que a Shopify teria enviado (atribuição da variante à campanha). */
async function paidOrder(campaign: ValePassCampaign, quantity: number, options: { status?: 'CONFIRMED' | 'REFUNDED' | 'CANCELLED'; processed?: boolean; deferred?: boolean } = {}): Promise<OrderRow> {
  const id = `${TAG}-o${counter++}`;
  orderIds.push(id);
  const data = {
      shopifyOrderId: id,
      shopifyOrderGid: `gid://shopify/Order/${id}`,
      shopifyOrderName: `${TAG}#${counter}`,
      status: options.status ?? 'CONFIRMED',
      financialStatus: 'paid',
      quantity,
      customerName: 'Cliente Sintético',
      customerEmail: `cliente-${counter}@exemplo.invalid`,
      customerPhone: '+5500000000000',
      lastSyncSource: 'teste',
      orderCreatedAt: new Date(Date.now() - 3_600_000),
      statusChangedAt: new Date(Date.now() - 3_600_000),
      vouchersProcessedAt: options.processed === false ? null : new Date(),
  };
  if (options.deferred) deferredOrders.set(id, data);
  else await prisma.valePassOrder.create({ data });
  await prisma.webhookEvent.create({
    data: { shopifyWebhookId: `${TAG}-wh-${webhookCounter++}`, storeId, topic: 'orders/paid', orderId: id, status: 'processed', payload: { id, line_items: [{ variant_id: campaign.shopifyVariantId, quantity }] } },
  });
  return { id, quantity };
}

/** Faz o que o webhook faria: dentro de UMA transação, lock do pedido e, em seguida, a emissão. */
function issue(campaign: ValePassCampaign, order: OrderRow, options: { units?: number; mode?: 'enforce' | 'override'; actor?: { id: string; name: string }; after?: () => Promise<void> } = {}): Promise<IssuanceOutcome> {
  return prisma.$transaction(
    async (tx) => {
      await lockShopifyOrder(tx, order.id);
      const deferred = deferredOrders.get(order.id);
      if (deferred && !(await tx.valePassOrder.findUnique({ where: { shopifyOrderId: order.id } }))) await tx.valePassOrder.create({ data: deferred });
      const row = await tx.valePassOrder.findUniqueOrThrow({ where: { shopifyOrderId: order.id } });
      const outcome = await issuance.issueForCampaign(tx, {
        campaignId: campaign.id,
        order: { orderId: row.shopifyOrderId, orderGid: row.shopifyOrderGid, orderName: row.shopifyOrderName, customerName: row.customerName, customerPhone: row.customerPhone, customerEmail: row.customerEmail },
        units: options.units ?? order.quantity,
        mode: options.mode ?? 'enforce',
        actor: options.actor,
      });
      if (options.after) await options.after();
      return outcome;
    },
    { timeout: 30_000, maxWait: 20_000 },
  );
}

const benefitsOutcome = (outcome: IssuanceOutcome) => {
  if (outcome.mode !== 'benefits') throw new Error('esperava o modelo de vários vouchers');
  return outcome;
};
const vouchersOf = (orderId: string) => prisma.valePass.findMany({ where: { shopifyOrderId: orderId }, orderBy: [{ groupId: 'asc' }, { company: 'asc' }] });
const capacityOf = (campaignId: string) => lots.getCapacity(campaignId);
async function seedCapacityUnits(campaign: ValePassCampaign, units: number): Promise<void> {
  const benefits = await prisma.valePassCampaignBenefit.findMany({ where: { campaignId: campaign.id, kind: 'VOUCHER' }, orderBy: { sortOrder: 'asc' } });
  const benefit = benefits[0];
  if (!benefit?.company || benefit.amountCents === null) throw new Error('benefício de voucher da campanha ausente');
  const orderId = `${TAG}-seed-${counter++}`;
  orderIds.push(orderId);
  const now = new Date();
  await prisma.valePass.createMany({
    data: Array.from({ length: units }, (_, i) => ({
      code: `${TAG}-seed-${counter}-${i}`,
      campaignId: campaign.id,
      amountCents: benefit.amountCents!,
      status: 'ACTIVE' as const,
      purchasedAt: now,
      expiresAt: new Date('2028-01-01T00:00:00.000Z'),
      customerName: 'Semente sintética de capacidade',
      shopifyOrderId: orderId,
      company: benefit.company!,
      groupId: randomUUID(),
      benefitId: benefit.id,
      validFrom: new Date('2027-01-01T00:00:00.000Z'),
    })),
  });
}
/** Faz o que a tela faz: abre a confirmação reforçada (preview) e monta o pedido de emissão com os números que viu e o total digitado. */
const confirm = async (holdId: string, note: string, patch: { confirmTotal?: number; expected?: Partial<IssueHoldExpected> } = {}): Promise<IssueHoldInput> => {
  const p = await holds.preview(holdId);
  return {
    note,
    confirmTotal: patch.confirmTotal ?? p.projectedTotal,
    expected: { projectedTotal: p.projectedTotal, consumedTotal: p.consumedBefore, globalLimit: p.globalLimit, capacityLimit: p.capacityLimit, holdUpdatedAt: p.holdUpdatedAt, ...patch.expected },
  };
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  if (!localDatabase) return;
  adminId = (await prisma.adminUser.create({ data: { name: ADMIN_NAME, phone: `${TAG}-phone`, pinHash: 'x', role: 'ADMIN', active: true } })).id;
  storeId = `${TAG}-store`;
  await prisma.$executeRaw`INSERT INTO stores (id, shopify_domain, currency) VALUES (${storeId}, ${storeId + '.invalid'}, 'BRL')`;
});

afterEach(async () => {
  if (!localDatabase) return;
  await prisma.webhookEvent.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.valePassOrderCancellation.deleteMany({ where: { shopifyOrderId: { in: orderIds } } });
  await prisma.valePassOrder.deleteMany({ where: { shopifyOrderId: { in: orderIds } } });
  orderIds.length = 0;
});

afterAll(async () => {
  if (localDatabase) {
    const holdRows = await prisma.valePassIssuanceHold.findMany({ where: { campaignId: { in: createdCampaigns } }, select: { id: true } });
    const lotRows = await prisma.valePassLot.findMany({ where: { campaignId: { in: createdCampaigns } }, select: { id: true } });
    const voucherRows = await prisma.valePass.findMany({ where: { campaignId: { in: createdCampaigns } }, select: { id: true } });
    await prisma.adminAuditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...createdCampaigns, ...holdRows.map((h) => h.id), ...lotRows.map((l) => l.id), ...voucherRows.map((v) => v.id)] } }, { adminUserId: adminId }] } });
    await prisma.valePassEvent.deleteMany({ where: { valePassId: { in: voucherRows.map((v) => v.id) } } });
    await prisma.$transaction((tx) => purgeLedgerForTest(tx, { campaignIds: createdCampaigns }));
    await prisma.valePass.deleteMany({ where: { campaignId: { in: createdCampaigns } } });
    await prisma.valePassIssuanceHold.deleteMany({ where: { campaignId: { in: createdCampaigns } } });
    await prisma.valePassLot.deleteMany({ where: { campaignId: { in: createdCampaigns } } });
    await prisma.valePassCampaignBenefit.deleteMany({ where: { campaignId: { in: createdCampaigns } } });
    await prisma.valePassCampaign.deleteMany({ where: { id: { in: createdCampaigns } } });
    await prisma.webhookEvent.deleteMany({ where: { storeId } });
    await prisma.$executeRaw`DELETE FROM stores WHERE id = ${storeId}`;
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
  }
  await prisma.$disconnect();
});

localDescribe('Valle Pass 2027 — uma unidade paga gera exatamente dois vouchers', () => {
  test('1 unidade → 2 vouchers (R$ 500 Valle Showroom + R$ 50 VS BY CLOSET), códigos distintos, mesmo grupo, validade 2027', async () => {
    const c = await newCampaign();
    const order = await paidOrder(c, 1);
    const outcome = benefitsOutcome(await issue(c, order));
    expect(outcome).toMatchObject({ issuedUnits: 1, completedUnits: 0, heldUnits: 0, holdId: null, vouchersCreated: 2 });

    const rows = await vouchersOf(order.id);
    expect(rows).toHaveLength(2);
    const byCompany = Object.fromEntries(rows.map((row) => [row.company, row]));
    expect(byCompany.VALLE_SHOWROOM).toMatchObject({ amountCents: 50_000, status: 'ACTIVE' });
    expect(byCompany.VS_BY_CLOSET).toMatchObject({ amountCents: 5_000, status: 'ACTIVE' });
    expect(new Set(rows.map((row) => row.code)).size).toBe(2); // códigos independentes
    expect(rows[0].code).toMatch(/^VALLE-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(new Set(rows.map((row) => row.groupId)).size).toBe(1); // mesma unidade comercial
    expect(rows[0].groupId).not.toBeNull();
    expect(new Set(rows.map((row) => row.benefitId)).size).toBe(2);
    // o desconto de 10% é direito descritivo: NÃO gera voucher
    expect(rows.every((row) => row.company !== null)).toBe(true);
    // validade "durante 2027" (fuso provisório America/Sao_Paulo, UTC−3): início 01/01 00:00 e expira em 01/01/2028 00:00
    for (const row of rows) {
      expect(row.validFrom?.toISOString()).toBe('2027-01-01T03:00:00.000Z');
      expect(row.expiresAt.toISOString()).toBe('2028-01-01T03:00:00.000Z');
      expect(row).toMatchObject({ shopifyOrderId: order.id, customerEmail: expect.stringContaining('@exemplo.invalid'), campaignId: c.id });
    }
    // eventos de cada voucher não carregam o código
    const events = await prisma.valePassEvent.findMany({ where: { valePassId: { in: rows.map((row) => row.id) } } });
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain(rows[0].code);
    expect(JSON.stringify(outcome.events)).not.toContain(rows[0].code);
  });

  test('uma venda consome UMA unidade da capacidade e do "vendidos", embora gere dois vouchers', async () => {
    const c = await newCampaign({ globalLimit: 1000 });
    const order = await paidOrder(c, 1);
    await issue(c, order);
    const capacity = await capacityOf(c.id);
    expect(capacity.totals).toMatchObject({ issued: 1, sold: 1, pending: 0, consumed: 1, cancelled: 0 });
    expect(capacity.globalRemaining).toBe(999);
    expect((await campaigns.list()).find((item) => item.id === c.id)?.soldCount).toBe(1); // unidades, não linhas
    expect(await prisma.valePass.count({ where: { campaignId: c.id } })).toBe(2);
  });

  test('fronteiras 999/1000/1001: emite só a unidade que cabe; override e reentrega mantêm uma retenção sem vouchers excedentes', async () => {
    for (const startingUnits of [999, 1000, 1001]) {
      const c = await newCampaign({ globalLimit: 1000 });
      await seedCapacityUnits(c, startingUnits);
      const order = await paidOrder(c, 1);
      const first = benefitsOutcome(await issue(c, order));
      if (startingUnits === 999) {
        expect(first).toMatchObject({ issuedUnits: 1, heldUnits: 0 });
        expect(await vouchersOf(order.id)).toHaveLength(2);
        expect((await capacityOf(c.id)).totals.consumed).toBe(1000);
        continue;
      }

      expect(first).toMatchObject({ issuedUnits: 0, heldUnits: 1 });
      expect(await vouchersOf(order.id)).toHaveLength(0);
      const repeated = benefitsOutcome(await issue(c, order));
      expect(repeated.holdId).toBe(first.holdId);
      expect(await prisma.valePassIssuanceHold.count({ where: { shopifyOrderId: order.id, status: 'OPEN' } })).toBe(1);

      const override = benefitsOutcome(await issue(c, order, { mode: 'override', actor: { id: adminId, name: ADMIN_NAME } }));
      expect(override).toMatchObject({ issuedUnits: 0, heldUnits: 1, holdId: first.holdId });
      await expect(holds.issue(first.holdId as string, await confirm(first.holdId as string, 'Tentativa administrativa revisada'), adminId, ADMIN_NAME)).rejects.toThrow(/excederia o teto configurado/);
      expect(await vouchersOf(order.id)).toHaveLength(0);
      expect((await prisma.valePassIssuanceHold.findUniqueOrThrow({ where: { id: first.holdId as string } })).status).toBe('OPEN');
      expect((await capacityOf(c.id)).totals.consumed).toBe(startingUnits + 1); // o excedente é apenas pendência paga, nunca voucher
    }
  });

  test('pedido com várias unidades: 3 unidades → 6 vouchers em 3 grupos completos', async () => {
    const c = await newCampaign({ globalLimit: 1000 });
    const order = await paidOrder(c, 3);
    expect(benefitsOutcome(await issue(c, order))).toMatchObject({ issuedUnits: 3, vouchersCreated: 6 });
    const rows = await vouchersOf(order.id);
    expect(rows).toHaveLength(6);
    const groups = new Map<string, string[]>();
    for (const row of rows) groups.set(row.groupId as string, [...(groups.get(row.groupId as string) ?? []), row.company as string]);
    expect(groups.size).toBe(3);
    for (const companies of groups.values()) expect(companies.sort()).toEqual(['VALLE_SHOWROOM', 'VS_BY_CLOSET']);
    expect(new Set(rows.map((row) => row.code)).size).toBe(6);
    expect((await capacityOf(c.id)).totals.consumed).toBe(3);
  });

  test('campanha SEM benefícios continua no modelo legado (nada é emitido por este serviço)', async () => {
    const c = await newCampaign({ withBenefits: false });
    const order = await paidOrder(c, 2);
    expect(await issue(c, order)).toEqual({ mode: 'legacy' });
    expect(await vouchersOf(order.id)).toHaveLength(0);
  });
});

localDescribe('Valle Pass 2027 — idempotência, concorrência e recuperação', () => {
  test('webhook duplicado ou reprocessado nunca duplica vouchers nem códigos', async () => {
    const c = await newCampaign({ globalLimit: 1000 });
    const order = await paidOrder(c, 2);
    await issue(c, order);
    const first = (await vouchersOf(order.id)).map((row) => row.code).sort();
    for (let i = 0; i < 3; i++) {
      const again = benefitsOutcome(await issue(c, order));
      expect(again).toMatchObject({ issuedUnits: 0, completedUnits: 0, vouchersCreated: 0 });
      expect(again.events.map((event) => event.type)).toEqual(['VALE_PASS_ALREADY_ISSUED']);
    }
    expect((await vouchersOf(order.id)).map((row) => row.code).sort()).toEqual(first);
    expect((await capacityOf(c.id)).totals.consumed).toBe(2);
  });

  test('entregas simultâneas do MESMO pedido: exatamente 2 vouchers por unidade', async () => {
    const c = await newCampaign({ globalLimit: 1000 });
    const order = await paidOrder(c, 2);
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => issue(c, order)));
    expect(outcomes.map((outcome) => benefitsOutcome(outcome).vouchersCreated).sort()).toEqual([0, 0, 0, 0, 0, 4]);
    expect(await vouchersOf(order.id)).toHaveLength(4);
  });

  test('fora de ordem: cancelamento confirmado ANTES da emissão → vouchers nascem cancelados e não consomem capacidade', async () => {
    const c = await newCampaign({ globalLimit: 1 });
    const order = await paidOrder(c, 1);
    await prisma.valePassOrderCancellation.create({ data: { shopifyOrderId: order.id, topic: 'refunds/create' } });
    const outcome = benefitsOutcome(await issue(c, order));
    expect(outcome).toMatchObject({ issuedUnits: 1, heldUnits: 0, vouchersCreated: 2 });
    const rows = await vouchersOf(order.id);
    expect(rows.map((row) => row.status)).toEqual(['CANCELLED', 'CANCELLED']);
    expect(rows.every((row) => row.cancelReason === 'refunds/create' && row.cancelledBy === null)).toBe(true);
    expect((await capacityOf(c.id)).totals).toMatchObject({ sold: 0, consumed: 0 });
  });

  test('emissão parcialmente concluída: completa só o voucher que faltou, sem consumir capacidade e mesmo com o limite esgotado', async () => {
    const c = await newCampaign({ globalLimit: 1 });
    const order = await paidOrder(c, 1);
    const [showroom] = await prisma.valePassCampaignBenefit.findMany({ where: { campaignId: c.id, company: 'VALLE_SHOWROOM' } });
    const groupId = '11111111-1111-4111-8111-111111111111';
    await prisma.valePass.create({
      data: {
        code: `${TAG}-parcial`, campaignId: c.id, amountCents: 50_000, status: 'ACTIVE', purchasedAt: new Date(), expiresAt: new Date('2028-01-01T03:00:00Z'), validFrom: new Date('2027-01-01T03:00:00Z'),
        company: 'VALLE_SHOWROOM', groupId, benefitId: showroom.id, shopifyOrderId: order.id,
      },
    });
    const outcome = benefitsOutcome(await issue(c, order));
    expect(outcome).toMatchObject({ issuedUnits: 0, completedUnits: 1, vouchersCreated: 1, heldUnits: 0 });
    const rows = await vouchersOf(order.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.company).sort()).toEqual(['VALLE_SHOWROOM', 'VS_BY_CLOSET']);
    expect(rows.every((row) => row.groupId === groupId)).toBe(true);
    expect(rows.find((row) => row.company === 'VALLE_SHOWROOM')?.code).toBe(`${TAG}-parcial`); // o voucher que já existia não foi tocado
    expect((await capacityOf(c.id)).totals).toMatchObject({ sold: 1, consumed: 1 });
  });

  test('falha no meio da emissão: a transação inteira desfaz (nenhum voucher pela metade) e o reprocessamento conclui', async () => {
    const c = await newCampaign({ globalLimit: 10 });
    const order = await paidOrder(c, 2);
    await expect(issue(c, order, { after: async () => { throw new Error('queda simulada do banco'); } })).rejects.toThrow(/queda simulada/);
    expect(await vouchersOf(order.id)).toHaveLength(0);
    expect(await prisma.valePassIssuanceHold.count({ where: { campaignId: c.id } })).toBe(0);
    expect(benefitsOutcome(await issue(c, order))).toMatchObject({ issuedUnits: 2, vouchersCreated: 4 });
    expect(await vouchersOf(order.id)).toHaveLength(4);
  });

  test('o banco é a última linha: o mesmo benefício não entra duas vezes na mesma unidade, e empresa/grupo/benefício andam juntos', async () => {
    const c = await newCampaign();
    const [showroom] = await prisma.valePassCampaignBenefit.findMany({ where: { campaignId: c.id, company: 'VALLE_SHOWROOM' } });
    const base = { campaignId: c.id, amountCents: 50_000, status: 'ACTIVE' as const, purchasedAt: new Date(), expiresAt: new Date('2028-01-01T03:00:00Z'), company: 'VALLE_SHOWROOM' as const, groupId: '22222222-2222-4222-8222-222222222222', benefitId: showroom.id };
    await prisma.valePass.create({ data: { ...base, code: `${TAG}-dup-a` } });
    await expect(prisma.valePass.create({ data: { ...base, code: `${TAG}-dup-b` } })).rejects.toThrow(/Unique constraint/i);
    await expect(prisma.valePass.create({ data: { campaignId: c.id, amountCents: 1, purchasedAt: new Date(), expiresAt: new Date('2028-01-01'), code: `${TAG}-solto`, company: 'VS_BY_CLOSET' } })).rejects.toThrow(/vp_company_group_benefit_together/);
    await expect(prisma.valePass.create({ data: { campaignId: c.id, amountCents: 1, purchasedAt: new Date(), expiresAt: new Date('2028-01-01'), validFrom: new Date('2029-01-01'), code: `${TAG}-janela` } })).rejects.toThrow(/vp_valid_window/);
  });
});

localDescribe('Valle Pass 2027 — lote esgotado, limite global de 1.000 e pagamento sem capacidade', () => {
  test('sem capacidade: o pedido pago é RETIDO inteiro (tudo ou nada), com retenção aberta, alerta crítico e capacidade ainda consumida', async () => {
    const c = await newCampaign({ globalLimit: 5 });
    const full = await paidOrder(c, 4);
    await issue(c, full); // consome 4 de 5
    const order = await paidOrder(c, 2); // precisa de 2, restam 1
    const outcome = benefitsOutcome(await issue(c, order));
    expect(outcome).toMatchObject({ issuedUnits: 0, heldUnits: 2, vouchersCreated: 0 });
    expect(outcome.holdId).not.toBeNull();
    expect(await vouchersOf(order.id)).toHaveLength(0);

    const hold = await prisma.valePassIssuanceHold.findUniqueOrThrow({ where: { id: outcome.holdId as string } });
    expect(hold).toMatchObject({ units: 2, reason: 'CAPACITY_EXCEEDED', status: 'OPEN', openFlag: true, shopifyOrderId: order.id });
    expect(hold.detail).toMatchObject({ globalLimit: 5, consumedWithoutThisOrder: 4, allowedUnits: 1 });

    const capacity = await capacityOf(c.id);
    expect(capacity.totals).toMatchObject({ sold: 4, pending: 2, consumed: 6 }); // a unidade paga sem voucher AINDA consome
    expect(capacity.globalRemaining).toBe(0);
    expect(capacity.holds).toEqual([expect.objectContaining({ id: hold.id, units: 2, reason: 'CAPACITY_EXCEEDED', shopifyOrderId: order.id })]);
    expect(capacity.alerts.map((a) => a.code)).toEqual(expect.arrayContaining(['ISSUANCE_HOLDS_OPEN', 'GLOBAL_LIMIT_EXCEEDED']));
    expect(capacity.alerts.find((a) => a.code === 'ISSUANCE_HOLDS_OPEN')?.severity).toBe('critical');
    await expect(lots.create(c.id, { name: 'fictício', quantity: 1 }, adminId, ADMIN_NAME)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  test('entrega repetida de um pedido retido não duplica a retenção (uma ABERTA por pedido) e a unidade que cabe é emitida', async () => {
    const c = await newCampaign({ globalLimit: 3 });
    const filler = await paidOrder(c, 3);
    await issue(c, filler);
    const order = await paidOrder(c, 1);
    for (let i = 0; i < 3; i++) benefitsOutcome(await issue(c, order));
    expect(await prisma.valePassIssuanceHold.count({ where: { shopifyOrderId: order.id, status: 'OPEN' } })).toBe(1);
    await expect(prisma.valePassIssuanceHold.create({ data: { shopifyOrderId: order.id, campaignId: c.id, units: 1, reason: 'CAPACITY_EXCEEDED', status: 'OPEN', openFlag: true } })).rejects.toThrow(/Unique constraint/i);
    // mais capacidade (admin sobe o limite) e o MESMO reprocessamento emite e fecha a retenção sozinho
    await prisma.valePassCampaign.update({ where: { id: c.id }, data: { globalLimit: 4 } });
    expect(benefitsOutcome(await issue(c, order))).toMatchObject({ issuedUnits: 1, vouchersCreated: 2 });
    const closed = await prisma.valePassIssuanceHold.findFirstOrThrow({ where: { shopifyOrderId: order.id } });
    expect(closed).toMatchObject({ status: 'ISSUED', openFlag: null, issuedUnits: 1 });
    expect(closed.resolutionNote).toMatch(/reprocessamento/);
  });

  test('o limite do LOTE e o limite LEGADO nunca bloqueiam a emissão (só o global, e com fila)', async () => {
    const c = await newCampaign({ globalLimit: 100 });
    await prisma.valePassCampaign.update({ where: { id: c.id }, data: { quantityLimit: 1 } }); // legado: bloquearia o 2º passe no modelo antigo
    const lot = await lots.create(c.id, { name: 'Lote pequeno', quantity: 1 }, adminId, ADMIN_NAME);
    await lots.open(c.id, lot.id, lot.updatedAt, adminId, ADMIN_NAME);
    await sleep(15);
    for (let i = 0; i < 3; i++) benefitsOutcome(await issue(c, await paidOrder(c, 1)));
    expect(await prisma.valePass.count({ where: { campaignId: c.id } })).toBe(6); // 3 unidades × 2
    expect((await capacityOf(c.id)).openLot).toMatchObject({ sold: 3, soldOut: true }); // o lote esgotou e foi ultrapassado; ninguém ficou sem passe
    expect(await prisma.valePassIssuanceHold.count({ where: { campaignId: c.id } })).toBe(0);
  });

  test('concorrência no último lugar: dois pedidos disputando 1 unidade → um emite, o outro é retido; nunca acima do limite', async () => {
    const c = await newCampaign({ globalLimit: 1 });
    const [a, b] = [await paidOrder(c, 1, { deferred: true }), await paidOrder(c, 1, { deferred: true })];
    const [oa, ob] = await Promise.all([issue(c, a), issue(c, b)]);
    const issued = [oa, ob].map((outcome) => benefitsOutcome(outcome).issuedUnits).sort();
    expect(issued).toEqual([0, 1]);
    const capacity = await capacityOf(c.id);
    expect(capacity.totals.sold).toBe(1);
    expect(capacity.holds).toHaveLength(1);
    expect(await prisma.valePass.count({ where: { campaignId: c.id } })).toBe(2);
  });

  test('estresse: 30 pedidos simultâneos, limite 20 → exatamente 20 unidades (40 vouchers), 10 retenções, nada pela metade', async () => {
    const c = await newCampaign({ globalLimit: 20 });
    const orders: OrderRow[] = [];
    for (let i = 0; i < 30; i++) orders.push(await paidOrder(c, 1, { deferred: true }));
    const outcomes: IssuanceOutcome[] = [];
    for (let batch = 0; batch < 30; batch += 10) outcomes.push(...(await Promise.all(orders.slice(batch, batch + 10).map((order) => issue(c, order)))));
    expect(outcomes.filter((outcome) => benefitsOutcome(outcome).issuedUnits === 1)).toHaveLength(20);
    expect(outcomes.filter((outcome) => benefitsOutcome(outcome).heldUnits === 1)).toHaveLength(10);
    expect(await prisma.valePass.count({ where: { campaignId: c.id } })).toBe(40);
    const perGroup = await prisma.valePass.groupBy({ by: ['groupId'], where: { campaignId: c.id }, _count: { _all: true } });
    expect(perGroup).toHaveLength(20);
    expect(perGroup.every((group) => group._count._all === 2)).toBe(true);
    expect(await prisma.valePassIssuanceHold.count({ where: { campaignId: c.id, status: 'OPEN' } })).toBe(10);
    const capacity = await capacityOf(c.id);
    expect(capacity.totals).toMatchObject({ sold: 20, pending: 10, consumed: 30 }); // as 10 retidas continuam consumindo até serem resolvidas
  }, 120_000);
});

localDescribe('Valle Pass 2027 — resolução administrativa da fila', () => {
  test('pedido acima do limite permanece retido até a capacidade ser ampliada; então emite sem ultrapassar o novo teto', async () => {
    const c = await newCampaign({ globalLimit: 1 });
    await issue(c, await paidOrder(c, 1));
    const order = await paidOrder(c, 2);
    const held = benefitsOutcome(await issue(c, order));
    expect(held.heldUnits).toBe(2);

    await expect(holds.issue(held.holdId as string, await confirm(held.holdId as string, '  '), adminId, ADMIN_NAME)).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(holds.issue(held.holdId as string, await confirm(held.holdId as string, 'Excedente aprovado pelo Anderson (teste)'), adminId, ADMIN_NAME)).rejects.toThrow(/excederia o teto configurado/);
    await expect(vouchersOf(order.id)).resolves.toHaveLength(0);
    await expect(prisma.valePassIssuanceHold.findUniqueOrThrow({ where: { id: held.holdId as string } })).resolves.toMatchObject({ status: 'OPEN' });
    await prisma.valePassCampaign.update({ where: { id: c.id }, data: { globalLimit: 3 } });
    const good = await confirm(held.holdId as string, 'Excedente aprovado pelo Anderson (teste)');
    const resolved = await holds.issue(held.holdId as string, good, adminId, ADMIN_NAME);
    expect(resolved).toMatchObject({ status: 'ISSUED', issuedUnits: 2, resolutionNote: 'Excedente aprovado pelo Anderson (teste)' });
    expect(await vouchersOf(order.id)).toHaveLength(4);
    const capacity = await capacityOf(c.id);
    expect(capacity.totals).toMatchObject({ sold: 3, pending: 0, consumed: 3 });
    expect(capacity.alerts.map((a) => a.code)).not.toContain('GLOBAL_LIMIT_EXCEEDED');
    expect(capacity.holds).toHaveLength(0);

    const audit = await prisma.adminAuditEvent.findMany({ where: { entityId: held.holdId as string } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'VALE_PASS_HOLD_ISSUED', adminUserId: adminId, isCritical: true });
    expect(audit[0].detail).toMatchObject({ note: 'Excedente aprovado pelo Anderson (teste)', override: true });
    await expect(holds.issue(held.holdId as string, { ...good, note: 'de novo, mais uma vez' }, adminId, ADMIN_NAME)).rejects.toBeInstanceOf(ConflictException);
    await expect(holds.dismiss(held.holdId as string, 'tarde demais', adminId, ADMIN_NAME)).rejects.toBeInstanceOf(ConflictException);
    expect(await vouchersOf(order.id)).toHaveLength(4); // nada duplicou
  });

  test('descartar: só depois de o pedido deixar de estar pago (reembolso/cancelamento); nunca reembolsa nem cancela por conta própria', async () => {
    const c = await newCampaign({ globalLimit: 1 });
    await issue(c, await paidOrder(c, 1));
    const order = await paidOrder(c, 1);
    const held = benefitsOutcome(await issue(c, order));

    await expect(holds.dismiss(held.holdId as string, 'cliente desistiu', adminId, ADMIN_NAME)).rejects.toThrow(/continua pago/);
    expect((await prisma.valePassIssuanceHold.findUniqueOrThrow({ where: { id: held.holdId as string } })).status).toBe('OPEN');

    // o reembolso acontece NA SHOPIFY e chega pelo webhook (aqui: o registro do pedido muda para REFUNDED)
    await prisma.valePassOrder.update({ where: { shopifyOrderId: order.id }, data: { status: 'REFUNDED' } });
    const dismissed = await holds.dismiss(held.holdId as string, 'pedido reembolsado na Shopify', adminId, ADMIN_NAME);
    expect(dismissed).toMatchObject({ status: 'DISMISSED', issuedUnits: null, orderStatus: 'REFUNDED' });
    expect(await vouchersOf(order.id)).toHaveLength(0);
    expect((await capacityOf(c.id)).totals).toMatchObject({ pending: 0, consumed: 1 }); // reembolsado: liberou a capacidade
    expect((await prisma.adminAuditEvent.findFirstOrThrow({ where: { entityId: held.holdId as string } })).action).toBe('VALE_PASS_HOLD_DISMISSED');
    // e não dá para emitir para um pedido que já não está pago
    const again = benefitsOutcome(await issue(c, await paidOrder(c, 1)));
    await prisma.valePassOrder.update({ where: { shopifyOrderId: (await prisma.valePassIssuanceHold.findUniqueOrThrow({ where: { id: again.holdId as string } })).shopifyOrderId }, data: { status: 'CANCELLED' } });
    await expect(holds.issue(again.holdId as string, await confirm(again.holdId as string, 'tentativa de emissão'), adminId, ADMIN_NAME)).rejects.toThrow(/não está mais pago/);
  });

  test('campanha sem validade configurada: retém (nunca improvisa nem cai no legado); resolver exige configurar; depois o reprocessamento emite', async () => {
    const c = await newCampaign({ window: null });
    const order = await paidOrder(c, 1);
    const held = benefitsOutcome(await issue(c, order));
    expect(held).toMatchObject({ heldUnits: 1, issuedUnits: 0 });
    expect(await prisma.valePassIssuanceHold.findUniqueOrThrow({ where: { id: held.holdId as string } })).toMatchObject({ reason: 'CAMPAIGN_NOT_READY' });
    await expect(holds.issue(held.holdId as string, await confirm(held.holdId as string, 'tentando mesmo assim'), adminId, ADMIN_NAME)).rejects.toThrow(/ainda não está pronta/);
    expect((await prisma.valePassIssuanceHold.findUniqueOrThrow({ where: { id: held.holdId as string } })).status).toBe('OPEN');

    await prisma.valePassCampaign.update({ where: { id: c.id }, data: { voucherValidFrom: new Date('2027-01-01T00:00:00Z'), voucherValidUntil: new Date('2027-12-31T00:00:00Z') } });
    expect(benefitsOutcome(await issue(c, order))).toMatchObject({ issuedUnits: 1, vouchersCreated: 2 });
    expect((await prisma.valePassIssuanceHold.findUniqueOrThrow({ where: { id: held.holdId as string } })).status).toBe('ISSUED');
  });

  test('campanha com benefícios cadastrados mas todos inativos: retém, NÃO volta ao modelo legado', async () => {
    const c = await newCampaign();
    await prisma.valePassCampaignBenefit.updateMany({ where: { campaignId: c.id }, data: { active: false } });
    const outcome = await issue(c, await paidOrder(c, 1));
    expect(outcome.mode).toBe('benefits');
    expect(benefitsOutcome(outcome)).toMatchObject({ heldUnits: 1, issuedUnits: 0 });
  });

  test('permissões: ver a fila é do módulo; emitir e descartar são só ADMIN; benefícios idem', () => {
    const proto = ValePassHoldsController.prototype as unknown as Record<string, unknown>;
    for (const handler of ['issue', 'dismiss']) expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto[handler] as object), handler).toBe('ADMIN');
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto.list as object)).toBeUndefined();
    const campaignsProto = ValePassCampaignsController.prototype as unknown as Record<string, unknown>;
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, campaignsProto.putBenefits as object)).toBe('ADMIN');
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, campaignsProto.listBenefits as object)).toBeUndefined();
  });
});

localDescribe('Valle Pass 2027 — resolução administrativa sujeita ao teto: confirmação reforçada', () => {
  /** Campanha com limite 5: 4 unidades emitidas e um pedido de 2 retido (consumo 6 de 5 — excede em 1). */
  async function heldScenario() {
    const c = await newCampaign({ globalLimit: 5 });
    await issue(c, await paidOrder(c, 4));
    const order = await paidOrder(c, 2);
    const held = benefitsOutcome(await issue(c, order));
    return { c, order, holdId: held.holdId as string };
  }
  const nothingIssued = async (orderId: string, holdId: string) => {
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect((await prisma.valePassIssuanceHold.findUniqueOrThrow({ where: { id: holdId } })).status).toBe('OPEN');
    expect(await prisma.adminAuditEvent.count({ where: { entityId: holdId } })).toBe(0);
  };

  test('o retrato mostra limite, consumo de hoje e o total projetado, e avisa que ultrapassa o limite', async () => {
    const { c, holdId } = await heldScenario();
    const p = await holds.preview(holdId);
    expect(p).toMatchObject({
      globalLimit: 5, capacityLimit: 5, units: 2, soldBefore: 4, pendingBefore: 2, consumedBefore: 6,
      soldAfter: 6, pendingAfter: 0, projectedTotal: 6, exceedsLimit: true, exceededBy: 1, canIssue: false, blockedReason: expect.stringContaining('permanece retido'), reason: 'CAPACITY_EXCEEDED',
    });
    // somente leitura: nada mudou
    expect((await capacityOf(c.id)).totals).toMatchObject({ sold: 4, pending: 2, consumed: 6 });
  });

  test('sem confirmação, com total errado ou com justificativa curta: recusa e NADA é emitido', async () => {
    const { order, holdId } = await heldScenario();
    for (const confirmTotal of [undefined, Number.NaN, 0, 5, 7, 6.5]) {
      const input = await confirm(holdId, 'Justificativa suficientemente longa');
      await expect(holds.issue(holdId, { ...input, confirmTotal: confirmTotal as number }, adminId, ADMIN_NAME), String(confirmTotal)).rejects.toBeInstanceOf(UnprocessableEntityException);
    }
    await expect(holds.issue(holdId, { ...(await confirm(holdId, 'curta')), note: 'curta' }, adminId, ADMIN_NAME)).rejects.toThrow(/mínimo 10/);
    await expect(holds.issue(holdId, { ...(await confirm(holdId, '123456789')), note: '123456789' }, adminId, ADMIN_NAME)).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(holds.issue(holdId, { note: 'Justificativa suficientemente longa', confirmTotal: 6 } as IssueHoldInput, adminId, ADMIN_NAME)).rejects.toBeInstanceOf(ConflictException); // sem os números vistos
    await nothingIssued(order.id, holdId);
  });

  test('a confirmação digitada NÃO substitui o servidor: números vistos desatualizados são rejeitados mesmo com o total certo', async () => {
    const { order, holdId } = await heldScenario();
    const good = await confirm(holdId, 'Justificativa suficientemente longa');
    for (const expected of [{ projectedTotal: 5 }, { consumedTotal: 5 }, { globalLimit: 1000 }, { globalLimit: null }, { capacityLimit: 1000 }, { capacityLimit: null }, { holdUpdatedAt: '2020-01-01T00:00:00.000Z' }]) {
      await expect(holds.issue(holdId, { ...good, expected: { ...good.expected, ...expected } }, adminId, ADMIN_NAME), JSON.stringify(expected)).rejects.toBeInstanceOf(ConflictException);
    }
    await nothingIssued(order.id, holdId);
  });

  test('capacidade muda entre a visualização e a confirmação → rejeita e exige nova confirmação (limite alterado, novo pedido, retenção reaberta)', async () => {
    const { c, order, holdId } = await heldScenario();

    // 1) um ADMIN altera o limite global
    const viewed = await confirm(holdId, 'Justificativa suficientemente longa');
    await prisma.valePassCampaign.update({ where: { id: c.id }, data: { globalLimit: 6 } });
    await expect(holds.issue(holdId, viewed, adminId, ADMIN_NAME)).rejects.toThrow(/mudou desde que a confirmação foi aberta/);
    await nothingIssued(order.id, holdId);

    // 2) outro pedido pago entra (consome capacidade) depois de a pessoa abrir a confirmação
    const viewed2 = await confirm(holdId, 'Justificativa suficientemente longa');
    await issue(c, await paidOrder(c, 1)); // o limite agora tem 0 de folga: o novo pedido também fica retido e conta como consumido
    await expect(holds.issue(holdId, viewed2, adminId, ADMIN_NAME)).rejects.toBeInstanceOf(ConflictException);
    await nothingIssued(order.id, holdId);

    // 3) a retenção é reatualizada por reentrega do webhook
    const viewed3 = await confirm(holdId, 'Justificativa suficientemente longa');
    await sleep(15);
    await issue(c, order);
    await expect(holds.issue(holdId, viewed3, adminId, ADMIN_NAME)).rejects.toBeInstanceOf(ConflictException);
    await nothingIssued(order.id, holdId);

    // nova abertura da confirmação com os números atuais: agora emite
    await prisma.valePassCampaign.update({ where: { id: c.id }, data: { globalLimit: 7 } });
    const refreshed = await confirm(holdId, 'Justificativa suficientemente longa');
    expect(refreshed.confirmTotal).toBe((await holds.preview(holdId)).projectedTotal);
    await holds.issue(holdId, refreshed, adminId, ADMIN_NAME);
    expect(await vouchersOf(order.id)).toHaveLength(4);
  });

  test('perfil revalidado no servidor: STAFF, administrador inativo e usuário inexistente não emitem', async () => {
    const { order, holdId } = await heldScenario();
    const input = await confirm(holdId, 'Justificativa suficientemente longa');
    const staff = await prisma.adminUser.create({ data: { name: 'Operador Teste Emissão', phone: `${TAG}-staff`, pinHash: 'x', role: 'STAFF', active: true } });
    const gone = await prisma.adminUser.create({ data: { name: 'Admin Inativo Teste', phone: `${TAG}-gone`, pinHash: 'x', role: 'ADMIN', active: false } });
    try {
      await expect(holds.issue(holdId, input, staff.id, staff.name)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(holds.issue(holdId, input, gone.id, gone.name)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(holds.issue(holdId, input, '00000000-0000-4000-8000-000000000000', 'fantasma')).rejects.toBeInstanceOf(ForbiddenException);
      await nothingIssued(order.id, holdId);
      // e a rota continua só ADMIN (o guard é a primeira barreira; o serviço, a segunda)
      const proto = ValePassHoldsController.prototype as unknown as Record<string, unknown>;
      for (const handler of ['preview', 'issue', 'dismiss']) expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto[handler] as object), handler).toBe('ADMIN');
    } finally {
      await prisma.adminAuditEvent.deleteMany({ where: { adminUserId: { in: [staff.id, gone.id] } } });
      await prisma.adminUser.deleteMany({ where: { id: { in: [staff.id, gone.id] } } });
    }
  });

  test('duplo clique/duas abas: dentro do teto, exatamente uma emissão vale; sem vouchers em dobro', async () => {
    const { order, holdId } = await heldScenario();
    await prisma.valePassCampaign.update({ where: { id: (await prisma.valePassIssuanceHold.findUniqueOrThrow({ where: { id: holdId } })).campaignId }, data: { globalLimit: 6 } });
    const input = await confirm(holdId, 'Justificativa suficientemente longa');
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => holds.issue(holdId, input, adminId, ADMIN_NAME)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason instanceof ConflictException)).toBe(true);
    expect(await vouchersOf(order.id)).toHaveLength(4);
    expect(await prisma.adminAuditEvent.count({ where: { entityId: holdId, action: 'VALE_PASS_HOLD_ISSUED' } })).toBe(1);
  });

  test('concorrência com um pedido novo: a resolução e a emissão automática nunca ultrapassam o teto', async () => {
    const { c, order, holdId } = await heldScenario();
    await prisma.valePassCampaign.update({ where: { id: c.id }, data: { globalLimit: 6 } });
    const input = await confirm(holdId, 'Justificativa suficientemente longa');
    const newcomer = await paidOrder(c, 1, { deferred: true });
    const [a, b] = await Promise.allSettled([holds.issue(holdId, input, adminId, ADMIN_NAME), issue(c, newcomer)]);
    expect(b.status).toBe('fulfilled'); // o pedido novo é sempre tratado: emitido ou retido, nunca perdido
    // Se o pedido novo chegou primeiro, a confirmação ficou desatualizada e foi rejeitada; se a emissão excepcional veio primeiro, o novo pedido foi retido.
    const capacity = await capacityOf(c.id);
    const total = capacity.totals;
    expect(total.consumed).toBe(total.sold + total.pending);
    expect(capacity.globalRemaining).toBe(0);
    if (a.status === 'fulfilled') expect(await vouchersOf(order.id)).toHaveLength(4);
    else {
      expect(a.reason).toBeInstanceOf(ConflictException);
      await nothingIssued(order.id, holdId);
    }
    expect(benefitsOutcome((b as PromiseFulfilledResult<IssuanceOutcome>).value).issuedUnits).toBe(0); // sem folga, o novo pedido nunca foi emitido sozinho
  });

  test('a emissão dentro do novo teto registra limite e totais sem auditoria de excedente', async () => {
    const { c, holdId } = await heldScenario();
    await prisma.valePassCampaign.update({ where: { id: c.id }, data: { globalLimit: 6 } });
    await holds.issue(holdId, await confirm(holdId, 'Capacidade revisada e atualizada'), adminId, ADMIN_NAME);
    const audit = await prisma.adminAuditEvent.findFirstOrThrow({ where: { entityId: holdId, action: 'VALE_PASS_HOLD_ISSUED' } });
    expect(audit).toMatchObject({ adminUserId: adminId, isCritical: true });
    expect(audit.before).toMatchObject({ status: 'OPEN', units: 2, globalLimit: 6, sold: 4, pending: 2, consumed: 6 });
    expect(audit.after).toMatchObject({ status: 'ISSUED', issuedUnits: 2, vouchers: 4, sold: 6, pending: 0, consumed: 6, exceededBy: 0 });
    expect(audit.detail).toMatchObject({ note: 'Capacidade revisada e atualizada', override: true, exceedsLimit: false, confirmedTotal: 6 });
  });

  test('pedido retido não pode ser emitido acima do teto e continua visível; novas vendas também ficam retidas', async () => {
    const { c, holdId } = await heldScenario();
    await expect(holds.issue(holdId, await confirm(holdId, 'Justificativa suficientemente longa'), adminId, ADMIN_NAME)).rejects.toThrow(/excederia o teto configurado/);
    const after = await capacityOf(c.id);
    expect(after.totals).toMatchObject({ sold: 4, pending: 2, consumed: 6 });
    expect(after.globalRemaining).toBe(0);
    expect(after.recommendedShopifyStock).toBe(0);
    expect(after.holds.map((hold) => hold.id)).toContain(holdId);
    await expect(lots.create(c.id, { name: 'fictício', quantity: 1 }, adminId, ADMIN_NAME)).rejects.toBeInstanceOf(UnprocessableEntityException);
    // uma nova venda não encontra lugar: fica retida, não emitida
    const next = benefitsOutcome(await issue(c, await paidOrder(c, 1)));
    expect(next).toMatchObject({ issuedUnits: 0, heldUnits: 1 });
  });

  test('sem limite excedido (capacidade liberada depois): continua exigindo a mesma confirmação e o retrato diz que não excede', async () => {
    const { c, holdId } = await heldScenario();
    await prisma.valePassCampaign.update({ where: { id: c.id }, data: { globalLimit: 10 } });
    const p = await holds.preview(holdId);
    expect(p).toMatchObject({ exceedsLimit: false, exceededBy: 0, globalLimit: 10, capacityLimit: 10 });
    await expect(holds.issue(holdId, { ...(await confirm(holdId, 'Justificativa suficientemente longa')), confirmTotal: 1 }, adminId, ADMIN_NAME)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

localDescribe('Valle Pass 2027 — resgate, saldos por empresa, cancelamento e reembolso', () => {
  test('cada voucher tem saldo e status próprios: usar o da Valle Showroom não toca no da VS BY CLOSET; sem transferência entre empresas', async () => {
    const c = await newCampaign({ window: ['2026-01-01', '2027-12-31'] }); // validade já iniciada, para poder resgatar no teste
    const order = await paidOrder(c, 1);
    await issue(c, order);
    const [showroom, closet] = [(await vouchersOf(order.id)).find((v) => v.company === 'VALLE_SHOWROOM'), (await vouchersOf(order.id)).find((v) => v.company === 'VS_BY_CLOSET')];
    const used = await vouchers.markUsed(showroom!.code, adminId, ADMIN_NAME);
    expect(used).toMatchObject({ status: 'USED', company: 'VALLE_SHOWROOM', amountCents: 50_000 });
    const other = await prisma.valePass.findUniqueOrThrow({ where: { id: closet!.id } });
    expect(other).toMatchObject({ status: 'ACTIVE', amountCents: 5_000, company: 'VS_BY_CLOSET', usedAt: null });
    await expect(vouchers.markUsed(showroom!.code, adminId, ADMIN_NAME)).rejects.toThrow(/não pode ser utilizado/);
    // o valor nominal nunca vira saldo de outra empresa: soma separada, sem campo/serviço de transferência
    const list = await vouchers.list({ campaignId: c.id });
    expect(list.map((item) => [item.company, item.amountCents, item.groupId === showroom!.groupId]).sort()).toEqual([['VALLE_SHOWROOM', 50_000, true], ['VS_BY_CLOSET', 5_000, true]]);
    expect(list.find((item) => item.company === 'VALLE_SHOWROOM')?.benefitLabel).toBe('Voucher Valle Showroom');
    expect(Object.getOwnPropertyNames(ValePassVouchersService.prototype).filter((name) => /transfer/i.test(name))).toEqual([]);
  });

  test('o voucher só pode ser usado a partir do início da validade (2027); antes disso é recusado', async () => {
    const c = await newCampaign({ window: ['2099-01-01', '2099-12-31'] });
    const order = await paidOrder(c, 1);
    await issue(c, order);
    const [voucher] = await vouchersOf(order.id);
    await expect(vouchers.markUsed(voucher.code, adminId, ADMIN_NAME)).rejects.toThrow(/só pode ser utilizado a partir de/);
    expect((await prisma.valePass.findUniqueOrThrow({ where: { id: voucher.id } })).status).toBe('ACTIVE');
  });

  test('cancelar/reembolsar o pedido pela Shopify cancela OS DOIS vouchers e libera uma unidade; o admin ainda cancela/restaura um por vez', async () => {
    const c = await newCampaign({ globalLimit: 10 });
    const order = await paidOrder(c, 1);
    await issue(c, order);
    expect((await capacityOf(c.id)).totals.consumed).toBe(1);

    const webhook = new ValePassWebhookService();
    const events = await prisma.$transaction((tx) => webhook.handleOrderCancelledOrRefunded(tx, order.id, 'refunds/create'));
    expect(events.filter((event) => event.type === 'VALE_PASS_CANCELLED')).toHaveLength(2);
    expect((await vouchersOf(order.id)).map((row) => row.status)).toEqual(['CANCELLED', 'CANCELLED']);
    expect((await capacityOf(c.id)).totals).toMatchObject({ sold: 0, consumed: 0, cancelled: 1 }); // uma UNIDADE liberada, não duas
    // cancelados pela Shopify nunca são restaurados pelo painel
    const [first] = await vouchersOf(order.id);
    await expect(vouchers.restore(first.code, 'tentando', adminId, ADMIN_NAME)).rejects.toThrow(/cancelado automaticamente|cancelado ou reembolsado/);

    // cancelamento MANUAL de apenas um voucher: a unidade continua consumindo (o outro segue ativo)
    const other = await paidOrder(c, 1);
    await issue(c, other);
    const [a, b] = await vouchersOf(other.id);
    await vouchers.cancel(a.code, 'conferência', adminId, ADMIN_NAME);
    expect((await capacityOf(c.id)).totals).toMatchObject({ sold: 1, consumed: 1 });
    await vouchers.cancel(b.code, 'conferência', adminId, ADMIN_NAME);
    expect((await capacityOf(c.id)).totals).toMatchObject({ sold: 0, consumed: 0 }); // só quando TODOS os vouchers da unidade estão cancelados a capacidade é liberada
    const restored = await vouchers.restore(a.code, 'cancelado por engano', adminId, ADMIN_NAME);
    expect(restored).toMatchObject({ status: 'ACTIVE', company: a.company });
    expect((await capacityOf(c.id)).totals).toMatchObject({ sold: 1, consumed: 1 });
  });

  test('restauração da última linha cancelada de uma unidade respeita o teto e deixa o voucher cancelado', async () => {
    const c = await newCampaign({ globalLimit: 1 });
    const oldOrder = await paidOrder(c, 1);
    await issue(c, oldOrder);
    const [first, second] = await vouchersOf(oldOrder.id);
    await vouchers.cancel(first.code, 'cancelamento manual para teste', adminId, ADMIN_NAME);
    await vouchers.cancel(second.code, 'cancelamento manual para teste', adminId, ADMIN_NAME);
    expect((await capacityOf(c.id)).totals.consumed).toBe(0);

    const currentOrder = await paidOrder(c, 1);
    await issue(c, currentOrder);
    await expect(vouchers.restore(first.code, 'restauração acima do teto', adminId, ADMIN_NAME)).rejects.toThrow(/ultrapassaria o teto configurado/);
    expect((await prisma.valePass.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('CANCELLED');
    expect((await capacityOf(c.id)).totals).toMatchObject({ sold: 1, consumed: 1 });
    expect(await prisma.valePassEvent.count({ where: { valePassId: first.id, type: 'RESTORE_BLOCKED' } })).toBe(1);
  });

  test('vouchers LEGADOS continuam intactos e contam como 1 unidade cada, junto com os novos', async () => {
    const c = await newCampaign({ globalLimit: 100 });
    const legacy = await prisma.valePass.create({ data: { code: `${TAG}-legado`, campaignId: c.id, amountCents: 35_000, status: 'ACTIVE', purchasedAt: new Date('2026-09-14T12:00:00Z'), expiresAt: new Date('2026-10-14T12:00:00Z'), shopifyOrderId: `${TAG}-legacy-order` } });
    await issue(c, await paidOrder(c, 2));
    const after = await prisma.valePass.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(after).toEqual(legacy); // nenhum campo do voucher antigo mudou
    expect(after).toMatchObject({ company: null, groupId: null, benefitId: null, validFrom: null });
    expect((await capacityOf(c.id)).totals).toMatchObject({ issued: 3, sold: 3, consumed: 3 }); // 1 legado + 2 unidades novas (4 vouchers)
    expect(await prisma.valePass.count({ where: { campaignId: c.id } })).toBe(5);
  });
});

localDescribe('Valle Pass 2027 — imutabilidade e benefícios', () => {
  test('o que define o voucher emitido (código, valor, empresa, grupo, benefício, pedido, datas) não muda; status e uso seguem livres', async () => {
    const c = await newCampaign();
    const order = await paidOrder(c, 1);
    await issue(c, order);
    const [v] = await vouchersOf(order.id);
    const [other] = await prisma.valePassCampaignBenefit.findMany({ where: { campaignId: c.id, company: { not: v.company } } });
    for (const data of [
      { amountCents: v.amountCents + 1 },
      { code: `${TAG}-troca` },
      { company: v.company === 'VALLE_SHOWROOM' ? ('VS_BY_CLOSET' as const) : ('VALLE_SHOWROOM' as const) },
      { benefitId: other.id },
      { groupId: '33333333-3333-4333-8333-333333333333' },
      { shopifyOrderId: `${TAG}-outro` },
      { expiresAt: new Date('2099-01-01') },
      { validFrom: new Date('2026-01-01') },
      { purchasedAt: new Date('2020-01-01') },
      { campaignId: (await newCampaign()).id },
    ]) {
      await expect(prisma.valePass.update({ where: { id: v.id }, data }), JSON.stringify(Object.keys(data))).rejects.toThrow(/vale_pass_immutable|23514/);
    }
    // o que continua livre: cancelamento. "Usado" só pelo livro-razão (saldo zero); UPDATE direto é recusado; saldo não muda por UPDATE.
    await expect(prisma.valePass.update({ where: { id: v.id }, data: { status: 'USED', usedAt: new Date() } })).rejects.toThrow(/vale_pass_used_requires_zero_balance/);
    await expect(prisma.valePass.update({ where: { id: v.id }, data: { balanceCents: 0 } })).rejects.toThrow(/vale_pass_balance_direct_update/);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica'); // início de uso em 2027: recuado só neste voucher para exercitar o resgate
      await tx.$executeRaw`UPDATE vale_passes SET valid_from = now() - interval '1 day' WHERE id = ${v.id}::uuid`;
    });
    await prisma.valePassLedgerEntry.create({ data: { valePassId: v.id, seq: 1, balanceAfterCents: 0, kind: 'REDEEM', deltaCents: -v.amountCents, reference: 'teste', idempotencyKey: `all-${v.id}` } });
    expect((await prisma.valePass.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('USED');
  });

  test('voucher LEGADO também é protegido contra mudança de valor e datas', async () => {
    const c = await newCampaign({ withBenefits: false });
    const legacy = await prisma.valePass.create({ data: { code: `${TAG}-leg2`, campaignId: c.id, amountCents: 35_000, purchasedAt: new Date('2026-09-14T12:00:00Z'), expiresAt: new Date('2026-10-14T12:00:00Z') } });
    await expect(prisma.valePass.update({ where: { id: legacy.id }, data: { amountCents: 50_000 } })).rejects.toThrow(/vale_pass_immutable|23514/);
    await expect(prisma.valePass.update({ where: { id: legacy.id }, data: { expiresAt: new Date('2027-12-31') } })).rejects.toThrow(/vale_pass_immutable|23514/);
    await prisma.valePass.update({ where: { id: legacy.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'teste' } });
  });

  test('benefício já usado por vouchers: empresa e valor imutáveis (serviço e banco); rótulo e condições seguem editáveis; o percentual trava após a primeira emissão', async () => {
    const c = await newCampaign({ globalLimit: 10 });
    const [showroom] = await prisma.valePassCampaignBenefit.findMany({ where: { campaignId: c.id, company: 'VALLE_SHOWROOM' } });
    const [discount] = await prisma.valePassCampaignBenefit.findMany({ where: { campaignId: c.id, kind: 'DISCOUNT' } });
    // antes de emitir tudo é editável
    await prisma.valePassCampaignBenefit.update({ where: { id: showroom.id }, data: { amountCents: 51_000 } });
    await prisma.valePassCampaignBenefit.update({ where: { id: showroom.id }, data: { amountCents: 50_000 } });
    await prisma.valePassCampaignBenefit.update({ where: { id: discount.id }, data: { discountPercent: 15 } });
    await prisma.valePassCampaignBenefit.update({ where: { id: discount.id }, data: { discountPercent: 10 } });

    await issue(c, await paidOrder(c, 1));
    await expect(prisma.valePassCampaignBenefit.update({ where: { id: showroom.id }, data: { amountCents: 60_000 } })).rejects.toThrow(/vale_pass_benefit_immutable/);
    await expect(prisma.valePassCampaignBenefit.update({ where: { id: showroom.id }, data: { company: 'VS_BY_CLOSET' } })).rejects.toThrow(/vale_pass_benefit_immutable|Unique/);
    await expect(prisma.valePassCampaignBenefit.update({ where: { id: discount.id }, data: { discountPercent: 20 } })).rejects.toThrow(/vale_pass_benefit_immutable/);
    await expect(prisma.valePassCampaignBenefit.update({ where: { id: showroom.id }, data: { code: 'outro_codigo' } })).rejects.toThrow(/vale_pass_benefit_immutable/);
    await prisma.valePassCampaignBenefit.update({ where: { id: showroom.id }, data: { label: 'Voucher Valle Showroom 2027', terms: 'Condições a definir' } });
    await expect(prisma.valePassCampaignBenefit.delete({ where: { id: showroom.id } })).rejects.toThrow(/Foreign key|constraint/i);
  });

  test('configuração de benefícios pelo serviço: validações, auditoria, itens que saem ficam inativos, valor travado depois de usado', async () => {
    const c = await newCampaign({ withBenefits: false });
    const item = (over: Record<string, unknown>) => ({ code: 'valle_showroom_500', kind: 'VOUCHER' as const, company: 'VALLE_SHOWROOM' as const, label: 'Voucher Valle Showroom', amountCents: 50_000, ...over });
    const closet = { code: 'vs_by_closet_50', kind: 'VOUCHER' as const, company: 'VS_BY_CLOSET' as const, label: 'Voucher VS BY CLOSET', amountCents: 5_000 };
    const discount = { code: 'desconto_passeios', kind: 'DISCOUNT' as const, label: '10% em passeios', discountPercent: 10, terms: 'Condições a definir' };

    await expect(benefits.replace(c.id, [item({}), item({ code: 'outro_codigo' })], adminId, ADMIN_NAME)).rejects.toThrow(/um por empresa/);
    await expect(benefits.replace(c.id, [item({ amountCents: 0 })], adminId, ADMIN_NAME)).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(benefits.replace(c.id, [discount, { ...discount, code: 'd2', company: 'VS_BY_CLOSET' }], adminId, ADMIN_NAME)).rejects.toThrow(/não pertence a uma empresa/);

    const saved = await benefits.replace(c.id, [item({}), closet, discount], adminId, ADMIN_NAME);
    expect(saved.map((b) => [b.code, b.kind, b.company, b.amountCents, b.discountPercent, b.active])).toEqual([
      ['valle_showroom_500', 'VOUCHER', 'VALLE_SHOWROOM', 50_000, null, true],
      ['vs_by_closet_50', 'VOUCHER', 'VS_BY_CLOSET', 5_000, null, true],
      ['desconto_passeios', 'DISCOUNT', null, null, 10, true],
    ]);
    const audit = await prisma.adminAuditEvent.findMany({ where: { entityId: c.id, action: 'VALE_PASS_BENEFITS_UPDATED' } });
    expect(audit).toHaveLength(1);
    expect(audit[0].isCritical).toBe(true);

    // antes de emitir, o valor muda; depois de emitir, não
    expect((await benefits.replace(c.id, [item({ amountCents: 52_000 }), closet, discount], adminId, ADMIN_NAME))[0].amountCents).toBe(52_000);
    await benefits.replace(c.id, [item({}), closet, discount], adminId, ADMIN_NAME);
    await issue(c, await paidOrder(c, 1));
    await expect(benefits.replace(c.id, [item({ amountCents: 60_000 }), closet, discount], adminId, ADMIN_NAME)).rejects.toThrow(/já gerou 1 voucher/);
    // sair da lista não apaga: fica inativo
    const reduced = await benefits.replace(c.id, [item({}), closet], adminId, ADMIN_NAME);
    expect(reduced.find((b) => b.code === 'desconto_passeios')?.active).toBe(false);
    expect(reduced.find((b) => b.code === 'valle_showroom_500')?.vouchersIssued).toBe(1);
    await expect(benefits.replace('00000000-0000-4000-8000-000000000000', [item({})], adminId, ADMIN_NAME)).rejects.toThrow(/não encontrada/);
  });
});

localDescribe('Valle Pass 2027 — isolamento: a emissão ativa do webhook NÃO mudou', () => {
  test('o webhook só DELEGA ao fluxo de pagamento (atrás da chave desligada): não emite, não retém e não enfileira por conta própria', () => {
    const webhook = readFileSync(join(__dirname, 'vale-pass-webhook.service.ts'), 'utf8');
    for (const name of ['issueForCampaign', 'holdForFinancialReview', 'enqueueForOrder', 'ValePassIssuanceService', 'valePassIssuanceHold', 'validFrom', 'ValePassEmail', 'Resend']) {
      expect(webhook, name).not.toContain(name);
    }
    expect(webhook).toContain('ValePassPaymentFlowService');
    const webhooksService = readFileSync(join(__dirname, '..', 'webhooks', 'webhooks.service.ts'), 'utf8');
    expect(webhooksService).not.toContain('vale-pass-issuance');
  });

  test('o serviço de emissão não é importado por nenhum arquivo de produção além do módulo e da resolução da fila', () => {
    const root = join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && readFileSync(full, 'utf8').includes('vale-pass-issuance.service')) offenders.push(full.slice(root.length + 1).split('\\').join('/'));
      }
    };
    walk(root);
    expect(offenders.sort()).toEqual(['vale-pass/flow/payment-flow.service.ts', 'vale-pass/refunds/regularization.service.ts', 'vale-pass/vale-pass-holds.service.ts', 'vale-pass/vale-pass-issuance.service.ts', 'vale-pass/vale-pass.module.ts'].sort().filter((file) => file !== 'vale-pass/vale-pass-issuance.service.ts'));
  });
});
