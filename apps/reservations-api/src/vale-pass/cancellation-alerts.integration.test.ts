import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { ValePass } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REQUIRE_MODULE_KEY } from '../admin/require-module.decorator';
import { REQUIRE_ROLE_KEY } from '../admin/require-role.decorator';
import { lockShopifyOrder } from '../webhooks/shopify-order-lock';
import { WebhooksService } from '../webhooks/webhooks.service';
import { ShopifyOrderSyncService } from '../webhooks/shopify-order-sync.service';
import type { ShopifyOrderPayload } from '../webhooks/shopify-order-payload';
import { purgeLedgerForTest } from './ledger/ledger-test-utils';
import { ValePassLedgerService } from './ledger/ledger.service';
import { ValePassRedemptionService, type Actor } from './ledger/redemption.service';
import { ValePassLotsService } from './vale-pass-lots.service';
import { ValePassVouchersService } from './vale-pass-vouchers.service';
import { ValePassWebhookService } from './vale-pass-webhook.service';
import { ValePassCancellationAlertsController } from './cancellation-alerts.controller';
import { ValePassCancellationAlertsService } from './cancellation-alerts.service';
import { summarizeUsedCredit } from './cancellation-alerts';

/**
 * Alerta administrativo de pedido cancelado/reembolsado com crédito JÁ utilizado, em PostgreSQL LOCAL descartável. O alerta só INFORMA: saldos, vouchers e reembolsos
 * não são tocados. Dados sintéticos; nenhuma Shopify real, nenhum reembolso, nenhum e-mail.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const redemption = new ValePassRedemptionService(prisma);
const ledger = new ValePassLedgerService(prisma);
const webhook = new ValePassWebhookService();
const alerts = new ValePassCancellationAlertsService(prisma);
const lots = new ValePassLotsService(prisma);
const vouchersService = new ValePassVouchersService(prisma);
const TAG = `VPCA-${Date.now()}`;
let counter = 0;
let admin: Actor;
let staffId: string;
const campaignIds: string[] = [];
const orderIds: string[] = [];
const REF = 'Nota 700 (teste)';

async function newUnit(): Promise<{ campaignId: string; showroom: ValePass; closet: ValePass; orderId: string }> {
  const campaign = await prisma.valePassCampaign.create({
    data: { name: `${TAG}-camp-${counter++}`, amountCents: 35_000, validityDays: 30, shopifyVariantId: `${TAG}-var-${counter++}`, voucherValidFrom: new Date('2026-01-01'), voucherValidUntil: new Date('2027-09-30') },
  });
  campaignIds.push(campaign.id);
  const [b1, b2] = await Promise.all([
    prisma.valePassCampaignBenefit.create({ data: { campaignId: campaign.id, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 } }),
    prisma.valePassCampaignBenefit.create({ data: { campaignId: campaign.id, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 } }),
  ]);
  const orderId = `${TAG}-o${counter++}`;
  orderIds.push(orderId);
  await prisma.valePassOrder.create({
    data: { shopifyOrderId: orderId, shopifyOrderGid: `gid://shopify/Order/${orderId}`, shopifyOrderName: `#T${5000 + counter}`, status: 'CONFIRMED', financialStatus: 'paid', quantity: 1, customerName: 'Maria da Silva Souza', customerEmail: 'maria.souza@exemplo.invalid', customerPhone: '+5511912345678', lastSyncSource: 'teste', orderCreatedAt: new Date(), statusChangedAt: new Date() },
  });
  const common = { campaignId: campaign.id, groupId: randomUUID(), shopifyOrderId: orderId, shopifyOrderName: '#T-VOUCHER', status: 'ACTIVE' as const, purchasedAt: new Date(), expiresAt: new Date('2027-10-01T03:00:00Z'), validFrom: new Date('2026-01-01T03:00:00Z'), customerName: 'Maria da Silva Souza', customerPhone: '+5511912345678', customerEmail: 'maria.souza@exemplo.invalid' };
  const showroom = await prisma.valePass.create({ data: { ...common, code: `VALLE-${TAG.slice(-4)}-A${counter++}`.toUpperCase(), amountCents: 50_000, company: 'VALLE_SHOWROOM', benefitId: b1.id } });
  const closet = await prisma.valePass.create({ data: { ...common, code: `VALLE-${TAG.slice(-4)}-B${counter++}`.toUpperCase(), amountCents: 5_000, company: 'VS_BY_CLOSET', benefitId: b2.id } });
  return { campaignId: campaign.id, showroom, closet, orderId };
}

const row = (id: string) => prisma.valePass.findUniqueOrThrow({ where: { id } });

async function redeem(v: ValePass, amountCents: number) {
  return redemption.confirmRedeem(v.code, { company: v.company as string, amountCents, reference: REF, operationId: `op-${randomUUID()}`, expectedBalanceCents: (await row(v.id)).balanceCents, confirmAmountCents: amountCents }, admin);
}
/** O que o WebhooksService faz: lock do pedido + tratamento do cancelamento, na mesma transação. */
const cancelOrder = (orderId: string, topic = 'refunds/create') => prisma.$transaction(async (tx) => { await lockShopifyOrder(tx, orderId); return webhook.handleOrderCancelledOrRefunded(tx, orderId, topic); });
const alertsOf = (orderId: string) => prisma.valePassCancellationAlert.findMany({ where: { shopifyOrderId: orderId } });
const auditOf = (orderId: string, action: string) => prisma.adminAuditEvent.findMany({ where: { action, entityId: orderId } });

async function cleanRows() {
  const ids = campaignIds.splice(0);
  const orders = orderIds.splice(0);
  await prisma.$transaction(async (tx) => {
    const rows = await tx.valePass.findMany({ where: { campaignId: { in: ids } }, select: { id: true } });
    await purgeLedgerForTest(tx, { campaignIds: ids });
    await tx.valePassEvent.deleteMany({ where: { valePassId: { in: rows.map((r) => r.id) } } });
    await tx.adminAuditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...rows.map((r) => r.id), ...orders] } }, { adminUserId: { in: [admin?.id, staffId].filter(Boolean) as string[] } }] } });
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica'); // só a limpeza dos dados SINTÉTICOS (alertas são imutáveis por gatilho)
    await tx.$executeRaw`DELETE FROM vale_pass_cancellation_alerts WHERE shopify_order_id = ANY(${orders}::text[])`;
    await tx.valePassOrderCancellation.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.valePassOrder.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.valePass.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaignBenefit.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaign.deleteMany({ where: { id: { in: ids } } });
  });
}
beforeAll(async () => {
  if (!localDatabase) return;
  const user = await prisma.adminUser.create({ data: { name: 'Admin Teste Alerta', phone: `${TAG}-admin`, pinHash: 'x', role: 'ADMIN', active: true } });
  admin = { id: user.id, name: user.name, role: 'ADMIN' };
  staffId = (await prisma.adminUser.create({ data: { name: 'Staff Teste Alerta', phone: `${TAG}-staff`, pinHash: 'x', role: 'STAFF', active: true } })).id;
});
afterEach(async () => {
  if (localDatabase) await cleanRows();
});
afterAll(async () => {
  if (localDatabase) {
    await cleanRows();
    await prisma.adminUser.deleteMany({ where: { id: { in: [admin.id, staffId] } } });
  }
  await prisma.$disconnect();
});

describe('cálculo do crédito utilizado (puro)', () => {
  test('saldo: valor − saldo por empresa; legado USADO conta por inteiro; sem uso = sem alerta', () => {
    expect(summarizeUsedCredit([{ company: 'VALLE_SHOWROOM', status: 'ACTIVE', amountCents: 50_000, balanceCents: 30_000 }, { company: 'VS_BY_CLOSET', status: 'ACTIVE', amountCents: 5_000, balanceCents: 5_000 }])).toMatchObject({
      usedCents: 20_000,
      detail: { vouchersWithUse: 1, lines: [{ company: 'VALLE_SHOWROOM', usedCents: 20_000, balanceCents: 30_000 }, { company: 'VS_BY_CLOSET', usedCents: 0, balanceCents: 5_000 }] },
    });
    expect(summarizeUsedCredit([{ company: null, status: 'USED', amountCents: 35_000, balanceCents: 35_000 }])).toMatchObject({ usedCents: 35_000, detail: { lines: [{ company: 'LEGACY', usedCents: 35_000, balanceCents: 0 }] } });
    expect(summarizeUsedCredit([{ company: null, status: 'ACTIVE', amountCents: 35_000, balanceCents: 35_000 }])).toBeNull();
    expect(summarizeUsedCredit([{ company: 'VALLE_SHOWROOM', status: 'ACTIVE', amountCents: 50_000, balanceCents: 50_000 }])).toBeNull();
  });
});

localDescribe('geração do alerta', () => {
  test('cancelamento após USO PARCIAL: alerta com empresa, valores e referência do pedido; sem código de voucher nem dado pessoal; nada é alterado', async () => {
    const u = await newUnit();
    await redeem(u.showroom, 20_000);
    const events = await cancelOrder(u.orderId);
    expect(events.some((e) => e.type === 'VALE_PASS_CANCELLED_WITH_USED_CREDIT' && (e.detail as { usedCents: number }).usedCents === 20_000)).toBe(true);

    const [alert] = await alertsOf(u.orderId);
    expect(alert).toMatchObject({ status: 'OPEN', usedCents: 20_000, topic: 'refunds/create', campaignId: u.campaignId });
    expect(alert.shopifyOrderName).toMatch(/^#T5/);
    expect(alert.detail).toMatchObject({ vouchersWithUse: 1, lines: [{ company: 'VALLE_SHOWROOM', vouchers: 1, amountCents: 50_000, usedCents: 20_000, balanceCents: 30_000 }, { company: 'VS_BY_CLOSET', vouchers: 1, amountCents: 5_000, usedCents: 0, balanceCents: 5_000 }] });
    const raw = JSON.stringify(alert);
    expect(raw).not.toContain(u.showroom.code);
    expect(raw).not.toContain(u.closet.code);
    expect(raw).not.toMatch(/VALLE-[A-Z0-9]{4}-/);
    expect(raw).not.toMatch(/Maria|maria\.souza|91234|Silva/);

    // o alerta só informa: voucher ativo foi cancelado pela regra de sempre; saldo e ledger intactos
    expect(await row(u.showroom.id)).toMatchObject({ status: 'CANCELLED', balanceCents: 30_000 });
    expect(await row(u.closet.id)).toMatchObject({ status: 'CANCELLED', balanceCents: 5_000 });
    expect(await ledger.reconcile()).toEqual([]);
    const audit = await auditOf(u.orderId, 'VALE_PASS_CANCELLATION_CREDIT_USED');
    expect(audit).toHaveLength(1);
    expect(audit[0].isCritical).toBe(true);
    expect(JSON.stringify(audit[0])).not.toMatch(/VALLE-[A-Z0-9]{4}-|maria\.souza/);
  });

  test('cancelamento após USO TOTAL dos dois: alerta soma R$ 550; vouchers usados continuam usados', async () => {
    const u = await newUnit();
    await redeem(u.showroom, 50_000);
    await redeem(u.closet, 5_000);
    await cancelOrder(u.orderId, 'orders/cancelled');
    const [alert] = await alertsOf(u.orderId);
    expect(alert).toMatchObject({ usedCents: 55_000, topic: 'orders/cancelled' });
    expect(await row(u.showroom.id)).toMatchObject({ status: 'USED', balanceCents: 0 });
    expect(await row(u.closet.id)).toMatchObject({ status: 'USED', balanceCents: 0 });
  });

  test('voucher LEGADO já usado e depois cancelado: alerta com a linha LEGACY', async () => {
    const campaign = await prisma.valePassCampaign.create({ data: { name: `${TAG}-leg-${counter++}`, amountCents: 35_000, validityDays: 30, shopifyVariantId: `${TAG}-var-${counter++}` } });
    campaignIds.push(campaign.id);
    const orderId = `${TAG}-o${counter++}`;
    orderIds.push(orderId);
    await prisma.valePassOrder.create({ data: { shopifyOrderId: orderId, shopifyOrderGid: `gid://shopify/Order/${orderId}`, shopifyOrderName: '#T-LEG', status: 'CONFIRMED', financialStatus: 'paid', quantity: 1, lastSyncSource: 'teste', orderCreatedAt: new Date(), statusChangedAt: new Date() } });
    const legacy = await prisma.valePass.create({ data: { code: `VALLE-${TAG.slice(-4)}-L${counter++}`.toUpperCase(), campaignId: campaign.id, amountCents: 35_000, purchasedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), shopifyOrderId: orderId } });
    await vouchersService.markUsed(legacy.code, admin.id, admin.name, { role: 'ADMIN' });
    await cancelOrder(orderId);
    const [alert] = await alertsOf(orderId);
    expect(alert).toMatchObject({ usedCents: 35_000, shopifyOrderName: '#T-LEG' });
    expect(alert.detail).toMatchObject({ lines: [{ company: 'LEGACY', usedCents: 35_000 }] });
  });

  test('SEM crédito utilizado (nada resgatado) ou pedido sem vouchers: nenhum alerta', async () => {
    const u = await newUnit();
    await cancelOrder(u.orderId);
    expect(await alertsOf(u.orderId)).toHaveLength(0);
    const orphan = `${TAG}-o${counter++}`;
    orderIds.push(orphan);
    await cancelOrder(orphan);
    expect(await alertsOf(orphan)).toHaveLength(0);
    expect(await auditOf(u.orderId, 'VALE_PASS_CANCELLATION_CREDIT_USED')).toHaveLength(0);
  });
});

localDescribe('idempotência e concorrência', () => {
  test('o mesmo cancelamento de novo, e por OUTRO tópico, não duplica o alerta nem a auditoria e não reabre o conferido', async () => {
    const u = await newUnit();
    await redeem(u.showroom, 10_000);
    await cancelOrder(u.orderId, 'refunds/create');
    const again = await cancelOrder(u.orderId, 'refunds/create');
    await cancelOrder(u.orderId, 'orders/cancelled');
    expect(again.some((e) => e.type === 'VALE_PASS_CANCELLED_WITH_USED_CREDIT')).toBe(false);
    expect(await alertsOf(u.orderId)).toHaveLength(1);
    expect(await auditOf(u.orderId, 'VALE_PASS_CANCELLATION_CREDIT_USED')).toHaveLength(1);
    const [alert] = await alertsOf(u.orderId);
    await alerts.acknowledge(alert.id, 'Conferido com o financeiro (teste sintético)', admin);
    await cancelOrder(u.orderId, 'orders/cancelled');
    expect((await alertsOf(u.orderId))[0].status).toBe('ACKNOWLEDGED'); // webhook repetido depois da conferência não reabre
  });

  test('8 webhooks simultâneos do mesmo cancelamento: um único alerta e uma única auditoria', async () => {
    const u = await newUnit();
    await redeem(u.closet, 2_000);
    const results = await Promise.all(Array.from({ length: 8 }, () => cancelOrder(u.orderId)));
    expect(results.filter((events) => events.some((e) => e.type === 'VALE_PASS_CANCELLED_WITH_USED_CREDIT'))).toHaveLength(1);
    expect(await alertsOf(u.orderId)).toHaveLength(1);
    expect(await auditOf(u.orderId, 'VALE_PASS_CANCELLATION_CREDIT_USED')).toHaveLength(1);
  });

  test('resgate simultâneo ao cancelamento: o alerta reflete o que foi realmente consumido (nunca um valor que o cancelamento não viu)', async () => {
    for (let round = 0; round < 8; round++) {
      const u = await newUnit();
      await redeem(u.showroom, 10_000);
      const racing = redemption.confirmRedeem(u.showroom.code, { company: 'VALLE_SHOWROOM', amountCents: 5_000, reference: REF, operationId: `op-${randomUUID()}`, expectedBalanceCents: 40_000, confirmAmountCents: 5_000 }, admin).then((r) => r, (e: unknown) => e);
      const cancel = cancelOrder(u.orderId);
      await Promise.all(round % 2 === 0 ? [racing, cancel] : [cancel, racing]);
      const [alert] = await alertsOf(u.orderId);
      const final = await row(u.showroom.id);
      expect(alert).toBeDefined();
      // o resgate só passou se ocorreu ANTES do cancelamento; nesse caso o alerta já o contém. Depois do cancelamento nenhum resgate é aceito.
      expect(alert.usedCents).toBe(50_000 - final.balanceCents);
      expect(await ledger.reconcile()).toEqual([]);
    }
  }, 120_000);
});

localDescribe('apresentação no ClosetAdmin (API) e conferência', () => {
  test('a capacidade da campanha traz o alerta (empresa, valores, referência) e o alerta crítico; depois da conferência ele sai da lista aberta e fica no histórico', async () => {
    const u = await newUnit();
    await redeem(u.showroom, 20_000);
    await cancelOrder(u.orderId);
    const capacity = await lots.getCapacity(u.campaignId);
    expect(capacity.cancellationAlerts).toHaveLength(1);
    expect(capacity.cancellationAlerts[0]).toMatchObject({ usedCents: 20_000, shopifyOrderId: u.orderId, lines: [{ company: 'VALLE_SHOWROOM', usedCents: 20_000 }, { company: 'VS_BY_CLOSET', usedCents: 0 }] });
    expect(capacity.cancellationAlerts[0].orderName).toMatch(/^#T5/);
    const code = capacity.alerts.find((a) => a.code === 'CANCELLED_ORDER_CREDIT_USED');
    expect(code).toMatchObject({ severity: 'critical' });
    expect(code?.message).toContain('R$ 200,00');
    expect(JSON.stringify(capacity.cancellationAlerts)).not.toMatch(/VALLE-[A-Z0-9]{4}-|maria\.souza|Maria/);

    const done = await alerts.acknowledge(capacity.cancellationAlerts[0].id, 'Reembolso conferido com o financeiro (teste sintético)', admin);
    expect(done).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedByName: admin.name });
    expect((await lots.getCapacity(u.campaignId)).cancellationAlerts).toHaveLength(0);
    expect((await lots.getCapacity(u.campaignId)).alerts.some((a) => a.code === 'CANCELLED_ORDER_CREDIT_USED')).toBe(false);
    expect(await alerts.list('OPEN', u.campaignId)).toHaveLength(0);
    expect((await alerts.list('ACKNOWLEDGED', u.campaignId)).map((a) => a.shopifyOrderId)).toEqual([u.orderId]);
    // a conferência não mexe em nada além do alerta
    expect(await row(u.showroom.id)).toMatchObject({ status: 'CANCELLED', balanceCents: 30_000 });
    expect(await ledger.reconcile()).toEqual([]);
    const audit = await auditOf(u.orderId, 'VALE_PASS_CANCELLATION_ALERT_ACKNOWLEDGED');
    expect(audit).toHaveLength(1);
    expect(audit[0].isCritical).toBe(true);
  });

  test('conferência: só ADMIN, justificativa 10–500, uma única vez (409), 5 conferências simultâneas = uma', async () => {
    const u = await newUnit();
    await redeem(u.closet, 1_000);
    await cancelOrder(u.orderId);
    const [alert] = await alertsOf(u.orderId);
    const staff = { id: staffId, name: 'Staff Teste Alerta', role: 'STAFF' as const };
    await expect(alerts.acknowledge(alert.id, 'Conferido por quem não pode (teste)', staff)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(alerts.acknowledge(alert.id, 'curta', admin)).rejects.toBeInstanceOf(BadRequestException);
    await expect(alerts.acknowledge(alert.id, 'x'.repeat(501), admin)).rejects.toBeInstanceOf(BadRequestException);
    expect((await alertsOf(u.orderId))[0].status).toBe('OPEN');
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => alerts.acknowledge(alert.id, 'Conferência simultânea (teste sintético)', admin).then(() => 'ok', (e: unknown) => (e as { response?: { code?: string } }).response?.code ?? 'erro')));
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'ALREADY_ACKNOWLEDGED')).toHaveLength(4);
    await expect(alerts.acknowledge(alert.id, 'Outra tentativa depois (teste)', admin)).rejects.toBeInstanceOf(ConflictException);
    expect(await auditOf(u.orderId, 'VALE_PASS_CANCELLATION_ALERT_ACKNOWLEDGED')).toHaveLength(1);
  });

  test('o proprietário (SUPER_ADMIN) também confere; justificativa, quem e quando ficam no registro e na auditoria', async () => {
    const owner = await prisma.adminUser.create({ data: { name: 'Proprietário Teste Alerta', phone: `${TAG}-owner`, pinHash: 'x', role: 'SUPER_ADMIN', active: true } });
    try {
      const u = await newUnit();
      await redeem(u.closet, 1_000);
      await cancelOrder(u.orderId);
      const [alert] = await alertsOf(u.orderId);
      const done = await alerts.acknowledge(alert.id, 'Conferido pelo proprietário (teste sintético)', { id: owner.id, name: owner.name, role: 'SUPER_ADMIN' });
      expect(done).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedByName: owner.name, acknowledgeNote: 'Conferido pelo proprietário (teste sintético)' });
      const stored = (await alertsOf(u.orderId))[0];
      expect(stored).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedBy: owner.id });
      expect(stored.acknowledgedAt).not.toBeNull();
      const audit = await auditOf(u.orderId, 'VALE_PASS_CANCELLATION_ALERT_ACKNOWLEDGED');
      expect(audit[0]).toMatchObject({ adminUserId: owner.id, isCritical: true });
      expect(JSON.stringify(audit[0].detail)).toContain('Conferido pelo proprietário');
    } finally {
      await prisma.adminAuditEvent.deleteMany({ where: { adminUserId: owner.id } });
      await prisma.adminUser.delete({ where: { id: owner.id } });
    }
  });

  test('o banco protege o alerta: fatos imutáveis, conferência só uma vez e sem apagar', async () => {
    const u = await newUnit();
    await redeem(u.closet, 1_000);
    await cancelOrder(u.orderId);
    const [alert] = await alertsOf(u.orderId);
    await expect(prisma.$executeRaw`UPDATE vale_pass_cancellation_alerts SET used_cents = 1 WHERE id = ${alert.id}::uuid`).rejects.toThrow(/vale_pass_cancellation_alert_immutable/);
    await expect(prisma.$executeRaw`UPDATE vale_pass_cancellation_alerts SET detail = '{}'::jsonb WHERE id = ${alert.id}::uuid`).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRaw`UPDATE vale_pass_cancellation_alerts SET status = 'ACKNOWLEDGED' WHERE id = ${alert.id}::uuid`).rejects.toThrow(); // sem quem/quando/justificativa
    await expect(prisma.$executeRaw`DELETE FROM vale_pass_cancellation_alerts WHERE id = ${alert.id}::uuid`).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRaw`TRUNCATE vale_pass_cancellation_alerts`).rejects.toThrow(/immutable/);
    await alerts.acknowledge(alert.id, 'Conferido (teste sintético)', admin);
    await expect(prisma.$executeRaw`UPDATE vale_pass_cancellation_alerts SET acknowledge_note = 'adulterado pelo teste' WHERE id = ${alert.id}::uuid`).rejects.toThrow(/immutable/);
  });

  test('as rotas: conferir exige ADMIN; consultar exige o módulo Valle Pass; nada é público', () => {
    const proto = ValePassCancellationAlertsController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto.acknowledge)).toBe('ADMIN');
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto.list)).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, ValePassCancellationAlertsController)).toBe('VALLE_PASS');
  });
});

localDescribe('pelo pipeline real do webhook (WebhooksService)', () => {
  test('orders/cancelled de pedido com voucher legado já usado: o alerta nasce e o evento fica registrado; webhook repetido não duplica', async () => {
    const prismaLocal = prisma;
    const service = new WebhooksService(prismaLocal, new ValePassWebhookService(), new ShopifyOrderSyncService());
    const suffix = Date.now();
    const campaign = await prismaLocal.valePassCampaign.create({ data: { name: `Campanha VP-WH-${suffix}`, amountCents: 15_000, validityDays: 90, shopifyVariantId: String(9_100_000 + (suffix % 1_000_000)) } });
    campaignIds.push(campaign.id);
    const orderId = 2_100_000_000 + (suffix % 1_000_000);
    orderIds.push(String(orderId));
    const payload: ShopifyOrderPayload = { id: orderId, admin_graphql_api_id: `gid://shopify/Order/${orderId}`, name: `#${orderId}`, financial_status: 'paid', line_items: [{ variant_id: Number(campaign.shopifyVariantId), quantity: 1 }], email: 'cliente@teste.com', customer: { first_name: 'Cliente', last_name: 'Teste', phone: '+56911112222' } };
    const hook = (topic: string, n: number, body: object) => service.handleIncoming({ topic, shopifyWebhookId: `VP-WH-${suffix}-ca-${n}`, payload: body as ShopifyOrderPayload });
    await hook('orders/paid', 1, payload);
    const voucher = await prismaLocal.valePass.findFirstOrThrow({ where: { campaignId: campaign.id } });
    await vouchersService.markUsed(voucher.code, admin.id, admin.name, { role: 'ADMIN' });
    expect((await hook('orders/cancelled', 2, { ...payload, cancel_reason: 'customer' })).outcome).toBe('processed');
    expect((await hook('orders/cancelled', 3, { ...payload, cancel_reason: 'customer' })).outcome).toBeDefined();
    const found = await alertsOf(String(orderId));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ usedCents: 15_000, status: 'OPEN' });
    const events = await prismaLocal.$queryRaw<{ type: string; detail: unknown }[]>`
      SELECT re.type AS type, re.detail FROM reservation_events re JOIN webhook_events we ON we.id = re.webhook_event_id WHERE we.order_id = ${String(orderId)} AND re.type = 'VALE_PASS_CANCELLED_WITH_USED_CREDIT'`;
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0].detail)).not.toContain(voucher.code);
    // limpeza própria do pipeline (webhooks/eventos/pedido deste teste)
    await prismaLocal.$executeRaw`DELETE FROM reservation_events WHERE webhook_event_id IN (SELECT id FROM webhook_events WHERE shopify_webhook_id LIKE ${`VP-WH-${suffix}-ca-%`})`;
    await prismaLocal.$executeRaw`DELETE FROM webhook_events WHERE shopify_webhook_id LIKE ${`VP-WH-${suffix}-ca-%`}`;
    await prismaLocal.$executeRaw`DELETE FROM vale_pass_order_events WHERE vale_pass_order_id IN (SELECT id FROM vale_pass_orders WHERE shopify_order_id = ${String(orderId)})`;
  }, 60_000);
});
