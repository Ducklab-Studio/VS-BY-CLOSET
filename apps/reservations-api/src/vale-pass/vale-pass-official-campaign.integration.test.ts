import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { ValePassCampaign } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { lockShopifyOrder } from '../webhooks/shopify-order-lock';
import { purgeLedgerForTest } from './ledger/ledger-test-utils';
import { ValePassIssuanceService, type IssuanceOutcome } from './vale-pass-issuance.service';
import { ValePassLotsService } from './vale-pass-lots.service';
import { evaluateLaunchReadiness } from './vale-pass-launch-readiness';

/**
 * Campanha OFICIAL do Valle Pass 2027 (1.000 unidades, R$ 350 = R$ 500 Valle Showroom + R$ 50 VS BY CLOSET + 10% descritivo, validade até
 * 30/09/2027) em PostgreSQL LOCAL descartável. A data de INÍCIO da validade ainda não foi definida pelo Anderson: aqui usa-se um valor
 * SINTÉTICO só para o teste (nunca é configuração de produção). Nenhuma Shopify, nenhum e-mail, nenhum pagamento.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const issuance = new ValePassIssuanceService();
const lots = new ValePassLotsService(prisma);

const TAG = `VPO-${Date.now()}`;
const SYNTHETIC_VALID_FROM = '2027-01-01'; // SINTÉTICO — a data real de início é pendência do Anderson
let counter = 0;
let storeId: string;
let adminId: string;
const createdCampaigns: string[] = [];
const orderIds: string[] = [];

async function officialCampaign(): Promise<ValePassCampaign> {
  const campaign = await prisma.valePassCampaign.create({
    data: {
      name: `${TAG}-oficial`,
      amountCents: 35_000,
      validityDays: 30,
      quantityLimit: null,
      globalLimit: 1_000,
      voucherValidFrom: new Date(`${SYNTHETIC_VALID_FROM}T00:00:00.000Z`),
      voucherValidUntil: new Date('2027-09-30T00:00:00.000Z'),
      shopifyVariantId: `${TAG}-var-${counter++}`,
    },
  });
  createdCampaigns.push(campaign.id);
  await prisma.valePassCampaignBenefit.createMany({
    data: [
      { campaignId: campaign.id, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 },
      { campaignId: campaign.id, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 },
      { campaignId: campaign.id, code: 'passeios_10', kind: 'DISCOUNT', label: '10% em passeios e transfers Valle Experience', discountPercent: 10, sortOrder: 2 },
    ],
  });
  return campaign;
}

/** Pedido pago cuja linha só nasce dentro da transação de emissão (como o webhook real). */
const deferred = new Map<string, Parameters<typeof prisma.valePassOrder.create>[0]['data']>();
function paidOrder(campaign: ValePassCampaign, quantity: number): { id: string; quantity: number } {
  const id = `${TAG}-o${counter++}`;
  orderIds.push(id);
  deferred.set(id, {
    shopifyOrderId: id,
    shopifyOrderGid: `gid://shopify/Order/${id}`,
    shopifyOrderName: `${TAG}#${counter}`,
    status: 'CONFIRMED',
    financialStatus: 'paid',
    quantity,
    customerName: 'Cliente Sintético',
    customerEmail: `cliente-${counter}@exemplo.invalid`,
    customerPhone: '+5500000000000',
    lastSyncSource: 'teste',
    orderCreatedAt: new Date(Date.now() - 3_600_000),
    statusChangedAt: new Date(Date.now() - 3_600_000),
    vouchersProcessedAt: new Date(),
  });
  void campaign;
  return { id, quantity };
}

function issue(campaign: ValePassCampaign, order: { id: string; quantity: number }): Promise<IssuanceOutcome> {
  return prisma.$transaction(
    async (tx) => {
      await lockShopifyOrder(tx, order.id);
      const data = deferred.get(order.id)!;
      if (!(await tx.valePassOrder.findUnique({ where: { shopifyOrderId: order.id } }))) await tx.valePassOrder.create({ data });
      const row = await tx.valePassOrder.findUniqueOrThrow({ where: { shopifyOrderId: order.id } });
      return issuance.issueForCampaign(tx, {
        campaignId: campaign.id,
        order: { orderId: row.shopifyOrderId, orderGid: row.shopifyOrderGid, orderName: row.shopifyOrderName, customerName: row.customerName, customerPhone: row.customerPhone, customerEmail: row.customerEmail },
        units: order.quantity,
        mode: 'enforce',
      });
    },
    { timeout: 60_000, maxWait: 30_000 },
  );
}

const outcomeOf = (o: IssuanceOutcome) => {
  if (o.mode !== 'benefits') throw new Error('esperava o modelo de vários vouchers');
  return o;
};

/** Preenche a campanha com `units` unidades já vendidas (2 vouchers cada), direto no banco: o que importa é o consumo de capacidade. */
async function preSold(campaign: ValePassCampaign, units: number): Promise<void> {
  const benefits = await prisma.valePassCampaignBenefit.findMany({ where: { campaignId: campaign.id, kind: 'VOUCHER' } });
  const showroom = benefits.find((b) => b.company === 'VALLE_SHOWROOM')!;
  const closet = benefits.find((b) => b.company === 'VS_BY_CLOSET')!;
  const rows = [];
  for (let i = 0; i < units; i++) {
    const groupId = randomUUID();
    for (const [benefit, suffix] of [[showroom, 'A'], [closet, 'B']] as const) {
      rows.push({
        code: `VALLE-${TAG.slice(-4)}-${String(counter++).padStart(6, '0')}${suffix}`.slice(0, 40),
        campaignId: campaign.id,
        amountCents: benefit.amountCents!,
        status: 'ACTIVE' as const,
        purchasedAt: new Date(),
        validFrom: new Date('2027-01-01T03:00:00.000Z'),
        expiresAt: new Date('2027-10-01T03:00:00.000Z'),
        company: benefit.company!,
        groupId,
        benefitId: benefit.id,
        customerName: 'Pré-vendido Sintético',
        customerPhone: '+5500000000000',
        shopifyOrderId: `${TAG}-pre-${i}`,
      });
    }
  }
  for (let i = 0; i < rows.length; i += 500) await prisma.valePass.createMany({ data: rows.slice(i, i + 500) });
}

beforeAll(async () => {
  if (!localDatabase) return;
  adminId = (await prisma.adminUser.create({ data: { name: `Admin ${TAG}`, phone: `${TAG}-admin`, pinHash: 'x', role: 'ADMIN', active: true } })).id;
  storeId = `${TAG}-store`;
  await prisma.$executeRaw`INSERT INTO stores (id, shopify_domain, currency) VALUES (${storeId}, ${storeId + '.invalid'}, 'BRL')`;
});

afterEach(async () => {
  if (!localDatabase) return;
  await prisma.valePassOrder.deleteMany({ where: { shopifyOrderId: { in: orderIds } } });
  orderIds.length = 0;
});

afterAll(async () => {
  if (localDatabase) {
    const voucherRows = await prisma.valePass.findMany({ where: { campaignId: { in: createdCampaigns } }, select: { id: true } });
    await prisma.valePassEvent.deleteMany({ where: { valePassId: { in: voucherRows.map((v) => v.id) } } });
    await prisma.$transaction((tx) => purgeLedgerForTest(tx, { campaignIds: createdCampaigns }), { timeout: 120_000 });
    await prisma.valePass.deleteMany({ where: { campaignId: { in: createdCampaigns } } });
    await prisma.valePassIssuanceHold.deleteMany({ where: { campaignId: { in: createdCampaigns } } });
    await prisma.adminAuditEvent.deleteMany({ where: { OR: [{ entityId: { in: createdCampaigns } }, { adminUserId: adminId }] } });
    await prisma.valePassLot.deleteMany({ where: { campaignId: { in: createdCampaigns } } });
    await prisma.valePassCampaignBenefit.deleteMany({ where: { campaignId: { in: createdCampaigns } } });
    await prisma.valePassCampaign.deleteMany({ where: { id: { in: createdCampaigns } } });
    await prisma.$executeRaw`DELETE FROM stores WHERE id = ${storeId}`;
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
  }
  await prisma.$disconnect();
});

localDescribe('Valle Pass 2027 — campanha oficial de 1.000 unidades', () => {
  test('a configuração oficial passa na checagem de prontidão (só a prorrogação segue pendente)', async () => {
    const c = await officialCampaign();
    const benefits = await prisma.valePassCampaignBenefit.findMany({ where: { campaignId: c.id } });
    const items = evaluateLaunchReadiness({
      campaign: { amountCents: c.amountCents, active: c.active, quantityLimit: c.quantityLimit, globalLimit: c.globalLimit, voucherValidFrom: SYNTHETIC_VALID_FROM, voucherValidUntil: '2027-09-30', salesEndDate: '2027-05-31' },
      benefits: benefits.map((b) => ({ kind: b.kind, company: b.company, amountCents: b.amountCents, discountPercent: b.discountPercent, terms: 'x', active: b.active })),
      shopifyStock: 1_000,
      hasOpenLot: true,
    });
    expect(items.filter((i) => i.kind !== 'OK').map((i) => i.id)).toEqual(['extension', 'sales-start']);
  });

  test('cada unidade gera DOIS vouchers independentes, com a validade até 30/09/2027 (fim às 00:00 de 01/10 no fuso configurado)', async () => {
    const c = await officialCampaign();
    const order = paidOrder(c, 2);
    const outcome = outcomeOf(await issue(c, order));
    expect(outcome).toMatchObject({ issuedUnits: 2, heldUnits: 0, vouchersCreated: 4 });
    const rows = await prisma.valePass.findMany({ where: { shopifyOrderId: order.id } });
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.company === 'VALLE_SHOWROOM').every((r) => r.amountCents === 50_000)).toBe(true);
    expect(rows.filter((r) => r.company === 'VS_BY_CLOSET').every((r) => r.amountCents === 5_000)).toBe(true);
    expect(new Set(rows.map((r) => r.code)).size).toBe(4);
    for (const r of rows) {
      expect(r.expiresAt.toISOString()).toBe('2027-10-01T03:00:00.000Z'); // 30/09/2027 inclusive, America/Sao_Paulo (UTC−3)
      expect(r.balanceCents).toBe(r.amountCents); // saldo próprio por voucher
    }
    const byGroup = new Map<string, string[]>();
    for (const r of rows) byGroup.set(r.groupId!, [...(byGroup.get(r.groupId!) ?? []), r.company!]);
    expect([...byGroup.values()].every((companies) => companies.sort().join() === 'VALLE_SHOWROOM,VS_BY_CLOSET')).toBe(true);
  }, 60_000);

  test('idempotência: reprocessar o mesmo pedido não cria nada além das duas unidades', async () => {
    const c = await officialCampaign();
    const order = paidOrder(c, 2);
    await issue(c, order);
    const again = outcomeOf(await issue(c, order));
    expect(again).toMatchObject({ issuedUnits: 0, vouchersCreated: 0 });
    expect(await prisma.valePass.count({ where: { campaignId: c.id } })).toBe(4);
  }, 60_000);

  test('campanha com benefícios e sem nenhum teto falha fechada; reprocessamentos e pedidos concorrentes mantêm uma retenção por pedido e nenhum voucher', async () => {
    const c = await officialCampaign();
    await prisma.valePassCampaign.update({ where: { id: c.id }, data: { globalLimit: null, quantityLimit: null } });
    const replayedOrder = paidOrder(c, 1);
    const replayed = await Promise.all([issue(c, replayedOrder), issue(c, replayedOrder), issue(c, replayedOrder)]);
    for (const result of replayed) expect(outcomeOf(result)).toMatchObject({ issuedUnits: 0, heldUnits: 1, vouchersCreated: 0 });

    const simultaneous = Array.from({ length: 8 }, () => paidOrder(c, 1));
    const results = await Promise.all(simultaneous.map((order) => issue(c, order)));
    for (const result of results) expect(outcomeOf(result)).toMatchObject({ issuedUnits: 0, heldUnits: 1, vouchersCreated: 0 });

    expect(await prisma.valePass.count({ where: { campaignId: c.id } })).toBe(0);
    const holds = await prisma.valePassIssuanceHold.findMany({ where: { campaignId: c.id, status: 'OPEN' } });
    expect(holds).toHaveLength(9);
    expect(new Set(holds.map((hold) => hold.shopifyOrderId)).size).toBe(9);
  }, 120_000);

  test('limite de 1.000: com 998 unidades vendidas, pedido de 3 é retido INTEIRO, um de 2 emite, e o seguinte (1) é retido; vendido = 1.000, nunca mais', async () => {
    const c = await officialCampaign();
    await preSold(c, 998);
    expect((await lots.getCapacity(c.id)).totals).toMatchObject({ sold: 998, consumed: 998 });

    const three = outcomeOf(await issue(c, paidOrder(c, 3)));
    expect(three).toMatchObject({ issuedUnits: 0, heldUnits: 3, vouchersCreated: 0 }); // tudo ou nada
    expect(await prisma.valePass.count({ where: { campaignId: c.id } })).toBe(998 * 2);

    // A retenção de 3 continua consumindo capacidade (por segurança): o saldo é 0 até alguém resolver.
    const afterHold = await lots.getCapacity(c.id);
    expect(afterHold.totals).toMatchObject({ sold: 998, pending: 3, consumed: 1001 });
    const two = outcomeOf(await issue(c, paidOrder(c, 2)));
    expect(two.issuedUnits).toBe(0);
    expect((await lots.getCapacity(c.id)).totals.sold).toBe(998);
  }, 120_000);

  test('limite de 1.000: pedido de 2 com exatamente 2 de saldo emite; depois o 1.001º é retido', async () => {
    const c = await officialCampaign();
    await preSold(c, 998);
    const two = outcomeOf(await issue(c, paidOrder(c, 2)));
    expect(two).toMatchObject({ issuedUnits: 2, heldUnits: 0 });
    expect((await lots.getCapacity(c.id)).totals).toMatchObject({ sold: 1000, consumed: 1000 });
    const extra = outcomeOf(await issue(c, paidOrder(c, 1)));
    expect(extra).toMatchObject({ issuedUnits: 0, heldUnits: 1 });
    expect(await prisma.valePass.count({ where: { campaignId: c.id, status: { not: 'CANCELLED' } } })).toBe(2000);
  }, 120_000);

  test('concorrência no fim do estoque: 8 pedidos simultâneos para 5 unidades restantes → exatamente 5 emitidos, 3 retidos, total 1.000', async () => {
    const c = await officialCampaign();
    await preSold(c, 995);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => issue(c, paidOrder(c, 1))));
    expect(outcomes.filter((o) => outcomeOf(o).issuedUnits === 1)).toHaveLength(5);
    expect(outcomes.filter((o) => outcomeOf(o).heldUnits === 1)).toHaveLength(3);
    expect((await lots.getCapacity(c.id)).totals.sold).toBe(1000);
    const groups = await prisma.valePass.groupBy({ by: ['groupId'], where: { campaignId: c.id } });
    expect(groups).toHaveLength(1000);
  }, 180_000);

  test('sem a data de início da validade a emissão NÃO acontece: o pedido pago fica retido (CAMPAIGN_NOT_READY) e nenhum voucher nasce', async () => {
    const c = await officialCampaign();
    await prisma.valePassCampaign.update({ where: { id: c.id }, data: { voucherValidFrom: null, voucherValidUntil: null } });
    const held = outcomeOf(await issue(c, paidOrder(c, 1)));
    expect(held).toMatchObject({ issuedUnits: 0, heldUnits: 1, vouchersCreated: 0 });
    expect(await prisma.valePass.count({ where: { campaignId: c.id } })).toBe(0);
    expect(await prisma.valePassIssuanceHold.count({ where: { campaignId: c.id, status: 'OPEN', reason: 'CAMPAIGN_NOT_READY' } })).toBe(1);
  }, 60_000);

  test('lotes dentro do limite global: um lote que NÃO cabe no saldo global nem chega a ser cadastrado (quantidades dos lotes são decisão do Anderson; o sistema nunca as inventa)', async () => {
    const c = await officialCampaign();
    await preSold(c, 998);
    // o próprio cadastro do lote recusa quantidade que não cabe no saldo global
    await expect(lots.create(c.id, { name: 'Lote grande (teste)', quantity: 5 }, adminId, 'Admin')).rejects.toThrow(/não cabe no saldo do limite global/);
    expect((await lots.getCapacity(c.id)).lots).toHaveLength(0);
    const fits = await lots.create(c.id, { name: 'Lote que cabe (teste)', quantity: 2 }, adminId, 'Admin');
    const opened = await lots.open(c.id, fits.id, fits.updatedAt, adminId, 'Admin');
    expect(opened).toMatchObject({ status: 'OPEN', quantity: 2 });
    const capacity = await lots.getCapacity(c.id);
    expect(capacity.globalRemaining).toBe(2);
    expect(capacity.recommendedShopifyStock).toBe(2); // o estoque recomendado nunca passa do saldo global
    // sem lote aberto o estoque recomendado é 0 (venda fechada)
    await lots.close(c.id, fits.id, opened.updatedAt, adminId, 'Admin');
    expect((await lots.getCapacity(c.id)).recommendedShopifyStock).toBe(0);
  }, 120_000);

  test('campanha desativada: pedido JÁ PAGO continua emitindo os dois vouchers (quem pagou não perde); fechar a venda nova é papel do estoque da Shopify, não da emissão', async () => {
    const c = await officialCampaign();
    await prisma.valePassCampaign.update({ where: { id: c.id }, data: { active: false } });
    const outcome = outcomeOf(await issue(c, paidOrder(c, 1)));
    expect(outcome).toMatchObject({ issuedUnits: 1, heldUnits: 0, vouchersCreated: 2 });
  }, 60_000);

  test('sem benefícios o modelo novo não é usado: uma campanha só com o preço (sem os dois vouchers) NÃO emite pelo fluxo oficial', async () => {
    const campaign = await prisma.valePassCampaign.create({
      data: { name: `${TAG}-sem-beneficios`, amountCents: 35_000, validityDays: 30, voucherValidFrom: new Date('2027-01-01'), voucherValidUntil: new Date('2027-09-30'), shopifyVariantId: `${TAG}-var-${counter++}` },
    });
    createdCampaigns.push(campaign.id);
    const outcome = await issue(campaign, paidOrder(campaign, 1));
    expect(outcome.mode).toBe('legacy'); // o serviço do modelo novo não emite nada para esta campanha
    expect(await prisma.valePass.count({ where: { campaignId: campaign.id } })).toBe(0);
  }, 60_000);
});
