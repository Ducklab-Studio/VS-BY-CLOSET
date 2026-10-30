import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { ValePassCampaign } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { REQUIRE_ROLE_KEY } from '../../admin/require-role.decorator';
import { lockShopifyOrder } from '../../webhooks/shopify-order-lock';
import { purgeLedgerForTest } from '../ledger/ledger-test-utils';
import { ValePassIssuanceService } from '../vale-pass-issuance.service';
import { MAX_ALLOWED_RECIPIENTS, canSendLive, liveBlockers, loadEmailConfig, parseAllowedRecipients, publicEmailStatus, recipientAllowed, type EmailConfig } from './email-config';
import type { EmailProvider, SendEmailInput, SendEmailResult } from './email-provider';
import { ValePassEmailOutboxService } from './email-outbox.service';
import { ValePassEmailWorkerService } from './email-worker.service';
import { ValePassEmailController } from './email.controller';

/**
 * Lista de destinatários autorizados (VALE_PASS_EMAIL_ALLOWED_RECIPIENTS) e prévia administrativa, em PostgreSQL LOCAL descartável.
 * NENHUMA rede: o `fetch` global falha o teste e o provedor é simulado. Linhas COMMITADAS com prefixo exclusivo.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const ALLOWED = 'teste-autorizado@exemplo.invalid';
const OTHER = 'cliente-comum@exemplo.invalid';

// ---------- configuração (puro: não precisa de banco) ----------
describe('VALE_PASS_EMAIL_ALLOWED_RECIPIENTS — leitura e validação da configuração', () => {
  const base = { VALE_PASS_EMAIL_MODE: 'live', RESEND_API_KEY: 're_test_key', VALE_PASS_EMAIL_DOMAIN_VERIFIED: 'true' };

  test('FASE DE TESTES: live sem lista e sem liberação comercial = BLOQUEADO (fail closed), ninguém é permitido', () => {
    const config = loadEmailConfig(base);
    expect(config.allowedRecipients).toBeNull();
    expect(config.commercialRelease).toBe(false);
    expect(recipientAllowed(config, OTHER)).toBe(false);
    expect(canSendLive(config)).toBe(false);
    expect(liveBlockers(config).join(' ')).toContain('VALE_PASS_EMAIL_COMMERCIAL_RELEASE');
    expect(publicEmailStatus(config)).toMatchObject({ canSend: false, commercialRelease: false, recipientAllowlist: { active: false } });
  });

  test('só a liberação comercial explícita (exatamente "true") libera o envio sem lista', () => {
    for (const raw of ['', 'false', '1', 'yes', 'on', 'verdadeiro']) expect(canSendLive(loadEmailConfig({ ...base, VALE_PASS_EMAIL_COMMERCIAL_RELEASE: raw })), raw).toBe(false);
    const released = loadEmailConfig({ ...base, VALE_PASS_EMAIL_COMMERCIAL_RELEASE: ' TRUE ' });
    expect(canSendLive(released)).toBe(true);
    expect(recipientAllowed(released, OTHER)).toBe(true);
  });

  test('lista presente SEMPRE restringe, mesmo com a liberação; lista inválida nunca é ignorada pela liberação', () => {
    const both = loadEmailConfig({ ...base, VALE_PASS_EMAIL_COMMERCIAL_RELEASE: 'true', VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: ALLOWED });
    expect(recipientAllowed(both, ALLOWED)).toBe(true);
    expect(recipientAllowed(both, OTHER)).toBe(false);
    const invalid = loadEmailConfig({ ...base, VALE_PASS_EMAIL_COMMERCIAL_RELEASE: 'true', VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: 'lixo' });
    expect(canSendLive(invalid)).toBe(false);
    expect(recipientAllowed(invalid, ALLOWED)).toBe(false);
    expect(recipientAllowed(invalid, OTHER)).toBe(false);
  });

  test('lista válida: normaliza (minúsculas, sem repetição), aceita vírgula, ponto e vírgula e espaço', () => {
    const config = loadEmailConfig({ ...base, VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: ` A@Exemplo.invalid; b@exemplo.invalid,a@exemplo.INVALID \n c@exemplo.invalid ` });
    expect(config.allowedRecipients).toEqual(['a@exemplo.invalid', 'b@exemplo.invalid', 'c@exemplo.invalid']);
    expect(liveBlockers(config)).toEqual([]);
    expect(recipientAllowed(config, 'A@EXEMPLO.invalid')).toBe(true);
    expect(recipientAllowed(config, 'd@exemplo.invalid')).toBe(false);
    expect(recipientAllowed(config, '')).toBe(false);
    expect(recipientAllowed(config, null)).toBe(false);
  });

  test.each([
    ['vazia', ''],
    ['só espaços e separadores', ' ; , '],
    ['item sem arroba', 'abc'],
    ['nome + endereço', 'Maria <maria@exemplo.invalid>'],
    ['curinga', '*@exemplo.invalid'],
    ['domínio inteiro', '@exemplo.invalid'],
    ['um válido e um inválido', `${ALLOWED}, lixo`],
  ])('configuração inválida (%s) = FALHA FECHADA: ninguém passa e o envio real fica bloqueado', (_name, raw) => {
    const config = loadEmailConfig({ ...base, VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: raw });
    expect(config.allowlistProblems.length).toBeGreaterThan(0);
    expect(config.allowedRecipients).toEqual([]);
    expect(recipientAllowed(config, ALLOWED)).toBe(false);
    expect(liveBlockers(config).join(' ')).toContain('VALE_PASS_EMAIL_ALLOWED_RECIPIENTS');
  });

  test('mais endereços que o máximo = inválida', () => {
    const many = Array.from({ length: MAX_ALLOWED_RECIPIENTS + 1 }, (_v, index) => `u${index}@exemplo.invalid`).join(',');
    expect(parseAllowedRecipients(many).allowlistProblems.length).toBeGreaterThan(0);
    const exact = Array.from({ length: MAX_ALLOWED_RECIPIENTS }, (_v, index) => `u${index}@exemplo.invalid`).join(',');
    expect(parseAllowedRecipients(exact).allowlistProblems).toEqual([]);
  });

  test('o status público informa estado e quantidade, nunca os endereços nem o valor inválido', () => {
    const ok = JSON.stringify(publicEmailStatus(loadEmailConfig({ ...base, VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: ALLOWED })));
    expect(ok).toContain('"recipientAllowlist":{"active":true,"size":1,"valid":true}');
    expect(ok).not.toContain('exemplo.invalid');
    const bad = publicEmailStatus(loadEmailConfig({ ...base, VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: 'segredo-invalido' }));
    expect(JSON.stringify(bad)).not.toContain('segredo-invalido');
    expect(bad.canSend).toBe(false);
  });
});

// ---------- worker, reenvio e prévia (banco local) ----------
const prisma = new PrismaService();
const issuance = new ValePassIssuanceService();
const TAG = `VPAL-${Date.now()}`;
let counter = 0;
let adminId: string;
const campaignIds: string[] = [];
const orderIds: string[] = [];
const HOUR = 3_600_000;

let messageSeq = 0;

class MockProvider implements EmailProvider {
  readonly calls: SendEmailInput[] = [];
  delayMs = 0;
  private readonly byKey = new Map<string, string>();
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    this.calls.push(input);
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    let id = this.byKey.get(input.idempotencyKey);
    if (!id) {
      id = `em_${TAG}_${++messageSeq}`; // único no banco inteiro (providerMessageId é único)
      this.byKey.set(input.idempotencyKey, id);
    }
    return { kind: 'accepted', messageId: id };
  }
}

const config = (over: Record<string, string | undefined> = {}): EmailConfig =>
  loadEmailConfig({ VALE_PASS_EMAIL_MODE: 'live', RESEND_API_KEY: 're_test_key', VALE_PASS_EMAIL_DOMAIN_VERIFIED: 'true', VALE_PASS_EMAIL_DAILY_LIMIT: '1000', ...(over as Record<string, string>) });

function stack(cfg: EmailConfig, provider: MockProvider = new MockProvider()) {
  const outbox = new ValePassEmailOutboxService(prisma, cfg);
  const worker = new ValePassEmailWorkerService(prisma, outbox, cfg, provider);
  worker.rng = () => 0.5;
  return { outbox, worker, provider };
}

async function newCampaign(): Promise<ValePassCampaign> {
  const campaign = await prisma.valePassCampaign.create({
    data: {
      name: `${TAG}-camp-${counter++}`, amountCents: 35_000, validityDays: 30, globalLimit: 1_000, shopifyVariantId: `${TAG}-var-${counter++}`,
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
  return campaign;
}

/** Pedido PAGO com 2 vouchers emitidos pelo emissor real, SEM enfileirar. */
async function paidOrder(email: string): Promise<{ orderId: string; groupId: string }> {
  const campaign = await newCampaign();
  const orderId = `${TAG}-o${counter++}`;
  orderIds.push(orderId);
  await prisma.valePassOrder.create({
    data: {
      shopifyOrderId: orderId, shopifyOrderGid: `gid://shopify/Order/${orderId}`, shopifyOrderName: `${TAG}#${counter}`, status: 'CONFIRMED', financialStatus: 'paid',
      quantity: 1, customerName: 'Maria Souza Sintética', customerEmail: email, customerPhone: '+5500000000000', lastSyncSource: 'teste',
      orderCreatedAt: new Date(Date.now() - HOUR), statusChangedAt: new Date(Date.now() - HOUR), vouchersProcessedAt: new Date(),
    },
  });
  await prisma.$transaction(async (tx) => {
    await lockShopifyOrder(tx, orderId);
    await issuance.issueForCampaign(tx, {
      campaignId: campaign.id,
      order: { orderId, orderGid: `gid://shopify/Order/${orderId}`, orderName: `${TAG}#${counter}`, customerName: 'Maria Souza Sintética', customerPhone: '+5500000000000', customerEmail: email },
      units: 1,
      mode: 'enforce',
    });
  });
  const voucher = await prisma.valePass.findFirstOrThrow({ where: { shopifyOrderId: orderId }, select: { groupId: true } });
  return { orderId, groupId: voucher.groupId as string };
}

const enqueue = (outbox: ValePassEmailOutboxService, orderId: string) =>
  prisma.$transaction(async (tx) => {
    await lockShopifyOrder(tx, orderId);
    return outbox.enqueueForOrder(tx, orderId, new Date());
  });
const rowOf = (orderId: string) => prisma.valePassEmailOutbox.findFirstOrThrow({ where: { shopifyOrderId: orderId, kind: 'INITIAL' } });
const codesOf = async (groupId: string) => (await prisma.valePass.findMany({ where: { groupId }, select: { code: true } })).map((v) => v.code);
const soon = () => new Date(Date.now() + 5_000);

beforeAll(async () => {
  if (!localDatabase) return;
  adminId = (await prisma.adminUser.create({ data: { name: 'Admin Teste Allowlist', phone: `${TAG}-admin`, pinHash: 'x', role: 'ADMIN', active: true } })).id;
  vi.stubGlobal('fetch', () => {
    throw new Error('REDE REAL PROIBIDA NOS TESTES DE E-MAIL');
  });
});

async function cleanRows() {
  const ids = campaignIds.splice(0);
  const orders = orderIds.splice(0);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.valePassEmailEvent.deleteMany({ where: { outbox: { campaignId: { in: ids } } } });
    await tx.valePassEmailOutbox.deleteMany({ where: { campaignId: { in: ids } } });
    const vouchers = await tx.valePass.findMany({ where: { campaignId: { in: ids } }, select: { id: true } });
    await tx.valePassEvent.deleteMany({ where: { valePassId: { in: vouchers.map((v) => v.id) } } });
    await purgeLedgerForTest(tx, { campaignIds: ids });
    await tx.valePass.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassIssuanceHold.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaignBenefit.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaign.deleteMany({ where: { id: { in: ids } } });
    await tx.valePassOrderCancellation.deleteMany({ where: { shopifyOrderId: { in: orders } } });
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
  vi.unstubAllGlobals();
  await prisma.$disconnect();
});

localDescribe('Lista de destinatários autorizados — worker', () => {
  test('destinatário permitido: sai (uma chamada ao provedor, para ele) com os DOIS vouchers', async () => {
    const { outbox, worker, provider } = stack(config({ VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: ALLOWED }));
    const { orderId, groupId } = await paidOrder(ALLOWED);
    await enqueue(outbox, orderId);
    const report = await worker.tick(soon());
    expect(report).toMatchObject({ claimed: 1, accepted: 1, heldByAllowlist: 0 });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].to).toBe(ALLOWED);
    const codes = await codesOf(groupId);
    expect(codes).toHaveLength(2);
    for (const code of codes) expect(provider.calls[0].html).toContain(code);
    expect((await rowOf(orderId)).status).toBe('ACCEPTED');
  });

  test('comparação sem diferenciar maiúsculas: cliente digitou o e-mail com outra caixa', async () => {
    const { outbox, worker, provider } = stack(config({ VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: ALLOWED }));
    const { orderId } = await paidOrder('Teste-Autorizado@Exemplo.INVALID');
    await enqueue(outbox, orderId);
    await worker.tick(soon());
    expect(provider.calls).toHaveLength(1);
  });

  test('destinatário NÃO permitido: nenhuma chamada ao provedor e a mensagem fica na fila, intacta', async () => {
    const { outbox, worker, provider } = stack(config({ VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: ALLOWED }));
    const { orderId } = await paidOrder(OTHER);
    await enqueue(outbox, orderId);
    const before = await rowOf(orderId);
    const events = await prisma.valePassEmailEvent.count({ where: { outboxId: before.id } });
    const report = await worker.tick(soon());
    expect(report).toMatchObject({ claimed: 0, accepted: 0, heldByAllowlist: 1 });
    expect(provider.calls).toHaveLength(0);
    const after = await rowOf(orderId);
    expect(after).toMatchObject({ status: 'QUEUED', attempts: 0, lockedUntil: null, providerMessageId: null, acceptedAt: null, firstAttemptAt: null, toEmail: OTHER });
    expect(after.idempotencyKey).toBe(before.idempotencyKey);
    expect(await prisma.valePassEmailEvent.count({ where: { outboxId: before.id } })).toBe(events);
  });

  test('misto: só o autorizado sai; o outro continua na fila mesmo após vários ciclos (idempotente)', async () => {
    const { outbox, worker, provider } = stack(config({ VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: ALLOWED }));
    const ok = await paidOrder(ALLOWED);
    const blocked = await paidOrder(OTHER);
    await enqueue(outbox, ok.orderId);
    await enqueue(outbox, blocked.orderId);
    for (let i = 0; i < 3; i++) await worker.tick(soon());
    expect(provider.calls.map((call) => call.to)).toEqual([ALLOWED]);
    expect((await rowOf(ok.orderId)).status).toBe('ACCEPTED');
    expect(await rowOf(blocked.orderId)).toMatchObject({ status: 'QUEUED', attempts: 0 });
  });

  test('lista vazia ou inválida: nada é enviado, nem para quem seria "permitido"; mensagens preservadas', async () => {
    for (const raw of ['', 'lixo', `${ALLOWED}, lixo`]) {
      const { outbox, worker, provider } = stack(config({ VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: raw }));
      const { orderId } = await paidOrder(ALLOWED);
      await enqueue(outbox, orderId);
      const report = await worker.tick(soon());
      expect(report.blocked.join(' ')).toContain('VALE_PASS_EMAIL_ALLOWED_RECIPIENTS');
      expect(report.claimed).toBe(0);
      expect(provider.calls).toHaveLength(0);
      expect(await rowOf(orderId)).toMatchObject({ status: 'QUEUED', attempts: 0 });
      await cleanRows();
    }
  });

  test('defesa em profundidade: mesmo que a reserva seja forçada, processOne não chama o provedor e devolve a reserva', async () => {
    const { outbox, worker, provider } = stack(config({ VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: ALLOWED }));
    const { orderId } = await paidOrder(OTHER);
    await enqueue(outbox, orderId);
    const row = await rowOf(orderId);
    await prisma.valePassEmailOutbox.update({ where: { id: row.id }, data: { lockedUntil: new Date(Date.now() + 60_000) } });
    expect(await worker.processOne(row.id, new Date())).toBe('retrying');
    expect(provider.calls).toHaveLength(0);
    expect(await rowOf(orderId)).toMatchObject({ status: 'QUEUED', attempts: 0, lockedUntil: null });
  });

  test('concorrência: dois workers ao mesmo tempo enviam o autorizado UMA vez e nunca o não autorizado', async () => {
    const cfg = config({ VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: ALLOWED });
    const provider = new MockProvider();
    provider.delayMs = 60;
    const a = stack(cfg, provider);
    const b = stack(cfg, provider);
    const ok = await paidOrder(ALLOWED);
    const blocked = await paidOrder(OTHER);
    await enqueue(a.outbox, ok.orderId);
    await enqueue(a.outbox, blocked.orderId);
    await Promise.all([a.worker.tick(soon()), b.worker.tick(soon()), a.worker.tick(soon())]);
    expect(provider.calls.map((call) => call.to)).toEqual([ALLOWED]);
    expect((await rowOf(blocked.orderId)).status).toBe('QUEUED');
  });

  test('AUSÊNCIA da lista em live: nada é enviado e a mensagem fica QUEUED intacta (fail closed)', async () => {
    const { outbox, worker, provider } = stack(config());
    const { orderId } = await paidOrder(OTHER);
    await enqueue(outbox, orderId);
    const report = await worker.tick(soon());
    expect(report.blocked.join(' ')).toContain('VALE_PASS_EMAIL_COMMERCIAL_RELEASE');
    expect(report.claimed).toBe(0);
    expect(provider.calls).toHaveLength(0);
    expect(await rowOf(orderId)).toMatchObject({ status: 'QUEUED', attempts: 0, lockedUntil: null, toEmail: OTHER });
    // mesmo forçando a reserva e o processamento, o provedor não é chamado
    const row = await rowOf(orderId);
    await prisma.valePassEmailOutbox.update({ where: { id: row.id }, data: { lockedUntil: new Date(Date.now() + 60_000) } });
    expect(await worker.processOne(row.id, new Date())).toBe('retrying');
    expect(provider.calls).toHaveLength(0);
    expect(await rowOf(orderId)).toMatchObject({ status: 'QUEUED', attempts: 0, lockedUntil: null });
  });

  test('REMOÇÃO da lista: as mensagens retidas NÃO são liberadas; só a liberação comercial explícita as libera', async () => {
    const guarded = stack(config({ VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: ALLOWED }));
    const { orderId } = await paidOrder(OTHER);
    await enqueue(guarded.outbox, orderId);
    await guarded.worker.tick(soon());
    expect(guarded.provider.calls).toHaveLength(0);
    // a variável foi removida da Railway (e nada mais mudou)
    const removed = stack(config());
    const report = await removed.worker.tick(soon());
    expect(report.claimed).toBe(0);
    expect(removed.provider.calls).toHaveLength(0);
    expect(await rowOf(orderId)).toMatchObject({ status: 'QUEUED', attempts: 0 });
    // lista trocada por uma inválida: continua tudo retido
    const broken = stack(config({ VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: ' ' }));
    expect((await broken.worker.tick(soon())).claimed).toBe(0);
    expect(broken.provider.calls).toHaveLength(0);
    // a decisão comercial é explícita e separada
    const released = stack(config({ VALE_PASS_EMAIL_COMMERCIAL_RELEASE: 'true' }));
    expect((await released.worker.tick(soon())).accepted).toBe(1);
    expect(released.provider.calls.map((call) => call.to)).toEqual([OTHER]);
  });

  test('liberação comercial + lista válida: continua enviando só aos autorizados', async () => {
    const { outbox, worker, provider } = stack(config({ VALE_PASS_EMAIL_COMMERCIAL_RELEASE: 'true', VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: ALLOWED }));
    const ok = await paidOrder(ALLOWED);
    const blocked = await paidOrder(OTHER);
    await enqueue(outbox, ok.orderId);
    await enqueue(outbox, blocked.orderId);
    await worker.tick(soon());
    expect(provider.calls.map((call) => call.to)).toEqual([ALLOWED]);
  });

  test('modo off: não enfileira nem chama o provedor; dry-run: valida e renderiza sem enviar, com ou sem lista', async () => {
    for (const mode of ['off', 'dry-run']) {
      for (const list of [undefined, ALLOWED]) {
        const { outbox, worker, provider } = stack(config({ VALE_PASS_EMAIL_MODE: mode, VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: list }));
        const { orderId } = await paidOrder(OTHER);
        const report = await worker.tick(soon());
        expect(provider.calls).toHaveLength(0);
        if (mode === 'off') {
          expect(report).toMatchObject({ enqueued: 0, dryRunReady: 0 });
          expect(await prisma.valePassEmailOutbox.count({ where: { shopifyOrderId: orderId } })).toBe(0);
        } else {
          expect(report).toMatchObject({ enqueued: 1, dryRunReady: 1 });
          expect(await rowOf(orderId)).toMatchObject({ status: 'QUEUED', attempts: 0 });
        }
        await cleanRows();
        void outbox;
      }
    }
  });
});

localDescribe('Lista de destinatários autorizados — reenvio administrativo', () => {
  async function accepted(allowedList: string) {
    const first = stack(config({ VALE_PASS_EMAIL_COMMERCIAL_RELEASE: 'true' })); // a original saiu antes da lista existir
    const { orderId, groupId } = await paidOrder(OTHER);
    await enqueue(first.outbox, orderId);
    await first.worker.tick(soon()); // antes da lista existir: a mensagem original foi aceita
    const guarded = stack(config({ VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: allowedList }));
    return { orderId, groupId, original: await rowOf(orderId), ...guarded };
  }
  const actor = () => ({ id: adminId, name: 'Admin Teste Allowlist' });
  const note = 'Reenvio de teste controlado do envio de e-mails.';

  test('reenvio para endereço fora da lista é RECUSADO e não cria mensagem nem chama o provedor', async () => {
    const { original, outbox, orderId, provider } = await accepted(ALLOWED);
    await expect(outbox.requestResend(original.id, { note, toEmail: 'outro@exemplo.invalid' }, actor())).rejects.toBeInstanceOf(UnprocessableEntityException);
    // sem sobrescrita: o destinatário seria o do cliente (fora da lista)
    await expect(outbox.requestResend(original.id, { note }, actor())).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(await prisma.valePassEmailOutbox.count({ where: { shopifyOrderId: orderId, kind: 'RESEND' } })).toBe(0);
    expect(provider.calls).toHaveLength(1 - 1);
  });

  test('reenvio para endereço da lista é aceito e SAI apenas para ele; repetir a execução não duplica', async () => {
    const { original, outbox, worker, orderId, provider } = await accepted(ALLOWED);
    const created = await outbox.requestResend(original.id, { note, toEmail: ALLOWED.toUpperCase() }, actor());
    expect(created.status).toBe('QUEUED');
    await worker.tick(soon());
    await worker.tick(soon());
    expect(provider.calls.map((call) => call.to)).toEqual([ALLOWED.toUpperCase()]);
    expect((await prisma.valePassEmailOutbox.findMany({ where: { shopifyOrderId: orderId, kind: 'RESEND' } }))).toHaveLength(1);
  });

  test('AUSÊNCIA da lista em live (sem liberação): o reenvio é recusado para qualquer endereço e nada é criado', async () => {
    const { original, outbox, orderId, provider } = await accepted(ALLOWED);
    const absent = stack(config());
    await expect(absent.outbox.requestResend(original.id, { note, toEmail: ALLOWED }, actor())).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(absent.outbox.requestResend(original.id, { note }, actor())).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(await prisma.valePassEmailOutbox.count({ where: { shopifyOrderId: orderId, kind: 'RESEND' } })).toBe(0);
    void outbox; void provider;
  });

  test('dry-run sem lista: o reenvio segue como antes (a mensagem é criada e nunca enviada); com lista, a regra vale', async () => {
    const { original, orderId } = await accepted(ALLOWED);
    const dry = stack(config({ VALE_PASS_EMAIL_MODE: 'dry-run' }));
    const created = await dry.outbox.requestResend(original.id, { note, toEmail: 'qualquer@exemplo.invalid' }, actor());
    expect(created.status).toBe('QUEUED');
    await dry.worker.tick(soon());
    expect(dry.provider.calls).toHaveLength(0);
    const dryGuarded = stack(config({ VALE_PASS_EMAIL_MODE: 'dry-run', VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: ALLOWED }));
    await expect(dryGuarded.outbox.requestResend(original.id, { note, toEmail: 'outro@exemplo.invalid' }, actor())).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(await prisma.valePassEmailOutbox.count({ where: { shopifyOrderId: orderId, kind: 'RESEND' } })).toBe(1);
  });

  test('lista inválida: o reenvio é recusado para qualquer endereço', async () => {
    const { original, outbox } = await accepted('lixo');
    await expect(outbox.requestResend(original.id, { note, toEmail: ALLOWED }, actor())).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

localDescribe('Prévia administrativa do e-mail', () => {
  test('mostra o MESMO modelo com os códigos mascarados, sem enviar nem gravar', async () => {
    const { outbox, worker, provider } = stack(config({ VALE_PASS_EMAIL_MODE: 'dry-run', VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: ALLOWED }));
    const { orderId, groupId } = await paidOrder(OTHER);
    await enqueue(outbox, orderId);
    const row = await rowOf(orderId);
    const eventsBefore = await prisma.valePassEmailEvent.count({ where: { outboxId: row.id } });
    const preview = await outbox.preview(row.id);
    const codes = await codesOf(groupId);
    expect(codes).toHaveLength(2);
    for (const code of codes) {
      expect(preview.html).not.toContain(code);
      expect(preview.text).not.toContain(code);
    }
    expect(preview.codesMasked).toEqual(['VALLE-****-****', 'VALLE-****-****']);
    for (const code of codes) {
      for (const secret of code.split('-').slice(1)) {
        expect(preview.html).not.toContain(secret);
        expect(preview.text).not.toContain(secret);
        expect(JSON.stringify(preview)).not.toContain(secret);
      }
    }
    expect(preview.html).toContain('VALLE-****-****');
    // só o primeiro nome do cliente, nunca o nome completo
    expect(preview.html).toContain('Maria');
    expect(preview.html + preview.text).not.toMatch(/Souza|Sint[ée]tica/);
    expect(preview.html).toContain('Valle Showroom');
    expect(preview.html).toContain('VS BY CLOSET');
    expect(preview.toMasked).toBe('c***@exemplo.invalid');
    expect(JSON.stringify(preview)).not.toContain(OTHER);
    expect(preview.recipientAllowed).toBe(false);
    expect(provider.calls).toHaveLength(0);
    expect(await prisma.valePassEmailEvent.count({ where: { outboxId: row.id } })).toBe(eventsBefore);
    expect(await rowOf(orderId)).toMatchObject({ status: 'QUEUED', attempts: 0, lockedUntil: null });
    void worker;
  });

  test('mensagem inexistente = 404; pedido não pago / voucher cancelado = 409 sem prévia', async () => {
    const { outbox } = stack(config({ VALE_PASS_EMAIL_MODE: 'dry-run' }));
    await expect(outbox.preview('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(NotFoundException);
    const { orderId } = await paidOrder(OTHER);
    await enqueue(outbox, orderId);
    const row = await rowOf(orderId);
    await prisma.valePass.updateMany({ where: { shopifyOrderId: orderId }, data: { status: 'CANCELLED' } });
    await expect(outbox.preview(row.id)).rejects.toBeInstanceOf(ConflictException);
  });

  test('só ADMIN acessa a prévia (guardas de rota) e o resumo informa a lista sem expor endereços', async () => {
    const proto = ValePassEmailController.prototype as unknown as Record<string, unknown>;
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto.preview as object)).toBe('ADMIN');
    expect(Reflect.getMetadata('__httpMethod__', proto.preview as object) ?? 0).toBeDefined();
    const { outbox } = stack(config({ VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: ALLOWED }));
    const summary = await outbox.summary();
    expect(summary.alerts.map((alert) => alert.code)).toContain('EMAIL_RECIPIENT_ALLOWLIST');
    expect(JSON.stringify(summary)).not.toContain(ALLOWED);
    const noList = await stack(config()).outbox.summary();
    expect(noList.alerts.find((alert) => alert.code === 'EMAIL_NO_RECIPIENT_ALLOWLIST')?.severity).toBe('critical');
    expect(noList.config).toMatchObject({ canSend: false, commercialRelease: false });
    const offSummary = await stack(config({ VALE_PASS_EMAIL_MODE: 'off' })).outbox.summary();
    expect(offSummary.alerts.map((alert) => alert.code)).not.toContain('EMAIL_NO_RECIPIENT_ALLOWLIST');
    const invalid = await stack(config({ VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: 'lixo' })).outbox.summary();
    expect(invalid.alerts.find((alert) => alert.code === 'EMAIL_RECIPIENT_ALLOWLIST_INVALID')?.severity).toBe('critical');
  });
});
