import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { ValePassCampaign } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { lockShopifyOrder } from '../../webhooks/shopify-order-lock';
import { loadEmailConfig } from '../email/email-config';
import { ValePassEmailOutboxService } from '../email/email-outbox.service';
import { ValePassFinancialGuard } from '../financial/financial-guard.service';
import { ValePassIssuanceService } from '../vale-pass-issuance.service';
import { ValePassRefundService } from '../refunds/refund.service';
import { ValePassRegularizationService } from '../refunds/regularization.service';
import { ValePassWebhookService } from '../vale-pass-webhook.service';
import type { FlowFlags } from './flow-flags';
import { ValePassPaymentFlowService } from './payment-flow.service';
import { loadTermsAcceptanceConfig, type TermsAcceptanceConfig } from './terms-acceptance-config';
import { ValePassTermsAcceptanceService } from './terms-acceptance.service';
import { issueTermsToken } from './terms-token';

/**
 * Aceite eletrônico dos termos (token assinado + retenção opcional), em PostgreSQL LOCAL descartável: pagamento → registro do pedido → evento de evidência → emissão ou retenção. Nenhuma Shopify, nenhum e-mail enviado, nada cancelado nem reembolsado.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const issuance = new ValePassIssuanceService();
const outbox = new ValePassEmailOutboxService(prisma, loadEmailConfig({}));
const refunds = new ValePassRefundService(prisma);
const TAG = `VPTE-${Date.now()}`;
let counter = 0;
const campaignIds: string[] = [];
const orderIds: string[] = [];

/** Chaves controladas pelo teste (o padrão de produção é tudo DESLIGADO). */
const flags = { twoVoucher: false };
const SECRET = 'segredo-de-teste-0123456789-abcdefghij-xyz';
const SHA = 'ab'.repeat(32);
const envOk = { VALE_PASS_TERMS_ACCEPTANCE: 'on', VALE_PASS_TERMS_VERSION: '2027-1', VALE_PASS_TERMS_SHA256: SHA, VALE_PASS_TERMS_TOKEN_SECRET: SECRET };
let termsConfig: TermsAcceptanceConfig = loadTermsAcceptanceConfig({});
const configure = (extra: Record<string, string | undefined> = {}) => { termsConfig = loadTermsAcceptanceConfig({ ...envOk, ...extra }); };
const flagFns: FlowFlags = {
  twoVoucher: () => flags.twoVoucher,
  unitRefunds: () => false,
  paymentTime: () => ({ mode: 'webhook-agreement', toleranceSeconds: 120 }),
};
const regularization = new ValePassRegularizationService(prisma, new ValePassFinancialGuard(), issuance);
const service = () => new ValePassWebhookService(new ValePassPaymentFlowService(new ValePassFinancialGuard(), issuance, outbox, flagFns, prisma, regularization, () => termsConfig), refunds, flagFns);

const money = (amount: string) => ({ shop_money: { amount, currency_code: 'BRL' }, presentment_money: { amount, currency_code: 'BRL' } });

interface Campaign extends ValePassCampaign { numericVariant: string }
async function newCampaign(over: Partial<{ globalLimit: number | null }> = {}): Promise<Campaign> {
  const numericVariant = String(Date.now() * 1000 + counter++); // único por execução (um resto de execução abortada não colide)
  const campaign = await prisma.valePassCampaign.create({
    data: {
      name: `${TAG}-camp-${counter++}`, amountCents: 35_000, validityDays: 30, globalLimit: over.globalLimit === undefined ? 1_000 : over.globalLimit, shopifyVariantId: numericVariant,
      voucherValidFrom: new Date('2026-01-01T00:00:00.000Z'), voucherValidUntil: new Date('2027-12-31T00:00:00.000Z'),
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

let clock = Date.now();
function paidPayload(campaign: Campaign, quantity: number, orderId = `${TAG}-o${counter++}`): Record<string, unknown> {
  orderIds.push(orderId);
  clock += 1000;
  return {
    id: orderId, admin_graphql_api_id: `gid://shopify/Order/${orderId}`, name: `#${TAG}${counter}`, financial_status: 'paid', cancelled_at: null, currency: 'BRL', presentment_currency: 'BRL',
    created_at: new Date(clock - 60_000).toISOString(), updated_at: new Date(clock).toISOString(),
    current_total_price: ((35000 * quantity) / 100).toFixed(2), total_outstanding: '0.00', total_discounts: '0.00', discount_codes: [], refunds: [],
    total_shipping_price_set: money('0.00'), email: `cliente${counter}@exemplo.invalid`, customer: { first_name: 'Cliente', last_name: 'Sintético', email: `cliente${counter}@exemplo.invalid` },
    line_items: [{ variant_id: Number(campaign.numericVariant), product_id: null, quantity, current_quantity: quantity, price: '350.00', price_set: money('350.00'), discount_allocations: [] }],
  };
}

/** Entrega REALISTA do orders/paid: o cabeçalho e o updated_at do payload são do MESMO instante (o do pagamento). */
const runAt = (svc: ValePassWebhookService, payload: unknown, at: string) =>
  prisma.$transaction(async (tx) => {
    await lockShopifyOrder(tx, String((payload as { id: unknown }).id));
    return svc.handleOrderWebhook(tx, 'orders/paid', { ...(payload as Record<string, unknown>), updated_at: at }, { triggeredAt: at });
  }, { timeout: 30_000, maxWait: 20_000 });

const vouchersOf = (orderId: string) => prisma.valePass.findMany({ where: { shopifyOrderId: orderId }, orderBy: [{ createdAt: 'asc' }, { company: 'asc' }] });
const holdsOf = (orderId: string) => prisma.valePassIssuanceHold.findMany({ where: { shopifyOrderId: orderId } });

beforeAll(async () => {
  if (!localDatabase) return;
  await prisma.store.upsert({ where: { id: `${TAG}-store` }, update: {}, create: { id: `${TAG}-store`, shopifyDomain: `${TAG}.invalid`, currency: 'BRL' } });
});

async function cleanRows() {
  const ids = campaignIds.splice(0);
  const orders = orderIds.splice(0);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    const vouchers = await tx.valePass.findMany({ where: { campaignId: { in: ids } }, select: { id: true } });
    const outboxRows = await tx.valePassEmailOutbox.findMany({ where: { shopifyOrderId: { in: orders } }, select: { id: true } });
    await tx.valePassEmailEvent.deleteMany({ where: { outboxId: { in: outboxRows.map((row) => row.id) } } });
    await tx.valePassEmailOutbox.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.valePassRefundApplication.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.valePassEvent.deleteMany({ where: { valePassId: { in: vouchers.map((v) => v.id) } } });
    await tx.valePass.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassIssuanceHold.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaignBenefit.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaign.deleteMany({ where: { id: { in: ids } } });
    const regs = await tx.valePassOrder.findMany({ where: { shopifyOrderId: { in: orders } }, select: { id: true } });
    await tx.valePassOrderEvent.deleteMany({ where: { valePassOrderId: { in: regs.map((r) => r.id) } } });
    await tx.valePassOrderCancellation.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.valePassOrder.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.webhookEvent.deleteMany({ where: { storeId: `${TAG}-store` } });
  });
  flags.twoVoucher = false;
  termsConfig = loadTermsAcceptanceConfig({});
}
afterEach(async () => {
  if (localDatabase) await cleanRows();
});
afterAll(async () => {
  if (localDatabase) {
    await cleanRows();
    await prisma.store.deleteMany({ where: { id: `${TAG}-store` } });
  }
  await prisma.$disconnect();
});


const eventsOf = async (orderId: string) => {
  const registry = await prisma.valePassOrder.findUniqueOrThrow({ where: { shopifyOrderId: orderId }, select: { id: true } });
  return prisma.valePassOrderEvent.findMany({ where: { valePassOrderId: registry.id, type: 'TERMS_EVIDENCE_RECORDED' }, orderBy: { createdAt: 'asc' } });
};
const PAID_AT = () => new Date(Date.now() - 5_000).toISOString();
const withAttrs = (payload: Record<string, unknown>, attrs: { name: string; value: string }[]): Record<string, unknown> => ({ ...payload, note_attributes: attrs });


const mint = (campaign: Campaign, over: Partial<{ now: Date; ttlMs: number; version: string; sha256: string; variant: string; secret: string; nonce: string }> = {}) =>
  issueTermsToken({ secret: SECRET, version: '2027-1', sha256: SHA, variant: campaign.numericVariant, now: new Date(Date.now() - 10 * 60_000), ttlMs: 6 * 3_600_000, ...over }).token;
const withToken = (payload: Record<string, unknown>, token: string): Record<string, unknown> => withAttrs(payload, [{ name: 'valle_pass_terms_token', value: token }]);
const lastEvidence = async (orderId: string) => (await eventsOf(orderId)).at(-1)?.detail as Record<string, unknown> | undefined;
const heldCodes = async (orderId: string) => (await holdsOf(orderId)).flatMap((hold) => ((hold.detail as { issues?: { code: string }[] } | null)?.issues ?? []).map((issue) => issue.code));

localDescribe('aceite eletrônico: token assinado, verificação no webhook e retenção opcional', () => {
  test('padrão de produção (tudo desligado): pedido sem aceite é emitido normalmente e registrado como ABSENT', async () => {
    flags.twoVoucher = true;
    const campaign = await newCampaign();
    const payload = paidPayload(campaign, 1);
    await runAt(service(), payload, PAID_AT());
    expect((await lastEvidence(String(payload.id)))?.status).toBe('ABSENT');
    expect(await vouchersOf(String(payload.id))).toHaveLength(2);
    expect(await holdsOf(String(payload.id))).toHaveLength(0);
  });

  test('aceite válido: VERIFIED (versão, hash, emissão, verificação), sem dado pessoal; com a exigência ligada o pedido é emitido', async () => {
    flags.twoVoucher = true;
    configure({ VALE_PASS_TERMS_REQUIRED: 'on' });
    const campaign = await newCampaign();
    const payload = withToken(paidPayload(campaign, 1), mint(campaign));
    await runAt(service(), payload, PAID_AT());
    const orderId = String(payload.id);
    const detail = await lastEvidence(orderId);
    expect(detail).toMatchObject({ status: 'VERIFIED', version: '2027-1', sha256: SHA, source: 'signed_token' });
    expect(typeof detail?.verifiedAt).toBe('string');
    expect(JSON.stringify(detail)).not.toMatch(/@|Cliente|Sintético/);
    expect(await vouchersOf(orderId)).toHaveLength(2);
    expect(await holdsOf(orderId)).toHaveLength(0);
    const view = await new ValePassTermsAcceptanceService(prisma, () => termsConfig).evidenceFor(orderId);
    expect(view).toMatchObject({ proven: true, status: 'VERIFIED' });
    expect(JSON.stringify(view)).not.toMatch(/@|Cliente|Sintético|VALLE-/);
  });

  test('exigência ligada e SEM aceite: pedido pago fica RETIDO antes da emissão (nenhum voucher), sem cancelar nem reembolsar', async () => {
    flags.twoVoucher = true;
    configure({ VALE_PASS_TERMS_REQUIRED: 'on' });
    const campaign = await newCampaign();
    const payload = paidPayload(campaign, 1);
    await runAt(service(), payload, PAID_AT());
    const orderId = String(payload.id);
    expect(await vouchersOf(orderId)).toHaveLength(0);
    const holds = await holdsOf(orderId);
    expect(holds).toHaveLength(1);
    expect(holds[0].status).toBe('OPEN');
    expect(await heldCodes(orderId)).toContain('TERMS_ACCEPTANCE_REQUIRED');
    const registry = await prisma.valePassOrder.findUniqueOrThrow({ where: { shopifyOrderId: orderId } });
    expect(registry.status).toBe('CONFIRMED');
    expect(await prisma.valePassOrderCancellation.count({ where: { shopifyOrderId: orderId } })).toBe(0);
    expect(await prisma.valePassRefundApplication.count({ where: { shopifyOrderId: orderId } })).toBe(0);
    expect((await new ValePassTermsAcceptanceService(prisma, () => termsConfig).evidenceFor(orderId)).proven).toBe(false);
  });

  test.each([
    ['adulterado', (t: string) => `${t.slice(0, -3)}AAA`, 'bad_signature'],
    ['malformado', () => 'vp1.lixo.lixo', 'bad_signature'],
  ])('token %s: REJECTED e, com a exigência ligada, retenção', async (_label, mutate, reason) => {
    flags.twoVoucher = true;
    configure({ VALE_PASS_TERMS_REQUIRED: 'on' });
    const campaign = await newCampaign();
    const payload = withToken(paidPayload(campaign, 1), mutate(mint(campaign)));
    await runAt(service(), payload, PAID_AT());
    const orderId = String(payload.id);
    expect(await lastEvidence(orderId)).toMatchObject({ status: 'REJECTED', reason });
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect(await heldCodes(orderId)).toContain('TERMS_ACCEPTANCE_REQUIRED');
  });

  test.each([
    ['expirado', { now: new Date(Date.now() - 10 * 3_600_000), ttlMs: 3_600_000 }, 'expired'],
    ['versão incorreta', { version: '2026-9' }, 'version_mismatch'],
    ['hash de documento não aprovado', { sha256: 'cd'.repeat(32) }, 'hash_mismatch'],
    ['variante de outro produto', { variant: '555' }, 'variant_mismatch'],
  ])('token %s: REJECTED com o motivo certo, sem emitir quando a exigência está ligada', async (_label, over, reason) => {
    flags.twoVoucher = true;
    configure({ VALE_PASS_TERMS_REQUIRED: 'on' });
    const campaign = await newCampaign();
    const payload = withToken(paidPayload(campaign, 1), mint(campaign, over));
    await runAt(service(), payload, PAID_AT());
    const orderId = String(payload.id);
    expect(await lastEvidence(orderId)).toMatchObject({ status: 'REJECTED', reason });
    expect(await vouchersOf(orderId)).toHaveLength(0);
  });

  test('sem exigência ligada, o token inválido é só registrado: a emissão segue (nada muda para a venda)', async () => {
    flags.twoVoucher = true;
    configure();
    const campaign = await newCampaign();
    const payload = withToken(paidPayload(campaign, 1), mint(campaign, { version: '2026-9' }));
    await runAt(service(), payload, PAID_AT());
    expect(await lastEvidence(String(payload.id))).toMatchObject({ status: 'REJECTED', reason: 'version_mismatch' });
    expect(await vouchersOf(String(payload.id))).toHaveLength(2);
  });

  test('tentativa de burlar: atributos declarados (versão + instante) NÃO bastam para a exigência — só o token assinado', async () => {
    flags.twoVoucher = true;
    configure({ VALE_PASS_TERMS_REQUIRED: 'on' });
    const campaign = await newCampaign();
    const payload = withAttrs(paidPayload(campaign, 1), [
      { name: 'valle_pass_terms_version', value: '2027-1' },
      { name: 'valle_pass_terms_accepted_at', value: new Date(Date.now() - 30_000).toISOString() },
    ]);
    await runAt(service(), payload, PAID_AT());
    const orderId = String(payload.id);
    expect((await lastEvidence(orderId))?.status).toBe('DECLARED');
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect(await heldCodes(orderId)).toContain('TERMS_ACCEPTANCE_REQUIRED');
  });

  test('falha segura: exigência ligada com a configuração incompleta retém (não lança, não emite) e o token vira REJECTED not_configured', async () => {
    flags.twoVoucher = true;
    configure({ VALE_PASS_TERMS_REQUIRED: 'on', VALE_PASS_TERMS_TOKEN_SECRET: undefined });
    const campaign = await newCampaign();
    const payload = withToken(paidPayload(campaign, 1), mint(campaign));
    await expect(runAt(service(), payload, PAID_AT())).resolves.toBeDefined();
    const orderId = String(payload.id);
    expect(await lastEvidence(orderId)).toMatchObject({ status: 'REJECTED', reason: 'not_configured' });
    expect(await vouchersOf(orderId)).toHaveLength(0);
    expect(await holdsOf(orderId)).toHaveLength(1);
  });

  test('token reutilizado em OUTRO pedido: o primeiro é VERIFIED, o segundo REJECTED reused (e retido com a exigência ligada)', async () => {
    flags.twoVoucher = true;
    configure({ VALE_PASS_TERMS_REQUIRED: 'on' });
    const campaign = await newCampaign();
    const token = mint(campaign);
    const a = withToken(paidPayload(campaign, 1), token);
    const b = withToken(paidPayload(campaign, 1), token);
    await runAt(service(), a, PAID_AT());
    await runAt(service(), b, PAID_AT());
    expect((await lastEvidence(String(a.id)))?.status).toBe('VERIFIED');
    expect(await lastEvidence(String(b.id))).toMatchObject({ status: 'REJECTED', reason: 'reused' });
    expect(await vouchersOf(String(a.id))).toHaveLength(2);
    expect(await vouchersOf(String(b.id))).toHaveLength(0);
    expect(await heldCodes(String(b.id))).toContain('TERMS_ACCEPTANCE_REQUIRED');
  });

  test('dois pedidos SIMULTÂNEOS com o mesmo token: exatamente um é VERIFIED', async () => {
    flags.twoVoucher = true;
    configure();
    const campaign = await newCampaign();
    const token = mint(campaign);
    const a = withToken(paidPayload(campaign, 1), token);
    const b = withToken(paidPayload(campaign, 1), token);
    await Promise.all([runAt(service(), a, PAID_AT()), runAt(service(), b, PAID_AT())]);
    const statuses = [(await lastEvidence(String(a.id)))?.status, (await lastEvidence(String(b.id)))?.status].sort();
    expect(statuses).toEqual(['REJECTED', 'VERIFIED']);
  });

  test('webhook duplicado (reentrega e simultâneo) do MESMO pedido: um único registro, continua VERIFIED e não vira "reused"', async () => {
    flags.twoVoucher = true;
    configure({ VALE_PASS_TERMS_REQUIRED: 'on' });
    const campaign = await newCampaign();
    const payload = withToken(paidPayload(campaign, 1), mint(campaign));
    const at = PAID_AT();
    await runAt(service(), payload, at);
    await runAt(service(), payload, at);
    await Promise.all([runAt(service(), payload, at), runAt(service(), payload, at)]);
    const orderId = String(payload.id);
    expect(await eventsOf(orderId)).toHaveLength(1);
    expect((await lastEvidence(orderId))?.status).toBe('VERIFIED');
    expect(await vouchersOf(orderId)).toHaveLength(2);
  });

  test('evidência de outro pedido (token emitido para outra variante) não vale', async () => {
    flags.twoVoucher = true;
    configure({ VALE_PASS_TERMS_REQUIRED: 'on' });
    const campaignA = await newCampaign();
    const campaignB = await newCampaign();
    const payload = withToken(paidPayload(campaignA, 1), mint(campaignB));
    await runAt(service(), payload, PAID_AT());
    expect(await lastEvidence(String(payload.id))).toMatchObject({ status: 'REJECTED', reason: 'variant_mismatch' });
    expect(await vouchersOf(String(payload.id))).toHaveLength(0);
  });

  test('uso único sob corrida DETERMINÍSTICA: com o pedido A ainda aberto, o pedido B espera o lock do nonce e, ao entrar, vê o A e é REJECTED reused', async () => {
    configure();
    const campaign = await newCampaign();
    const token = mint(campaign);
    const pa = withToken(paidPayload(campaign, 1), token);
    const pb = withToken(paidPayload(campaign, 1), token);
    const register = (payload: Record<string, unknown>) =>
      prisma.valePassOrder.create({ data: { shopifyOrderId: String(payload.id), shopifyOrderName: String(payload.name), status: 'CONFIRMED', financialStatus: 'paid', quantity: 1, lastSyncSource: 'teste' } });
    const [regA, regB] = [await register(pa), await register(pb)];
    const flow = new ValePassPaymentFlowService(new ValePassFinancialGuard(), issuance, outbox, flagFns, prisma, regularization, () => termsConfig) as unknown as {
      recordTermsEvidence(tx: unknown, id: string, payload: unknown): Promise<{ status: string; reason?: string }>;
    };
    let releaseA!: () => void;
    const aMayCommit = new Promise<void>((resolve) => { releaseA = resolve; });
    let aRecorded!: () => void;
    const aIsReady = new Promise<void>((resolve) => { aRecorded = resolve; });
    const txA = prisma.$transaction(async (tx) => {
      const evidence = await flow.recordTermsEvidence(tx, regA.id, pa);
      aRecorded();
      await aMayCommit;
      return evidence;
    }, { timeout: 30_000, maxWait: 20_000 });
    await aIsReady;
    let bFinished = false;
    const txB = prisma.$transaction((tx) => flow.recordTermsEvidence(tx, regB.id, pb), { timeout: 30_000, maxWait: 20_000 }).then((evidence) => { bFinished = true; return evidence; });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(bFinished).toBe(false); // preso no lock enquanto o A não confirma
    releaseA();
    const [a, b] = await Promise.all([txA, txB]);
    expect(a.status).toBe('VERIFIED');
    expect(b).toMatchObject({ status: 'REJECTED', reason: 'reused' });
  });
});
