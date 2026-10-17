import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException, ForbiddenException, Logger, UnprocessableEntityException } from '@nestjs/common';
import type { ValePassCampaign } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { REQUIRE_ROLE_KEY } from '../../admin/require-role.decorator';
import { lockShopifyOrder } from '../../webhooks/shopify-order-lock';
import { ValePassIssuanceService } from '../vale-pass-issuance.service';
import { ValePassWebhookService } from '../vale-pass-webhook.service';
import { loadEmailConfig, type EmailConfig } from './email-config';
import type { EmailProvider, SendEmailInput, SendEmailResult } from './email-provider';
import { ValePassEmailOutboxService } from './email-outbox.service';
import { ValePassEmailWorkerService } from './email-worker.service';
import { ValePassEmailController } from './email.controller';

/**
 * Caixa de saída dos e-mails de vouchers, em PostgreSQL LOCAL descartável. NENHUMA rede: o `fetch` global é trocado por um que falha o
 * teste, e o provedor é um simulado que imita a Resend (deduplica por Idempotency-Key). Linhas COMMITADAS com prefixo exclusivo.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const issuance = new ValePassIssuanceService();
const TAG = `VPEM-${Date.now()}`;
let counter = 0;
let adminId: string;
let staffId: string;
const ADMIN_NAME = 'Admin Teste E-mail';
const campaignIds: string[] = [];
const orderIds: string[] = [];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Imita a Resend: a mesma Idempotency-Key devolve o mesmo envio (nunca um segundo e-mail). */
class MockProvider implements EmailProvider {
  readonly calls: SendEmailInput[] = [];
  readonly script: (SendEmailResult | 'sent-but-timeout' | Error)[] = [];
  private readonly byKey = new Map<string, string>();
  readonly deliveredIds = new Set<string>();
  /** Atraso artificial por chamada (ms), para provocar concorrência real. */
  delayMs = 0;

  private deliver(input: SendEmailInput): string {
    let id = this.byKey.get(input.idempotencyKey);
    if (!id) {
      id = `em_${this.byKey.size + 1}_${Math.random().toString(36).slice(2, 8)}`;
      this.byKey.set(input.idempotencyKey, id);
    }
    this.deliveredIds.add(id);
    return id;
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    this.calls.push(input);
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const next = this.script.shift();
    if (next === 'sent-but-timeout') {
      this.deliver(input); // a Resend recebeu e enviou, mas a resposta nunca chegou
      return { kind: 'unknown', reason: 'timeout' };
    }
    if (next instanceof Error) throw next;
    if (next) return next;
    return { kind: 'accepted', messageId: this.deliver(input) };
  }
}

const liveConfig = (over: Record<string, string | undefined> = {}): EmailConfig =>
  loadEmailConfig({ VALE_PASS_EMAIL_MODE: 'live', RESEND_API_KEY: 're_test_key', VALE_PASS_EMAIL_DOMAIN_VERIFIED: 'true', VALE_PASS_EMAIL_DAILY_LIMIT: '1000', ...(over as Record<string, string>) });

function stack(config: EmailConfig, provider: MockProvider = new MockProvider()) {
  const outbox = new ValePassEmailOutboxService(prisma, config);
  const worker = new ValePassEmailWorkerService(prisma, outbox, config, provider);
  worker.rng = () => 0.5; // jitter determinístico
  return { outbox, worker, provider, config };
}

async function newCampaign(): Promise<ValePassCampaign> {
  const campaign = await prisma.valePassCampaign.create({
    data: {
      name: `${TAG}-camp-${counter++}`, amountCents: 35_000, validityDays: 30, shopifyVariantId: `${TAG}-var-${counter++}`,
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

interface Fixture { campaign: ValePassCampaign; orderId: string; groupIds: string[]; email: string }

/** Pedido PAGO com `units` unidades JÁ emitidas (2 vouchers cada) pelo emissor real. Não enfileira nada. */
async function paidOrder(units: number, options: { email?: string | null; confirmedAgoMs?: number; campaign?: ValePassCampaign } = {}): Promise<Fixture> {
  const campaign = options.campaign ?? (await newCampaign());
  const orderId = `${TAG}-o${counter++}`;
  orderIds.push(orderId);
  const email = options.email === undefined ? `cliente-${counter}@exemplo.invalid` : options.email;
  await prisma.valePassOrder.create({
    data: {
      shopifyOrderId: orderId, shopifyOrderGid: `gid://shopify/Order/${orderId}`, shopifyOrderName: `${TAG}#${counter}`, status: 'CONFIRMED', financialStatus: 'paid',
      quantity: units, customerName: 'Maria Souza Sintética', customerEmail: email, customerPhone: '+5500000000000', lastSyncSource: 'teste',
      orderCreatedAt: new Date(Date.now() - (options.confirmedAgoMs ?? HOUR)), statusChangedAt: new Date(Date.now() - (options.confirmedAgoMs ?? HOUR)), vouchersProcessedAt: new Date(),
    },
  });
  await prisma.$transaction(async (tx) => {
    await lockShopifyOrder(tx, orderId);
    await issuance.issueForCampaign(tx, {
      campaignId: campaign.id,
      order: { orderId, orderGid: `gid://shopify/Order/${orderId}`, orderName: `${TAG}#${counter}`, customerName: 'Maria Souza Sintética', customerPhone: '+5500000000000', customerEmail: email },
      units,
      mode: 'enforce',
    });
  });
  const groups = await prisma.valePass.groupBy({ by: ['groupId'], where: { shopifyOrderId: orderId }, _min: { createdAt: true } });
  const groupIds = groups.sort((a, b) => a._min.createdAt!.getTime() - b._min.createdAt!.getTime()).map((g) => g.groupId as string);
  return { campaign, orderId, groupIds, email: email ?? '' };
}

/** Remove um voucher da unidade (com o histórico dele), para simular emissão parcial. */
async function dropVoucher(groupId: string, company: 'VALLE_SHOWROOM' | 'VS_BY_CLOSET') {
  const voucher = await prisma.valePass.findFirstOrThrow({ where: { groupId, company } });
  await prisma.valePassEvent.deleteMany({ where: { valePassId: voucher.id } });
  await prisma.valePass.delete({ where: { id: voucher.id } });
}

async function enqueue(outbox: ValePassEmailOutboxService, orderId: string, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    await lockShopifyOrder(tx, orderId);
    return outbox.enqueueForOrder(tx, orderId, now);
  });
}
const rowsOf = (orderId: string) => prisma.valePassEmailOutbox.findMany({ where: { shopifyOrderId: orderId }, orderBy: { createdAt: 'asc' } });
const codesOf = async (groupId: string) => (await prisma.valePass.findMany({ where: { groupId }, select: { code: true } })).map((v) => v.code);
const soon = () => new Date(Date.now() + 5_000);

beforeAll(async () => {
  if (!localDatabase) return;
  adminId = (await prisma.adminUser.create({ data: { name: ADMIN_NAME, phone: `${TAG}-admin`, pinHash: 'x', role: 'ADMIN', active: true } })).id;
  staffId = (await prisma.adminUser.create({ data: { name: 'Operador Teste E-mail', phone: `${TAG}-staff`, pinHash: 'x', role: 'STAFF', active: true } })).id;
  // Rede proibida: qualquer chamada real a fetch quebra o teste.
  vi.stubGlobal('fetch', () => {
    throw new Error('REDE REAL PROIBIDA NOS TESTES DE E-MAIL');
  });
});

afterEach(async () => {
  if (!localDatabase) return;
  // Mantém o banco enxuto entre testes: o resumo e o limite diário olham a tabela inteira.
  await cleanRows();
});

async function cleanRows() {
  const ids = campaignIds.splice(0);
  const orders = orderIds.splice(0);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica'); // a linha do tempo é append-only; só este teste descartável a limpa
    await tx.valePassEmailEvent.deleteMany({ where: { outbox: { campaignId: { in: ids } } } });
    await tx.valePassEmailOutbox.deleteMany({ where: { campaignId: { in: ids } } });
    const vouchers = await tx.valePass.findMany({ where: { campaignId: { in: ids } }, select: { id: true } });
    await tx.valePassEvent.deleteMany({ where: { valePassId: { in: vouchers.map((v) => v.id) } } });
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

afterAll(async () => {
  if (localDatabase) {
    await cleanRows();
    await prisma.adminAuditEvent.deleteMany({ where: { adminUserId: { in: [adminId, staffId] } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: [adminId, staffId] } } });
  }
  vi.unstubAllGlobals();
  await prisma.$disconnect();
});

localDescribe('E-mail dos vouchers — enfileirar com segurança', () => {
  test('uma unidade completa e paga → UMA mensagem inicial (dois vouchers), prazo de 3 dias, sem códigos na caixa de saída', async () => {
    const { outbox } = stack(liveConfig());
    const f = await paidOrder(1);
    expect(await enqueue(outbox, f.orderId)).toEqual({ enqueued: 1, alreadyQueued: 0, notEligible: 0 });
    const [row] = await rowsOf(f.orderId);
    expect(row).toMatchObject({ kind: 'INITIAL', status: 'QUEUED', attempts: 0, groupId: f.groupIds[0], dedupeKey: `initial:${f.groupIds[0]}`, toEmail: f.email, idempotencyKey: `vpe-${row.id}`, lockedUntil: null });
    const order = await prisma.valePassOrder.findUniqueOrThrow({ where: { shopifyOrderId: f.orderId } });
    expect(row.deadlineAt.getTime()).toBe(order.statusChangedAt.getTime() + 3 * DAY);
    // A caixa de saída não guarda os códigos (nem na linha, nem na linha do tempo)
    const dump = JSON.stringify([row, await prisma.valePassEmailEvent.findMany({ where: { outboxId: row.id } })]);
    for (const code of await codesOf(f.groupIds[0])) expect(dump).not.toContain(code);
  });

  test('idempotente: enfileirar de novo (webhook duplicado, reconciliador, duas transações simultâneas) nunca cria outra mensagem', async () => {
    const { outbox } = stack(liveConfig());
    const f = await paidOrder(2);
    const results = await Promise.all(Array.from({ length: 6 }, () => enqueue(outbox, f.orderId)));
    expect(results.reduce((sum, r) => sum + r.enqueued, 0)).toBe(2);
    expect(results.reduce((sum, r) => sum + r.alreadyQueued, 0)).toBe(10);
    expect(await rowsOf(f.orderId)).toHaveLength(2);
    expect((await enqueue(outbox, f.orderId)).enqueued).toBe(0);
  });

  test('pedido com várias unidades: um envio por unidade, cada um com os dois vouchers DA PRÓPRIA unidade', async () => {
    const { outbox, worker, provider } = stack(liveConfig());
    const f = await paidOrder(3);
    await enqueue(outbox, f.orderId);
    expect(await rowsOf(f.orderId)).toHaveLength(3);
    const report = await worker.tick(soon());
    expect(report).toMatchObject({ claimed: 3, accepted: 3 });
    expect(provider.calls).toHaveLength(3);
    const seen = new Set<string>();
    for (const call of provider.calls) {
      const codes = (call.text.match(/VALLE-[A-Z0-9]{4}-[A-Z0-9]{4}/g) ?? []);
      expect(codes).toHaveLength(2);
      codes.forEach((code) => seen.add(code));
    }
    expect(seen.size).toBe(6); // 6 códigos distintos no total, nenhum repetido entre as mensagens
    const subjects = provider.calls.map((call) => call.subject).sort();
    expect(subjects).toEqual(['Seus vouchers do Valle Pass 2027 (1 de 3)', 'Seus vouchers do Valle Pass 2027 (2 de 3)', 'Seus vouchers do Valle Pass 2027 (3 de 3)']);
    for (const groupId of f.groupIds) {
      const row = await prisma.valePassEmailOutbox.findUniqueOrThrow({ where: { dedupeKey: `initial:${groupId}` } });
      const call = provider.calls.find((c) => c.idempotencyKey === `vpe-${row.id}`)!;
      for (const code of await codesOf(groupId)) expect(call.text).toContain(code);
    }
  });

  test('NUNCA enfileira: pedido não pago, cancelado, reembolsado, excluído; nem emissão parcial', async () => {
    const { outbox } = stack(liveConfig());
    const pending = await paidOrder(1);
    await prisma.valePassOrder.update({ where: { shopifyOrderId: pending.orderId }, data: { status: 'PENDING', financialStatus: 'pending' } });
    const refunded = await paidOrder(1);
    await prisma.valePassOrder.update({ where: { shopifyOrderId: refunded.orderId }, data: { status: 'REFUNDED' } });
    const cancelled = await paidOrder(1);
    await prisma.valePassOrderCancellation.create({ data: { shopifyOrderId: cancelled.orderId, topic: 'orders/cancelled' } });
    const deleted = await paidOrder(1);
    await prisma.valePassOrder.update({ where: { shopifyOrderId: deleted.orderId }, data: { deletedInShopifyAt: new Date() } });
    const partial = await paidOrder(1);
    await dropVoucher(partial.groupIds[0], 'VS_BY_CLOSET'); // sobrou só um voucher da unidade
    const voucherCancelled = await paidOrder(1);
    await prisma.valePass.updateMany({ where: { groupId: voucherCancelled.groupIds[0], company: 'VALLE_SHOWROOM' }, data: { status: 'CANCELLED', cancelledAt: new Date() } });

    for (const f of [pending, refunded, cancelled, deleted, partial, voucherCancelled]) {
      expect(await enqueue(outbox, f.orderId), f.orderId).toEqual({ enqueued: 0, alreadyQueued: 0, notEligible: 1 });
      expect(await rowsOf(f.orderId)).toHaveLength(0);
    }
  });

  test('sem e-mail do cliente: a mensagem entra como "precisa de intervenção" (visível), nunca como enviada', async () => {
    const { outbox, worker, provider } = stack(liveConfig());
    const f = await paidOrder(1, { email: null });
    await enqueue(outbox, f.orderId);
    const [row] = await rowsOf(f.orderId);
    expect(row).toMatchObject({ status: 'NEEDS_ATTENTION', lastError: 'no_recipient', toEmail: '' });
    await worker.tick(soon());
    expect(provider.calls).toHaveLength(0);
  });

  test('o reconciliador (enqueueMissing) acha unidades emitidas e ainda sem mensagem — só quando o modo não é "off"', async () => {
    const f = await paidOrder(2);
    const off = stack(liveConfig({ VALE_PASS_EMAIL_MODE: 'off' }));
    expect(await off.worker.tick(soon())).toMatchObject({ mode: 'off', enqueued: 0, claimed: 0 });
    expect(await rowsOf(f.orderId)).toHaveLength(0); // desligado: nem enfileira
    const on = stack(liveConfig({ VALE_PASS_EMAIL_MODE: 'dry-run' }));
    expect(await on.worker.tick(soon())).toMatchObject({ mode: 'dry-run', enqueued: 2 });
    expect(await rowsOf(f.orderId)).toHaveLength(2);
  });
});

localDescribe('E-mail dos vouchers — portões de segurança do envio', () => {
  test('modo "off": nada é enfileirado nem enviado, mesmo com tudo configurado', async () => {
    const { outbox, worker, provider } = stack(liveConfig({ VALE_PASS_EMAIL_MODE: 'off' }));
    const f = await paidOrder(1);
    await enqueue(outbox, f.orderId);
    expect(await worker.tick(soon())).toMatchObject({ mode: 'off', claimed: 0 });
    expect(provider.calls).toHaveLength(0);
    expect((await rowsOf(f.orderId))[0].status).toBe('QUEUED');
  });

  test('"dry-run": valida o modelo e NÃO chama o provedor', async () => {
    const { outbox, worker, provider } = stack(liveConfig({ VALE_PASS_EMAIL_MODE: 'dry-run' }));
    const f = await paidOrder(1);
    await enqueue(outbox, f.orderId);
    expect(await worker.tick(soon())).toMatchObject({ mode: 'dry-run', dryRunReady: 1, claimed: 0, accepted: 0 });
    expect(provider.calls).toHaveLength(0);
    expect(await rowsOf(f.orderId).then((rows) => rows[0])).toMatchObject({ status: 'QUEUED', attempts: 0 });
  });

  test('"live" bloqueado: sem chave, ou domínio não verificado → nada enviado, motivo informado', async () => {
    const f = await paidOrder(1);
    for (const over of [{ RESEND_API_KEY: '' }, { VALE_PASS_EMAIL_DOMAIN_VERIFIED: 'false' }, { VALE_PASS_EMAIL_FROM: 'invalido' }]) {
      const { outbox, worker, provider } = stack(liveConfig(over));
      await enqueue(outbox, f.orderId);
      const report = await worker.tick(soon());
      expect(report.blocked.length, JSON.stringify(over)).toBeGreaterThan(0);
      expect(report.claimed).toBe(0);
      expect(provider.calls).toHaveLength(0);
    }
  });

  test('o worker de verdade não liga sozinho: o padrão do ambiente é desligado', () => {
    expect(loadEmailConfig({}).mode).toBe('off');
    expect(loadEmailConfig({ VITEST: '1' }).workerIntervalSeconds).toBeNull();
  });
});

localDescribe('E-mail dos vouchers — envio, reavaliação e confidencialidade', () => {
  test('envio completo: ACCEPTED com o id da Resend, remetente/destinatário/chave certos, linha do tempo sem códigos nem e-mail completo', async () => {
    const config = liveConfig({ VALE_PASS_EMAIL_REPLY_TO: 'suporte@vallebycloset.com' });
    const { outbox, worker, provider } = stack(config);
    const f = await paidOrder(1);
    await enqueue(outbox, f.orderId);
    expect(await worker.tick(soon())).toMatchObject({ claimed: 1, accepted: 1 });
    const [row] = await rowsOf(f.orderId);
    expect(row).toMatchObject({ status: 'ACCEPTED', attempts: 1, lockedUntil: null, lastError: null });
    expect(row.providerMessageId).toMatch(/^em_/);
    expect(row.acceptedAt).not.toBeNull();
    const call = provider.calls[0];
    expect(call).toMatchObject({ to: f.email, from: 'Valle Pass <vallepass@vallebycloset.com>', replyTo: 'suporte@vallebycloset.com', idempotencyKey: `vpe-${row.id}` });
    expect(call.html).toContain('R$ 500,00');
    expect(call.html).toContain('R$ 50,00');
    expect(call.html).toContain('Válido de 01/01/2027 a 31/12/2027');
    const timeline = JSON.stringify(await prisma.valePassEmailEvent.findMany({ where: { outboxId: row.id } }));
    expect(timeline).not.toContain(f.email);
    expect(timeline).not.toMatch(/VALLE-[A-Z0-9]{4}-[A-Z0-9]{4}/);
    expect((await prisma.valePassEmailEvent.findMany({ where: { outboxId: row.id }, orderBy: { createdAt: 'asc' } })).map((e) => e.type)).toEqual(['ENQUEUED', 'SEND_ATTEMPT', 'ACCEPTED']);
  });

  test('segunda rodada / webhook duplicado: o e-mail inicial sai UMA vez', async () => {
    const { outbox, worker, provider } = stack(liveConfig());
    const f = await paidOrder(1);
    await enqueue(outbox, f.orderId);
    await enqueue(outbox, f.orderId);
    await worker.tick(soon());
    await worker.tick(new Date(Date.now() + 10 * DAY));
    await enqueue(outbox, f.orderId);
    await worker.tick(new Date(Date.now() + 11 * DAY));
    expect(provider.calls).toHaveLength(1);
    expect(provider.deliveredIds.size).toBe(1);
  });

  test('reavaliação na hora do envio: reembolso/cancelamento DEPOIS de enfileirar → CANCELLED, o provedor nunca é chamado', async () => {
    const { outbox, worker, provider } = stack(liveConfig());
    const refunded = await paidOrder(1);
    const cancelled = await paidOrder(1);
    const voucher = await paidOrder(1);
    const deleted = await paidOrder(1);
    for (const f of [refunded, cancelled, voucher, deleted]) await enqueue(outbox, f.orderId);
    await prisma.valePassOrder.update({ where: { shopifyOrderId: refunded.orderId }, data: { status: 'REFUNDED' } });
    await prisma.valePassOrderCancellation.create({ data: { shopifyOrderId: cancelled.orderId, topic: 'refunds/create' } });
    await prisma.valePass.updateMany({ where: { groupId: voucher.groupIds[0] }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    await prisma.valePassOrder.update({ where: { shopifyOrderId: deleted.orderId }, data: { deletedInShopifyAt: new Date() } });
    expect(await worker.tick(soon())).toMatchObject({ claimed: 4, cancelled: 4, accepted: 0 });
    expect(provider.calls).toHaveLength(0);
    for (const f of [refunded, cancelled, voucher, deleted]) expect((await rowsOf(f.orderId))[0]).toMatchObject({ status: 'CANCELLED', attempts: 0 });
  });

  test('unidade que ficou incompleta antes do envio: espera (não envia pela metade) e, passadas 24 h, pede intervenção', async () => {
    const { outbox, worker, provider } = stack(liveConfig());
    const f = await paidOrder(1);
    await enqueue(outbox, f.orderId);
    await dropVoucher(f.groupIds[0], 'VS_BY_CLOSET');
    await worker.tick(soon());
    expect((await rowsOf(f.orderId))[0]).toMatchObject({ status: 'QUEUED', lastError: 'group_incomplete', attempts: 0 });
    await worker.tick(new Date(Date.now() + 25 * HOUR));
    expect((await rowsOf(f.orderId))[0]).toMatchObject({ status: 'NEEDS_ATTENTION', lastError: 'group_incomplete_too_long' });
    expect(provider.calls).toHaveLength(0);
  });

  test('voucher já resgatado antes do e-mail → intervenção (não envia código de voucher usado)', async () => {
    const { outbox, worker, provider } = stack(liveConfig());
    const f = await paidOrder(1);
    await enqueue(outbox, f.orderId);
    await prisma.valePass.updateMany({ where: { groupId: f.groupIds[0], company: 'VS_BY_CLOSET' }, data: { status: 'USED', usedAt: new Date() } });
    await worker.tick(soon());
    expect((await rowsOf(f.orderId))[0]).toMatchObject({ status: 'NEEDS_ATTENTION', lastError: 'voucher_already_used' });
    expect(provider.calls).toHaveLength(0);
  });

  test('o painel nunca expõe e-mail nem código completos', async () => {
    const { outbox, worker } = stack(liveConfig());
    const f = await paidOrder(1);
    await enqueue(outbox, f.orderId);
    await worker.tick(soon());
    const list = await outbox.list();
    const mine = list.find((item) => item.orderId === f.orderId)!;
    expect(mine.toMasked).toBe(`${f.email[0]}***${f.email.slice(f.email.lastIndexOf('@'))}`);
    expect(mine.codesMasked).toHaveLength(2);
    const dump = JSON.stringify(list);
    expect(dump).not.toContain(f.email);
    for (const code of await codesOf(f.groupIds[0])) expect(dump).not.toContain(code);
    expect(mine.codesMasked.every((c) => /^VALLE-[A-Z0-9]{4}-\*{4}$/.test(c))).toBe(true);
    expect(JSON.stringify(await outbox.events(mine.id))).not.toContain(f.email);
  });
});

localDescribe('E-mail dos vouchers — logs e isolamento dos lembretes', () => {
  test('nenhum log do envio (sucesso, erro permanente, credencial recusada, exceção, resultado desconhecido) contém código de voucher ou e-mail completo', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) => vi.spyOn(Logger.prototype, level).mockImplementation(capture));
    try {
      const { outbox, worker, provider } = stack(liveConfig());
      const fixtures = [await paidOrder(1), await paidOrder(1), await paidOrder(1), await paidOrder(1), await paidOrder(1)];
      for (const f of fixtures) await enqueue(outbox, f.orderId);
      provider.script.push(
        { kind: 'accepted', messageId: 'em_ok' },
        { kind: 'rejected', status: 422, reason: 'validation_error', permanent: true },
        { kind: 'unknown', reason: 'timeout' },
        new Error(`falha com ${fixtures[3].email} e código VALLE-ABCD-1234`), // exceção do provedor com dado sensível no texto
        { kind: 'rejected', status: 401, reason: 'auth_error', permanent: true, authProblem: true },
      );
      await worker.tick(soon());
      await worker.tick(new Date(Date.now() + 10 * 60_000));
      const sensitive = [...fixtures.map((f) => f.email), 'VALLE-ABCD-1234'];
      for (const f of fixtures) sensitive.push(...(await codesOf(f.groupIds[0])));
      const dump = lines.join(' | ');
      expect(lines.length).toBeGreaterThan(0); // houve log (ex.: credencial recusada)
      for (const secret of sensitive) expect(dump, 'log vazou dado sensível').not.toContain(secret);
      // e o que foi gravado no banco (erro, linha do tempo, auditoria) também não
      const stored = JSON.stringify([await prisma.valePassEmailOutbox.findMany({ where: { campaignId: { in: campaignIds } } }), await prisma.valePassEmailEvent.findMany({ where: { outbox: { campaignId: { in: campaignIds } } } })]);
      for (const secret of fixtures.map((f) => f.email)) expect(stored.replace(new RegExp(`"toEmail":"${secret}"`, 'g'), '')).not.toContain(secret);
      expect(stored).not.toMatch(/VALLE-[A-Z0-9]{4}-[A-Z0-9]{4}/);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  test('o e-mail dos vouchers não toca nos lembretes de retirada: arquivos e variáveis separados, e o serviço de lembretes continua intocado', () => {
    const emailDir = join(__dirname);
    for (const name of readdirSync(emailDir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const source = readFileSync(join(emailDir, name), 'utf8');
      for (const forbidden of ['REMINDER_FROM_EMAIL', 'REMINDER_FROM_NAME', 'PICKUP_REMINDER', 'pickup-reminder', 'WHATSAPP_']) expect(source, `${name} → ${forbidden}`).not.toContain(forbidden);
    }
    const reminders = readFileSync(join(__dirname, '..', '..', 'reminders', 'pickup-reminder.service.ts'), 'utf8');
    for (const forbidden of ['VALE_PASS', 'vale-pass', 'ValePass']) expect(reminders, forbidden).not.toContain(forbidden);
    // O remetente e o modo dos vouchers vêm só de variáveis próprias: com a chave dos lembretes presente, nada liga.
    expect(loadEmailConfig({ RESEND_API_KEY: 're_dos_lembretes', REMINDER_FROM_EMAIL: 'lembretes@vs.com', PICKUP_REMINDER_CHANNEL: 'email', PICKUP_REMINDER_ENABLED: 'true' })).toMatchObject({ mode: 'off', from: 'Valle Pass <vallepass@vallebycloset.com>' });
  });
});

localDescribe('E-mail dos vouchers — falhas, retentativas e resultado ambíguo', () => {
  test('429/limite de taxa: repete depois (respeita Retry-After), sem consumir a chave de idempotência', async () => {
    const { outbox, worker, provider } = stack(liveConfig());
    provider.script.push({ kind: 'rejected', status: 429, reason: 'rate_limited', permanent: false, retryAfterSeconds: 600 });
    const f = await paidOrder(1);
    await enqueue(outbox, f.orderId);
    const t0 = Date.now();
    await worker.tick(new Date(t0 + 5_000));
    const [row] = await rowsOf(f.orderId);
    expect(row).toMatchObject({ status: 'QUEUED', attempts: 1, lastError: 'rate_limited' });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(t0 + 5_000 + 600_000);
    await worker.tick(new Date(t0 + 60_000)); // ainda cedo
    expect(provider.calls).toHaveLength(1);
    await worker.tick(new Date(t0 + 700_000));
    expect((await rowsOf(f.orderId))[0]).toMatchObject({ status: 'ACCEPTED', attempts: 2 });
    expect(provider.calls[1].idempotencyKey).toBe(provider.calls[0].idempotencyKey);
    expect((await prisma.valePassEmailEvent.findMany({ where: { outboxId: row.id }, orderBy: { createdAt: 'asc' } })).map((e) => e.type)).toEqual(['ENQUEUED', 'SEND_ATTEMPT', 'RETRY_SCHEDULED', 'SEND_ATTEMPT', 'ACCEPTED']);
  });

  test('TIMEOUT depois de a Resend ter enviado: resultado "desconhecido", nova tentativa com a MESMA chave → um único e-mail real', async () => {
    const { outbox, worker, provider } = stack(liveConfig());
    provider.script.push('sent-but-timeout');
    const f = await paidOrder(1);
    await enqueue(outbox, f.orderId);
    const t0 = Date.now();
    await worker.tick(new Date(t0 + 5_000));
    const [unknown] = await rowsOf(f.orderId);
    expect(unknown).toMatchObject({ status: 'UNKNOWN', attempts: 1, lastError: 'timeout', providerMessageId: null });
    expect(provider.deliveredIds.size).toBe(1); // a Resend já tinha enviado
    await worker.tick(new Date(t0 + 2 * 60_000));
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].idempotencyKey).toBe(provider.calls[0].idempotencyKey);
    expect(provider.deliveredIds.size).toBe(1); // continua UM só
    expect((await rowsOf(f.orderId))[0]).toMatchObject({ status: 'ACCEPTED', attempts: 2 });
  });

  test('Resend fora do ar (5xx/exceção/rede): fica UNKNOWN e repete com espera crescente; nada se perde e nada vira falha', async () => {
    const { outbox, worker, provider } = stack(liveConfig());
    provider.script.push({ kind: 'unknown', reason: 'http_5xx' }, new Error('boom'), { kind: 'unknown', reason: 'network_error' });
    const f = await paidOrder(1);
    await enqueue(outbox, f.orderId);
    let now = Date.now() + 5_000;
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      await worker.tick(new Date(now));
      const [row] = await rowsOf(f.orderId);
      expect(row.status).toBe('UNKNOWN');
      waits.push(row.nextAttemptAt.getTime() - now);
      now = row.nextAttemptAt.getTime() + 1_000;
    }
    expect(waits).toEqual([60_000, 300_000, 900_000]); // 1 min, 5 min, 15 min
    await worker.tick(new Date(now));
    expect((await rowsOf(f.orderId))[0]).toMatchObject({ status: 'ACCEPTED', attempts: 4 });
    expect(provider.deliveredIds.size).toBe(1);
  });

  test('erro permanente (endereço recusado) → FAILED sem repetir; credencial recusada → intervenção e PAUSA de todo o envio', async () => {
    const { outbox, worker, provider } = stack(liveConfig());
    const a = await paidOrder(1);
    const b = await paidOrder(1);
    const c = await paidOrder(1);
    for (const f of [a, b, c]) await enqueue(outbox, f.orderId);
    provider.script.push({ kind: 'rejected', status: 422, reason: 'validation_error', permanent: true });
    provider.script.push({ kind: 'rejected', status: 401, reason: 'missing_api_key', permanent: true, authProblem: true });
    const t0 = Date.now() + 5_000;
    const report = await worker.tick(new Date(t0));
    // ordem de reserva = ordem de criação: a (422 → FAILED), b (401 → pausa), c nem é tentado
    expect(report).toMatchObject({ failed: 1, needsAttention: 1 });
    expect(provider.calls).toHaveLength(2);
    expect((await rowsOf(a.orderId))[0]).toMatchObject({ status: 'FAILED', lastError: 'validation_error' });
    expect((await rowsOf(a.orderId))[0].failedAt).not.toBeNull();
    expect((await rowsOf(b.orderId))[0]).toMatchObject({ status: 'NEEDS_ATTENTION', lastError: 'missing_api_key' });
    expect((await rowsOf(c.orderId))[0].status).toBe('QUEUED');
    expect(await worker.tick(new Date(t0 + 60_000))).toMatchObject({ paused: true, claimed: 0 }); // pausado 15 min
    await worker.tick(new Date(t0 + 16 * 60_000));
    expect((await rowsOf(c.orderId))[0].status).toBe('ACCEPTED');
  });

  test('tentativas esgotadas com resultado desconhecido → intervenção (nunca "falha"), sem mais chamadas', async () => {
    const { outbox, worker, provider } = stack(liveConfig({ VALE_PASS_EMAIL_MAX_ATTEMPTS: '3' }));
    for (let i = 0; i < 5; i++) provider.script.push({ kind: 'unknown', reason: 'timeout' });
    const f = await paidOrder(1);
    await enqueue(outbox, f.orderId);
    let now = Date.now() + 5_000;
    for (let i = 0; i < 5; i++) {
      await worker.tick(new Date(now));
      now += 3 * HOUR;
    }
    expect(provider.calls).toHaveLength(3);
    expect((await rowsOf(f.orderId))[0]).toMatchObject({ status: 'NEEDS_ATTENTION', lastError: 'attempts_exhausted_unknown_result', attempts: 3 });
  });

  test('resultado desconhecido com mais de ~22 h: não reenvia (a Resend já esqueceu a chave); uma pessoa decide', async () => {
    const { outbox, worker, provider } = stack(liveConfig());
    provider.script.push({ kind: 'unknown', reason: 'timeout' });
    const f = await paidOrder(1);
    await enqueue(outbox, f.orderId);
    const t0 = Date.now() + 5_000;
    await worker.tick(new Date(t0));
    expect((await rowsOf(f.orderId))[0].status).toBe('UNKNOWN');
    await worker.tick(new Date(t0 + 23 * HOUR));
    expect((await rowsOf(f.orderId))[0]).toMatchObject({ status: 'NEEDS_ATTENTION', lastError: 'unknown_result_expired' });
    expect(provider.calls).toHaveLength(1);
  });

  test('recusada (nunca enviada) há mais de ~22 h: a chave é trocada com segurança e o envio é refeito', async () => {
    const { outbox, worker, provider } = stack(liveConfig());
    provider.script.push({ kind: 'rejected', status: 429, reason: 'quota_exceeded', permanent: false });
    const f = await paidOrder(1);
    await enqueue(outbox, f.orderId);
    const t0 = Date.now() + 5_000;
    await worker.tick(new Date(t0));
    await worker.tick(new Date(t0 + 23 * HOUR));
    const [row] = await rowsOf(f.orderId);
    expect(row.status).toBe('ACCEPTED');
    expect(provider.calls[1].idempotencyKey).toBe(`vpe-${row.id}-r2`);
    expect(provider.calls[1].idempotencyKey).not.toBe(provider.calls[0].idempotencyKey);
  });

  test('"reinício do Railway": processo cai com a mensagem SENDING → a reserva vence, vira UNKNOWN e a retomada usa a mesma chave', async () => {
    const f = await paidOrder(1);
    const first = stack(liveConfig());
    await enqueue(first.outbox, f.orderId);
    const [row] = await rowsOf(f.orderId);
    // simula a queda: o worker marcou "enviando", a Resend recebeu e enviou, mas o processo morreu antes de gravar o resultado
    const crashedAt = new Date(Date.now() + 5_000);
    await prisma.valePassEmailOutbox.update({ where: { id: row.id }, data: { status: 'SENDING', attempts: 1, firstAttemptAt: crashedAt, lastAttemptAt: crashedAt, lockedUntil: new Date(crashedAt.getTime() + 90_000) } });
    first.provider.calls.push({ idempotencyKey: row.idempotencyKey } as SendEmailInput);
    const restarted = stack(liveConfig()); // novo processo, memória zerada
    expect(await restarted.worker.tick(new Date(crashedAt.getTime() + 30_000))).toMatchObject({ recoveredLeases: 0, claimed: 0 }); // reserva ainda vigente: não toca
    const after = await restarted.worker.tick(new Date(crashedAt.getTime() + 5 * 60_000));
    expect(after).toMatchObject({ recoveredLeases: 1, accepted: 1 });
    expect(restarted.provider.calls[0].idempotencyKey).toBe(row.idempotencyKey);
    expect((await rowsOf(f.orderId))[0]).toMatchObject({ status: 'ACCEPTED', attempts: 2 });
    expect((await prisma.valePassEmailEvent.findMany({ where: { outboxId: row.id }, orderBy: { createdAt: 'asc' } })).map((e) => e.type)).toContain('LEASE_EXPIRED');
  });

  test('processamento concorrente da fila: 4 workers em paralelo enviam cada mensagem UMA vez', async () => {
    const provider = new MockProvider();
    provider.delayMs = 15;
    const workers = Array.from({ length: 4 }, () => stack(liveConfig({ VALE_PASS_EMAIL_BATCH_SIZE: '6' }), provider));
    const f = await paidOrder(1);
    const campaign = f.campaign;
    const fixtures = [f];
    for (let i = 0; i < 17; i++) fixtures.push(await paidOrder(1, { campaign }));
    for (const fx of fixtures) await enqueue(workers[0].outbox, fx.orderId);
    let now = Date.now() + 5_000;
    for (let round = 0; round < 4; round++) {
      await Promise.all(workers.map((w) => w.worker.tick(new Date(now))));
      now += 1_000;
    }
    expect(provider.calls).toHaveLength(18);
    expect(new Set(provider.calls.map((c) => c.idempotencyKey)).size).toBe(18);
    expect(provider.deliveredIds.size).toBe(18);
    const all = await prisma.valePassEmailOutbox.findMany({ where: { campaignId: campaign.id } });
    expect(all.every((row) => row.status === 'ACCEPTED' && row.attempts === 1)).toBe(true);
  });

  test('limite do plano gratuito: respeita o limite diário mesmo com workers concorrentes; o resto espera e sai no dia seguinte', async () => {
    const provider = new MockProvider();
    const workers = Array.from({ length: 3 }, () => stack(liveConfig({ VALE_PASS_EMAIL_DAILY_LIMIT: '5', VALE_PASS_EMAIL_BATCH_SIZE: '4' }), provider));
    const campaign = await newCampaign();
    const fixtures = [];
    for (let i = 0; i < 9; i++) fixtures.push(await paidOrder(1, { campaign }));
    for (const fx of fixtures) await enqueue(workers[0].outbox, fx.orderId);
    const now = Date.now() + 5_000;
    const reports = await Promise.all(workers.map((w) => w.worker.tick(new Date(now))));
    expect(provider.calls).toHaveLength(5);
    expect(reports.some((r) => r.limitReached)).toBe(true);
    const statuses = (await prisma.valePassEmailOutbox.findMany({ where: { campaignId: campaign.id } })).map((r) => r.status);
    expect(statuses.filter((s) => s === 'ACCEPTED')).toHaveLength(5);
    expect(statuses.filter((s) => s === 'QUEUED')).toHaveLength(4); // esperam, sem perder nada
    const summary = await workers[0].outbox.summary(new Date(now));
    expect(summary.acceptedLast24h).toBe(5);
    expect(summary.alerts.map((a) => a.code)).toContain('EMAIL_DAILY_LIMIT_NEAR');
    // No dia seguinte o limite recomeça e a fila é drenada
    await workers[0].worker.tick(new Date(now + 25 * HOUR));
    expect(provider.calls).toHaveLength(9);
    expect((await prisma.valePassEmailOutbox.findMany({ where: { campaignId: campaign.id } })).every((r) => r.status === 'ACCEPTED')).toBe(true);
  });

  test('regressão: a reserva do lote NUNCA devolve mais mensagens que o LIMIT, mesmo com reservas concorrentes (CTE materializada)', async () => {
    const { outbox, worker } = stack(liveConfig());
    const campaign = await newCampaign();
    for (let i = 0; i < 24; i++) await enqueue(outbox, (await paidOrder(1, { campaign })).orderId);
    const now = new Date(Date.now() + 5_000);
    const claimedAll: string[] = [];
    for (let round = 0; round < 12; round++) {
      const batches = await Promise.all(Array.from({ length: 4 }, () => prisma.$transaction((tx) => worker.claim(tx, 3, now))));
      for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(3);
      claimedAll.push(...batches.flat());
    }
    expect(claimedAll).toHaveLength(24); // tudo foi reservado, e cada mensagem uma única vez
    expect(new Set(claimedAll).size).toBe(24);
  });

  test('ESTRESSE do limite diário: 6 workers, 12 rodadas, nunca mais envios inéditos que o limite (mesmo com repetições e atraso do provedor)', async () => {
    const limit = 7;
    for (let iteration = 0; iteration < 4; iteration++) {
      const provider = new MockProvider();
      provider.delayMs = 5;
      const workers = Array.from({ length: 6 }, () => stack(liveConfig({ VALE_PASS_EMAIL_DAILY_LIMIT: String(limit), VALE_PASS_EMAIL_BATCH_SIZE: '3' }), provider));
      const campaign = await newCampaign();
      for (let i = 0; i < 20; i++) await enqueue(workers[0].outbox, (await paidOrder(1, { campaign })).orderId);
      const now = Date.now() + 5_000;
      for (let round = 0; round < 2; round++) await Promise.all(workers.map((w) => w.worker.tick(new Date(now + round))));
      expect(provider.calls.length, `iteração ${iteration}`).toBe(limit);
      expect(new Set(provider.calls.map((call) => call.idempotencyKey)).size).toBe(limit);
      const rows = await prisma.valePassEmailOutbox.findMany({ where: { campaignId: campaign.id } });
      expect(rows.filter((row) => row.status === 'ACCEPTED')).toHaveLength(limit);
      expect(rows.filter((row) => row.status === 'QUEUED')).toHaveLength(20 - limit);
      expect(rows.every((row) => row.attempts <= 1)).toBe(true);
      await cleanRows();
    }
  }, 120_000);

  test('cota diária estourada na Resend (429 quota): pausa o envio por 1 h e mantém tudo na fila', async () => {
    const { outbox, worker, provider } = stack(liveConfig());
    provider.script.push({ kind: 'rejected', status: 429, reason: 'quota_exceeded', permanent: false, retryAfterSeconds: 3600 });
    const a = await paidOrder(1);
    const b = await paidOrder(1);
    await enqueue(outbox, a.orderId);
    await enqueue(outbox, b.orderId);
    const t0 = Date.now() + 5_000;
    await worker.tick(new Date(t0));
    expect(provider.calls).toHaveLength(1);
    expect(await worker.tick(new Date(t0 + 30 * 60_000))).toMatchObject({ paused: true });
    expect(provider.calls).toHaveLength(1);
    await worker.tick(new Date(t0 + 61 * 60_000));
    expect((await rowsOf(a.orderId))[0].status).toBe('ACCEPTED');
    expect((await rowsOf(b.orderId))[0].status).toBe('ACCEPTED');
  });
});

localDescribe('E-mail dos vouchers — eventos da Resend e acompanhamento', () => {
  test('entregue / devolvido: transições monotônicas e idempotentes; mensagem desconhecida é ignorada', async () => {
    const { outbox, worker } = stack(liveConfig());
    const a = await paidOrder(1);
    const b = await paidOrder(1);
    await enqueue(outbox, a.orderId);
    await enqueue(outbox, b.orderId);
    await worker.tick(soon());
    const [ra] = await rowsOf(a.orderId);
    const [rb] = await rowsOf(b.orderId);
    expect(await outbox.applyProviderEvent('email.delivery_delayed', ra.providerMessageId!)).toBe('applied');
    expect(await outbox.applyProviderEvent('email.delivered', ra.providerMessageId!)).toBe('applied');
    expect(await outbox.applyProviderEvent('email.delivered', ra.providerMessageId!)).toBe('ignored'); // repetição
    expect(await outbox.applyProviderEvent('email.delivery_delayed', ra.providerMessageId!)).toBe('ignored'); // não regride
    expect((await rowsOf(a.orderId))[0]).toMatchObject({ status: 'DELIVERED' });
    expect((await rowsOf(a.orderId))[0].deliveredAt).not.toBeNull();
    expect(await outbox.applyProviderEvent('email.bounced', rb.providerMessageId!)).toBe('applied');
    expect((await rowsOf(b.orderId))[0]).toMatchObject({ status: 'FAILED', lastError: 'bounced' });
    expect(await outbox.applyProviderEvent('email.delivered', rb.providerMessageId!)).toBe('ignored'); // devolvido não vira entregue
    expect(await outbox.applyProviderEvent('email.delivered', 'em_inexistente')).toBe('unknown_message');
    expect(await outbox.applyProviderEvent('email.opened', ra.providerMessageId!)).toBe('ignored');
  });

  test('prazo de 3 dias: vencido e não aceito → alerta crítico; reenvio aceito resolve; fila bloqueada com envio desligado aparece', async () => {
    const off = stack(liveConfig({ VALE_PASS_EMAIL_MODE: 'off' }));
    const f = await paidOrder(1, { confirmedAgoMs: 4 * DAY });
    await enqueue(off.outbox, f.orderId);
    let summary = await off.outbox.summary();
    expect(summary.counts.QUEUED).toBeGreaterThanOrEqual(1);
    expect(summary.overdue).toBe(1);
    const codes = summary.alerts.map((a) => a.code);
    expect(codes).toEqual(expect.arrayContaining(['EMAIL_OVERDUE', 'EMAIL_QUEUE_BLOCKED']));
    expect(summary.alerts.find((a) => a.code === 'EMAIL_OVERDUE')?.severity).toBe('critical');
    expect(summary.config).toMatchObject({ mode: 'off', canSend: false });
    expect(JSON.stringify(summary)).not.toContain('re_test_key');

    const near = await paidOrder(1, { confirmedAgoMs: 2.5 * DAY });
    await enqueue(off.outbox, near.orderId);
    summary = await off.outbox.summary();
    expect(summary.atRisk).toBe(1);
    expect(summary.alerts.map((a) => a.code)).toContain('EMAIL_AT_RISK');

    // com o envio ativo e a mensagem aceita, o alerta some
    const live = stack(liveConfig());
    await live.worker.tick(soon());
    summary = await live.outbox.summary();
    expect(summary.overdue).toBe(0);
    expect(summary.atRisk).toBe(0);
    expect(summary.alerts.map((a) => a.code)).not.toContain('EMAIL_OVERDUE');
  });

  test('intervenção e falhas geram alertas críticos/avisos separados', async () => {
    const { outbox, worker, provider } = stack(liveConfig());
    const a = await paidOrder(1, { email: null });
    const b = await paidOrder(1);
    await enqueue(outbox, a.orderId);
    await enqueue(outbox, b.orderId);
    provider.script.push({ kind: 'rejected', status: 422, reason: 'validation_error', permanent: true });
    await worker.tick(soon());
    const summary = await outbox.summary();
    expect(summary.counts).toMatchObject({ NEEDS_ATTENTION: 1, FAILED: 1 });
    expect(summary.alerts.map((x) => x.code)).toEqual(expect.arrayContaining(['EMAIL_NEEDS_ATTENTION', 'EMAIL_FAILED']));
  });
});

localDescribe('E-mail dos vouchers — reenvio administrativo', () => {
  async function sentMessage() {
    const s = stack(liveConfig());
    const f = await paidOrder(1);
    await enqueue(s.outbox, f.orderId);
    await s.worker.tick(soon());
    const [row] = await rowsOf(f.orderId);
    return { ...s, f, row };
  }

  test('ADMIN reenvia com justificativa: nova mensagem ligada à original, chave nova, auditoria crítica sem códigos e com e-mails mascarados', async () => {
    const { outbox, worker, provider, f, row } = await sentMessage();
    const created = await outbox.requestResend(row.id, { note: 'Cliente não achou o e-mail' }, { id: adminId, name: ADMIN_NAME });
    expect(created).toMatchObject({ status: 'QUEUED', mayDuplicate: false });
    const resent = await prisma.valePassEmailOutbox.findUniqueOrThrow({ where: { id: created.id } });
    expect(resent).toMatchObject({ kind: 'RESEND', resendOfId: row.id, requestedBy: adminId, note: 'Cliente não achou o e-mail', dedupeKey: `resend:${f.groupIds[0]}:1`, toEmail: f.email });
    expect(resent.idempotencyKey).not.toBe(row.idempotencyKey);
    const audit = await prisma.adminAuditEvent.findFirstOrThrow({ where: { entityId: created.id } });
    expect(audit).toMatchObject({ action: 'VALE_PASS_EMAIL_RESENT', adminUserId: adminId, isCritical: true });
    const dump = JSON.stringify(audit);
    expect(dump).not.toContain(f.email);
    expect(dump).not.toMatch(/VALLE-[A-Z0-9]{4}-[A-Z0-9]{4}/);
    expect(dump).toContain('***@');
    await worker.tick(new Date(Date.now() + 10_000));
    expect(provider.calls).toHaveLength(2);
    expect((await prisma.valePassEmailOutbox.findUniqueOrThrow({ where: { id: created.id } })).status).toBe('ACCEPTED');
  });

  test('corrigir o destinatário é registrado (mascarado) e validado', async () => {
    const { outbox, f, row } = await sentMessage();
    await expect(outbox.requestResend(row.id, { note: 'Endereço estava errado', toEmail: 'inválido' }, { id: adminId, name: ADMIN_NAME })).rejects.toBeInstanceOf(UnprocessableEntityException);
    const created = await outbox.requestResend(row.id, { note: 'Endereço estava errado', toEmail: 'novo.endereco@exemplo.invalid' }, { id: adminId, name: ADMIN_NAME });
    expect((await prisma.valePassEmailOutbox.findUniqueOrThrow({ where: { id: created.id } })).toEmail).toBe('novo.endereco@exemplo.invalid');
    const audit = await prisma.adminAuditEvent.findFirstOrThrow({ where: { entityId: created.id } });
    expect(audit.detail).toMatchObject({ recipientChanged: true });
    expect(JSON.stringify(audit)).not.toContain('novo.endereco@exemplo.invalid');
    expect(f.email).not.toBe('novo.endereco@exemplo.invalid');
  });

  test('recusas: STAFF/inativo (403), justificativa curta (422), original em andamento ou cancelada, pedido reembolsado, limite de reenvios', async () => {
    const { outbox, f, row } = await sentMessage();
    await expect(outbox.requestResend(row.id, { note: 'Justificativa suficiente' }, { id: staffId, name: 'Operador' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(outbox.requestResend(row.id, { note: 'Justificativa suficiente' }, { id: '00000000-0000-4000-8000-000000000000', name: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(outbox.requestResend(row.id, { note: 'curta' }, { id: adminId, name: ADMIN_NAME })).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(outbox.requestResend('00000000-0000-4000-8000-000000000000', { note: 'Justificativa suficiente' }, { id: adminId, name: ADMIN_NAME })).rejects.toThrow(/não encontrada/);
    // original ainda na fila → recusa
    const queued = await paidOrder(1);
    await enqueue(outbox, queued.orderId);
    const [queuedRow] = await rowsOf(queued.orderId);
    await expect(outbox.requestResend(queuedRow.id, { note: 'Justificativa suficiente' }, { id: adminId, name: ADMIN_NAME })).rejects.toBeInstanceOf(ConflictException);
    // cancelada → recusa
    await prisma.valePassEmailOutbox.update({ where: { id: queuedRow.id }, data: { status: 'CANCELLED' } });
    await expect(outbox.requestResend(queuedRow.id, { note: 'Justificativa suficiente' }, { id: adminId, name: ADMIN_NAME })).rejects.toThrow(/cancelada/);
    // limite de 5 reenvios por unidade
    for (let i = 0; i < 5; i++) {
      const r = await outbox.requestResend(row.id, { note: `Reenvio número ${i + 1} do teste` }, { id: adminId, name: ADMIN_NAME });
      await prisma.valePassEmailOutbox.update({ where: { id: r.id }, data: { status: 'ACCEPTED', providerMessageId: `em_t${i}_${TAG}` } });
    }
    await expect(outbox.requestResend(row.id, { note: 'Reenvio número 6 do teste' }, { id: adminId, name: ADMIN_NAME })).rejects.toThrow(/Limite de 5/);
    // pedido reembolsado depois → códigos não podem ser reenviados
    await prisma.valePassOrder.update({ where: { shopifyOrderId: f.orderId }, data: { status: 'REFUNDED' } });
    await expect(outbox.requestResend(row.id, { note: 'Justificativa suficiente' }, { id: adminId, name: ADMIN_NAME })).rejects.toThrow(/não está pago|não pode/i);
    expect(await prisma.adminAuditEvent.count({ where: { action: 'VALE_PASS_EMAIL_RESENT', adminUserId: staffId } })).toBe(0);
  });

  test('original com resultado desconhecido que exigiu intervenção: o reenvio avisa que o cliente pode receber duas mensagens', async () => {
    const { outbox, worker, provider } = stack(liveConfig({ VALE_PASS_EMAIL_MAX_ATTEMPTS: '1' }));
    provider.script.push({ kind: 'unknown', reason: 'timeout' });
    const f = await paidOrder(1);
    await enqueue(outbox, f.orderId);
    await worker.tick(soon());
    const [row] = await rowsOf(f.orderId);
    expect(row.status).toBe('NEEDS_ATTENTION');
    const result = await outbox.requestResend(row.id, { note: 'Confirmado na Resend que não saiu' }, { id: adminId, name: ADMIN_NAME });
    expect(result.mayDuplicate).toBe(true);
    // e o prazo passa a contar como cumprido assim que o reenvio for aceito
    await worker.tick(new Date(Date.now() + 10_000));
    expect((await outbox.summary()).overdue).toBe(0);
  });

  test('permissões da rota: ver é do módulo; reenviar é só ADMIN', () => {
    const proto = ValePassEmailController.prototype as unknown as Record<string, unknown>;
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto.resend as object)).toBe('ADMIN');
    for (const handler of ['summary', 'list', 'events']) expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto[handler] as object), handler).toBeUndefined();
  });
});

localDescribe('E-mail dos vouchers — garantias do banco e isolamento', () => {
  test('constraints e triggers: identidade imutável, linha do tempo só cresce, chave única, aceito exige id', async () => {
    const { outbox } = stack(liveConfig());
    const f = await paidOrder(1);
    await enqueue(outbox, f.orderId);
    const [row] = await rowsOf(f.orderId);
    for (const data of [{ groupId: '33333333-3333-4333-8333-333333333333' }, { shopifyOrderId: 'outro' }, { dedupeKey: `initial:${row.groupId}x` }, { kind: 'RESEND' as const }]) {
      await expect(prisma.valePassEmailOutbox.update({ where: { id: row.id }, data }), JSON.stringify(data)).rejects.toThrow(/vale_pass_email_immutable|23514|vpe_/);
    }
    await expect(prisma.valePassEmailOutbox.update({ where: { id: row.id }, data: { status: 'ACCEPTED' } })).rejects.toThrow(/vpe_accepted_has_provider_id/);
    await expect(prisma.valePassEmailOutbox.update({ where: { id: row.id }, data: { attempts: -1 } })).rejects.toThrow(/vpe_attempts_nonneg/);
    await expect(prisma.valePassEmailOutbox.create({ data: { shopifyOrderId: row.shopifyOrderId, campaignId: row.campaignId, groupId: row.groupId, dedupeKey: row.dedupeKey, toEmail: 'a@b.co', idempotencyKey: 'x', deadlineAt: new Date() } })).rejects.toThrow(/Unique constraint/i);
    await expect(prisma.valePassEmailOutbox.create({ data: { shopifyOrderId: 'x', campaignId: row.campaignId, groupId: row.groupId, kind: 'RESEND', dedupeKey: `resend:${row.groupId}:9`, toEmail: 'a@b.co', idempotencyKey: 'y', deadlineAt: new Date() } })).rejects.toThrow(/vpe_resend_has_origin/);
    await expect(prisma.valePassEmailOutbox.create({ data: { shopifyOrderId: 'x', campaignId: row.campaignId, groupId: row.groupId, kind: 'INITIAL', dedupeKey: `resend:${row.groupId}:8`, toEmail: 'a@b.co', idempotencyKey: 'z', deadlineAt: new Date() } })).rejects.toThrow(/vpe_kind_matches_dedupe|vpe_dedupe_format/);
    const [event] = await prisma.valePassEmailEvent.findMany({ where: { outboxId: row.id } });
    await expect(prisma.valePassEmailEvent.update({ where: { id: event.id }, data: { type: 'ADULTERADO' } })).rejects.toThrow(/append_only/);
    await expect(prisma.valePassEmailEvent.delete({ where: { id: event.id } })).rejects.toThrow(/append_only/);
  });

  test('o webhook financeiro, o checkout e as reservas não conhecem o e-mail; só o módulo e o próprio e-mail usam a caixa de saída', () => {
    const webhook = readFileSync(join(__dirname, '..', 'vale-pass-webhook.service.ts'), 'utf8');
    for (const name of ['outbox', 'Outbox', 'ValePassEmail', 'enqueueForOrder', './email', 'Resend', 'resend']) expect(webhook, name).not.toContain(name);
    const root = join(__dirname, '..', '..');
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && /enqueueForOrder|ValePassEmailOutboxService/.test(readFileSync(full, 'utf8'))) users.push(full.slice(root.length + 1).split('\\').join('/'));
      }
    };
    walk(root);
    expect(users.sort()).toEqual(['vale-pass/email/email-outbox.service.ts', 'vale-pass/email/email-worker.service.ts', 'vale-pass/email/email.controller.ts', 'vale-pass/email/resend-webhook.controller.ts', 'vale-pass/vale-pass.module.ts']);
    // ninguém em produção chama enqueueForOrder fora do próprio serviço: a ligação à emissão ainda NÃO existe
    const callers = users.filter((file) => /\.enqueueForOrder\(/.test(readFileSync(join(root, file), 'utf8')));
    expect(callers).toEqual(['vale-pass/email/email-outbox.service.ts']);
    expect(new ValePassWebhookService()).toBeDefined();
  });

  test('nenhum teste fez chamada de rede (fetch global proibido)', async () => {
    await expect(Promise.resolve().then(() => fetch('https://api.resend.com/emails'))).rejects.toThrow(/REDE REAL PROIBIDA/);
  });
});
