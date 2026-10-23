import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ValePassCampaign } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { lockShopifyOrder } from '../../webhooks/shopify-order-lock';
import { ValePassHoldsService } from '../vale-pass-holds.service';
import { ValePassIssuanceService, type IssuanceOrder } from '../vale-pass-issuance.service';
import { ValePassLotsService } from '../vale-pass-lots.service';
import { ValePassFinancialGuard, maxUnitsPerOrder, summarizeIssues } from './financial-guard.service';
import { factsFromAdminOrder, factsFromWebhookPayload } from './order-facts';

/**
 * Validação financeira contra a configuração comercial REAL (campanha no banco) e a fila de resolução, em PostgreSQL LOCAL descartável.
 * O módulo é ISOLADO: nada do fluxo ativo o chama; estes testes o chamam do jeito que a integração futura chamaria.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const guard = new ValePassFinancialGuard();
const issuance = new ValePassIssuanceService();
const holds = new ValePassHoldsService(prisma, issuance);
const lots = new ValePassLotsService(prisma);

const TAG = `VPFIN-${Date.now()}`;
let counter = 0;
let adminId: string;
const ADMIN_NAME = 'Admin Teste Financeiro';
const campaignIds: string[] = [];
const orderIds: string[] = [];

const money = (amount: string, currency = 'BRL') => ({ shop_money: { amount, currency_code: currency }, presentment_money: { amount, currency_code: currency } });
function payloadFor(variantNumeric: string, over: Record<string, unknown> = {}, quantity = 1, priceText = '350.00'): Record<string, unknown> {
  const total = ((Number(priceText.replace('.', '')) * quantity) / 100).toFixed(2);
  return {
    id: `${TAG}-o${counter++}`, name: '#X', financial_status: 'paid', cancelled_at: null, currency: 'BRL', presentment_currency: 'BRL', current_total_price: total,
    total_outstanding: '0.00', total_discounts: '0.00', discount_codes: [], refunds: [], total_shipping_price_set: money('0.00'),
    line_items: [{ variant_id: Number(variantNumeric), product_id: null, quantity, current_quantity: quantity, price: priceText, price_set: money(priceText), discount_allocations: [] }],
    ...over,
  };
}

async function newCampaign(amountCents = 35_000): Promise<ValePassCampaign & { numericVariant: string }> {
  const numericVariant = String(900_000_000_000 + counter++);
  const campaign = await prisma.valePassCampaign.create({
    data: {
      name: `${TAG}-camp-${counter++}`, amountCents, validityDays: 30, shopifyVariantId: `gid://shopify/ProductVariant/${numericVariant}`,
      voucherValidFrom: new Date('2027-01-01T00:00:00.000Z'), voucherValidUntil: new Date('2027-12-31T00:00:00.000Z'),
    },
  });
  campaignIds.push(campaign.id);
  await prisma.valePassCampaignBenefit.createMany({
    data: [
      { campaignId: campaign.id, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 },
      { campaignId: campaign.id, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 },
    ],
  });
  return { ...campaign, numericVariant };
}

/** Pedido PAGO registrado (CONFIRMED), ainda sem vouchers. */
async function registerPaidOrder(quantity = 1): Promise<IssuanceOrder> {
  const orderId = `${TAG}-reg${counter++}`;
  orderIds.push(orderId);
  await prisma.valePassOrder.create({
    data: {
      shopifyOrderId: orderId, shopifyOrderGid: `gid://shopify/Order/${orderId}`, shopifyOrderName: `${TAG}#${counter}`, status: 'CONFIRMED', financialStatus: 'paid', quantity,
      customerName: 'Cliente Sintético', customerEmail: `c${counter}@exemplo.invalid`, customerPhone: '+5500000000000', lastSyncSource: 'teste',
      orderCreatedAt: new Date(Date.now() - 3_600_000), statusChangedAt: new Date(Date.now() - 3_600_000), vouchersProcessedAt: new Date(),
    },
  });
  return { orderId, orderGid: `gid://shopify/Order/${orderId}`, orderName: `${TAG}#${counter}`, customerName: 'Cliente Sintético', customerPhone: '+5500000000000', customerEmail: `c${counter}@exemplo.invalid` };
}

const holdTx = (campaignId: string, order: IssuanceOrder, units: number, issues: readonly { code: string; detail?: Record<string, unknown> }[]) =>
  prisma.$transaction(async (tx) => {
    await lockShopifyOrder(tx, order.orderId);
    return issuance.holdForFinancialReview(tx, { campaignId, order, units, issues });
  });
const evaluate = (payload: unknown) => prisma.$transaction((tx) => guard.evaluate(tx, factsFromWebhookPayload(payload)));

beforeAll(async () => {
  if (!localDatabase) return;
  adminId = (await prisma.adminUser.create({ data: { name: ADMIN_NAME, phone: `${TAG}-admin`, pinHash: 'x', role: 'ADMIN', active: true } })).id;
});

async function cleanRows() {
  const ids = campaignIds.splice(0);
  const orders = orderIds.splice(0);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    const holdRows = await tx.valePassIssuanceHold.findMany({ where: { campaignId: { in: ids } }, select: { id: true } });
    const vouchers = await tx.valePass.findMany({ where: { campaignId: { in: ids } }, select: { id: true } });
    await tx.adminAuditEvent.deleteMany({ where: { OR: [{ entityId: { in: holdRows.map((h) => h.id) } }, { adminUserId: adminId }] } });
    await tx.valePassEvent.deleteMany({ where: { valePassId: { in: vouchers.map((v) => v.id) } } });
    await tx.valePass.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassIssuanceHold.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaignBenefit.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaign.deleteMany({ where: { id: { in: ids } } });
    const regs = await tx.valePassOrder.findMany({ where: { shopifyOrderId: { in: orders } }, select: { id: true } });
    await tx.valePassOrderEvent.deleteMany({ where: { valePassOrderId: { in: regs.map((r) => r.id) } } });
    await tx.valePassOrder.deleteMany({ where: { shopifyOrderId: { in: orders } } });
  });
}
afterEach(async () => {
  if (localDatabase) await cleanRows();
});
afterAll(async () => {
  if (localDatabase) {
    await cleanRows();
    await prisma.adminAuditEvent.deleteMany({ where: { adminUserId: adminId } });
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
  }
  await prisma.$disconnect();
});

localDescribe('validação financeira × configuração comercial do banco', () => {
  test('o preço esperado vem da CAMPANHA no banco: o mesmo payload vale ou não conforme a campanha, nunca conforme o próprio payload', async () => {
    const c = await newCampaign(35_000);
    const payload = payloadFor(c.numericVariant);
    expect(await evaluate(payload)).toMatchObject({ ok: true, units: 1, passTotalCents: 35_000, campaignIds: [c.id] });

    await prisma.valePassCampaign.update({ where: { id: c.id }, data: { amountCents: 30_000 } });
    const afterChange = await evaluate(payload);
    expect(afterChange.ok).toBe(false);
    expect(afterChange.ok ? [] : afterChange.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['PRICE_MISMATCH', 'TOTAL_MISMATCH']));

    // e um payload "barato" nunca passa só por declarar o próprio preço
    const cheap = await evaluate(payloadFor(c.numericVariant, {}, 1, '1.00'));
    expect(cheap.ok).toBe(false);
  });

  test('quantidades 1, 3 e 10 usam o preço da campanha; 11 ultrapassa o teto', async () => {
    const c = await newCampaign();
    for (const quantity of [1, 3, 10]) expect(await evaluate(payloadFor(c.numericVariant, {}, quantity))).toMatchObject({ ok: true, units: quantity, passTotalCents: 35_000 * quantity });
    const eleven = await evaluate(payloadFor(c.numericVariant, {}, 11));
    expect(eleven.ok ? [] : eleven.issues.map((i) => i.code)).toContain('QUANTITY_OUT_OF_RANGE');
    expect(maxUnitsPerOrder({})).toBe(10);
    expect(maxUnitsPerOrder({ VALE_PASS_MAX_UNITS_PER_ORDER: '25' })).toBe(25);
    for (const bad of ['0', '-3', 'abc', '1.5', '99999', '']) expect(maxUnitsPerOrder({ VALE_PASS_MAX_UNITS_PER_ORDER: bad }), bad).toBe(10); // inválido volta ao padrão, nunca a "sem limite"
  });

  test('variante sem campanha, outra campanha com outro preço e carrinho misto', async () => {
    const a = await newCampaign(35_000);
    const b = await newCampaign(10_000);
    const unknown = await evaluate(payloadFor('777000111222'));
    expect(unknown.ok ? [] : unknown.issues.map((i) => i.code)).toContain('NO_VALLE_PASS_LINE');
    const wrongCampaign = await evaluate(payloadFor(b.numericVariant)); // preço de 350 numa campanha de 100
    expect(wrongCampaign.ok).toBe(false);
    expect(await evaluate(payloadFor(b.numericVariant, {}, 1, '100.00'))).toMatchObject({ ok: true, campaignIds: [b.id] });
    const mixed = payloadFor(a.numericVariant) as { line_items: unknown[] };
    mixed.line_items.push({ variant_id: 1, product_id: 2, quantity: 1, current_quantity: 1, price: '10.00', price_set: money('10.00'), discount_allocations: [] });
    const verdict = await evaluate(mixed);
    expect(verdict.ok ? [] : verdict.issues.map((i) => i.code)).toContain('MIXED_CART');
  });

  test('webhooks duplicados, fora de ordem e concorrentes: 60 avaliações simultâneas dão exatamente o mesmo veredito', async () => {
    const c = await newCampaign();
    const good = payloadFor(c.numericVariant, {}, 2);
    const bad = payloadFor(c.numericVariant, { financial_status: 'pending' }, 2);
    const baseline = await Promise.all([evaluate(good), evaluate(bad)]);
    const runs = await Promise.all(Array.from({ length: 60 }, (_v, i) => evaluate(i % 2 === 0 ? good : bad)));
    runs.forEach((verdict, i) => expect(verdict).toEqual(baseline[i % 2]));
    expect(baseline[0].ok).toBe(true);
    expect(baseline[1].ok).toBe(false);
  });

  test('Pix aguardando → depois pago: o primeiro é recusado como "não pago" e o segundo (mesmo pedido) é válido', async () => {
    const c = await newCampaign();
    const pixPending = payloadFor(c.numericVariant, { financial_status: 'pending', total_outstanding: '350.00' });
    const pixPaid = { ...pixPending, financial_status: 'paid', total_outstanding: '0.00' };
    const first = await evaluate(pixPending);
    expect(first.ok ? [] : first.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['NOT_FULLY_PAID', 'OUTSTANDING_BALANCE']));
    expect((await evaluate(pixPaid)).ok).toBe(true);
    // cartão: autorizado ≠ capturado
    expect((await evaluate({ ...pixPaid, financial_status: 'authorized' })).ok).toBe(false);
  });

  test('reconciliação: o payload da consulta ANTIGA da Admin API (sem dados financeiros) é recusado de forma explícita; a nova consulta passa', async () => {
    const c = await newCampaign();
    const legacyAdminPayload = { id: 5551234567890, admin_graphql_api_id: 'gid://shopify/Order/5551234567890', name: '#1042', financial_status: 'paid', cancelled_at: null, line_items: [{ variant_id: c.numericVariant, product_id: null, quantity: 1 }] };
    const refused = await evaluate(legacyAdminPayload);
    expect(refused.ok ? [] : refused.issues.map((i) => i.code)).toEqual(['FINANCIALS_UNDEFINED']);

    const set = (amount: string) => ({ shopMoney: { amount, currencyCode: 'BRL' } });
    const node = {
      id: 'gid://shopify/Order/5551234567890', currencyCode: 'BRL', presentmentCurrencyCode: 'BRL', displayFinancialStatus: 'PAID', cancelledAt: null, discountCodes: [],
      currentTotalPriceSet: set('350.00'), totalOutstandingSet: set('0.00'), totalDiscountsSet: set('0.00'), totalShippingPriceSet: set('0.00'),
      lineItems: { nodes: [{ quantity: 1, currentQuantity: 1, variant: { id: `gid://shopify/ProductVariant/${c.numericVariant}` }, product: null, originalUnitPriceSet: set('350.00'), discountAllocations: [] }] },
    };
    expect(await prisma.$transaction((tx) => guard.evaluate(tx, factsFromAdminOrder(node)))).toMatchObject({ ok: true, units: 1 });
  });
});

localDescribe('divergência financeira → fila de resolução administrativa (nunca descarte, nunca retenção sem dono)', () => {
  const issuesOf = async (payload: unknown) => {
    const verdict = await evaluate(payload);
    if (verdict.ok) throw new Error('esperava divergência');
    return { verdict, summary: summarizeIssues(verdict.issues) };
  };

  test('pagamento com desconto vira UMA retenção aberta (reentregas não duplicam), visível no painel e contada como consumida', async () => {
    const c = await newCampaign();
    await prisma.valePassCampaign.update({ where: { id: c.id }, data: { globalLimit: 100 } });
    const order = await registerPaidOrder();
    const discounted = payloadFor(c.numericVariant, { total_discounts: '35.00', current_total_price: '315.00', discount_codes: [{ code: 'PROMO10', amount: '35.00' }] });
    const { summary } = await issuesOf(discounted);

    const results = await Promise.all(Array.from({ length: 6 }, () => holdTx(c.id, order, 1, summary)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.holdId)).size).toBe(1);
    const rows = await prisma.valePassIssuanceHold.findMany({ where: { shopifyOrderId: order.orderId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'FINANCIAL_MISMATCH', status: 'OPEN', openFlag: true, units: 1 });
    expect(JSON.stringify(rows[0].detail)).toContain('DISCOUNT_PRESENT');
    expect(JSON.stringify(rows[0].detail)).not.toContain(order.customerEmail as string); // sem dados pessoais

    const capacity = await lots.getCapacity(c.id);
    expect(capacity.holds).toEqual([expect.objectContaining({ id: rows[0].id, reason: 'FINANCIAL_MISMATCH', issues: expect.arrayContaining(['DISCOUNT_PRESENT', 'TOTAL_MISMATCH']) })]);
    expect(capacity.alerts.map((a) => a.code)).toContain('ISSUANCE_HOLDS_OPEN');
    expect(capacity.totals).toMatchObject({ sold: 0, pending: 1, consumed: 1 }); // a unidade paga conta como consumida enquanto retida
    expect(await prisma.valePass.count({ where: { campaignId: c.id } })).toBe(0); // nada foi emitido nem cancelado
  });

  test('retenção parada há mais de 24 h gera alerta CRÍTICO (cliente já pagou e o prazo de 3 dias corre)', async () => {
    const c = await newCampaign();
    const order = await registerPaidOrder();
    const { summary } = await issuesOf(payloadFor(c.numericVariant, { currency: 'USD' }));
    const { holdId } = await holdTx(c.id, order, 1, summary);
    expect((await lots.getCapacity(c.id)).alerts.map((a) => a.code)).not.toContain('ISSUANCE_HOLD_STALE');
    await prisma.valePassIssuanceHold.update({ where: { id: holdId as string }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    const alerts = (await lots.getCapacity(c.id)).alerts;
    expect(alerts.find((a) => a.code === 'ISSUANCE_HOLD_STALE')).toMatchObject({ severity: 'critical' });
  });

  test('resolução explícita: ADMIN emite com confirmação reforçada → 2 vouchers, retenção fechada, auditoria; reentrega depois NÃO abre nova retenção', async () => {
    const c = await newCampaign();
    const order = await registerPaidOrder();
    const { summary } = await issuesOf(payloadFor(c.numericVariant, { total_discounts: '50.00', current_total_price: '300.00' }));
    const { holdId } = await holdTx(c.id, order, 1, summary);

    const preview = await holds.preview(holdId as string);
    expect(preview).toMatchObject({ reason: 'FINANCIAL_MISMATCH', canIssue: true, units: 1 });
    const resolved = await holds.issue(
      holdId as string,
      { note: 'Cupom autorizado pelo Anderson para este cliente', confirmTotal: preview.projectedTotal, expected: { projectedTotal: preview.projectedTotal, consumedTotal: preview.consumedBefore, globalLimit: preview.globalLimit, capacityLimit: preview.capacityLimit, holdUpdatedAt: preview.holdUpdatedAt } },
      adminId,
      ADMIN_NAME,
    );
    expect(resolved).toMatchObject({ status: 'ISSUED', issuedUnits: 1 });
    const vouchers = await prisma.valePass.findMany({ where: { shopifyOrderId: order.orderId } });
    expect(vouchers).toHaveLength(2);
    expect(new Set(vouchers.map((v) => v.company))).toEqual(new Set(['VALLE_SHOWROOM', 'VS_BY_CLOSET']));
    expect((await prisma.adminAuditEvent.findFirstOrThrow({ where: { entityId: holdId as string } }))).toMatchObject({ action: 'VALE_PASS_HOLD_ISSUED', adminUserId: adminId, isCritical: true });

    // a mesma divergência chegando de novo (webhook repetido) não reabre a retenção: o pedido já foi tratado
    expect(await holdTx(c.id, order, 1, summary)).toEqual({ holdId: null, created: false });
    expect(await prisma.valePassIssuanceHold.count({ where: { shopifyOrderId: order.orderId, status: 'OPEN' } })).toBe(0);
  });

  test('resolução alternativa: reembolso na Shopify → "descartar" só depois de o pedido deixar de estar pago; nada é reembolsado pelo sistema', async () => {
    const c = await newCampaign();
    const order = await registerPaidOrder();
    const { summary } = await issuesOf(payloadFor(c.numericVariant, { currency: 'USD' }));
    const { holdId } = await holdTx(c.id, order, 1, summary);
    await expect(holds.dismiss(holdId as string, 'cliente pediu reembolso', adminId, ADMIN_NAME)).rejects.toThrow(/continua pago/);
    await prisma.valePassOrder.update({ where: { shopifyOrderId: order.orderId }, data: { status: 'REFUNDED' } }); // o reembolso acontece NA Shopify e chega pelo webhook
    expect(await holds.dismiss(holdId as string, 'pedido reembolsado na Shopify', adminId, ADMIN_NAME)).toMatchObject({ status: 'DISMISSED' });
    expect(await prisma.valePass.count({ where: { shopifyOrderId: order.orderId } })).toBe(0);
  });

  test('o pedido retido NÃO é cancelado, reembolsado nem alterado pelo módulo; vouchers legados seguem idênticos', async () => {
    const c = await newCampaign();
    const legacy = await prisma.valePass.create({ data: { code: `${TAG}-legado`, campaignId: c.id, amountCents: 35_000, status: 'ACTIVE', purchasedAt: new Date('2026-09-14T12:00:00Z'), expiresAt: new Date('2026-10-14T12:00:00Z'), shopifyOrderId: `${TAG}-legacy-order` } });
    const order = await registerPaidOrder();
    const before = await prisma.valePassOrder.findUniqueOrThrow({ where: { shopifyOrderId: order.orderId } });
    const { summary } = await issuesOf(payloadFor(c.numericVariant, { financial_status: 'partially_paid', total_outstanding: '100.00' }));
    await holdTx(c.id, order, 1, summary);
    expect(await prisma.valePass.findUniqueOrThrow({ where: { id: legacy.id } })).toEqual(legacy);
    expect(await prisma.valePassOrder.findUniqueOrThrow({ where: { shopifyOrderId: order.orderId } })).toEqual(before);
  });
});

localDescribe('isolamento: a validação financeira não está ligada ao fluxo financeiro ativo', () => {
  test('ninguém em produção usa o guard, o validador ou a retenção financeira; o webhook, o checkout e o HMAC não os conhecem', () => {
    const root = join(__dirname, '..', '..');
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && /ValePassFinancialGuard|validateValePassFinancials|holdForFinancialReview|factsFromWebhookPayload|factsFromAdminOrder/.test(readFileSync(full, 'utf8'))) users.push(full.slice(root.length + 1).split('\\').join('/'));
      }
    };
    walk(root);
    expect(users.sort()).toEqual(['vale-pass/financial/financial-guard.service.ts', 'vale-pass/financial/order-facts.ts', 'vale-pass/financial/validate-order.ts', 'vale-pass/flow/payment-flow.service.ts', 'vale-pass/refunds/regularization.service.ts', 'vale-pass/vale-pass-issuance.service.ts', 'vale-pass/vale-pass.module.ts']);
    for (const file of ['vale-pass/vale-pass-webhook.service.ts', 'webhooks/webhooks.service.ts', 'webhooks/webhooks.controller.ts', 'webhooks/shopify-hmac.ts', 'vale-pass/vale-pass-orders.service.ts']) {
      const source = readFileSync(join(root, file), 'utf8');
      for (const name of ['/financial/', 'ValePassFinancialGuard', 'validateValePassFinancials', 'holdForFinancialReview', 'factsFromWebhookPayload']) expect(source, `${file} → ${name}`).not.toContain(name);
    }
  });
});
