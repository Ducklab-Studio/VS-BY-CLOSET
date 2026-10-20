import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import type { ValePass } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { REQUIRE_ROLE_KEY } from '../../admin/require-role.decorator';
import { evaluateGroup } from '../email/email-outbox.service';
import { ValePassVouchersService } from '../vale-pass-vouchers.service';
import { ConfirmBlockDto } from '../dto/voucher-balance.dto';
import { ValePassBlockService } from './block.service';
import { ValePassLedgerController } from './ledger.controller';
import { ValePassLedgerService } from './ledger.service';
import { ValePassRedemptionService, type Actor } from './redemption.service';
import { purgeLedgerForTest } from './ledger-test-utils';

/**
 * Fase 3 / PR C1 — bloqueio e desbloqueio administrativo (serviço + banco), em PostgreSQL LOCAL descartável.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const redemption = new ValePassRedemptionService(prisma);
const blocks = new ValePassBlockService(prisma, redemption);
const ledger = new ValePassLedgerService(prisma);
const vouchersService = new ValePassVouchersService(prisma);
const TAG = `VPBL-${Date.now()}`;
let counter = 0;
let admin: Actor;
const staff = { id: randomUUID(), name: 'Funcionário Teste', role: 'STAFF' } as { id: string; name: string; role: 'STAFF' };
const campaignIds: string[] = [];
const orderIds: string[] = [];
const REASON = 'Suspeita de fraude: conferir com a Valle Showroom';

interface Unit { campaignId: string; orderId: string; groupId: string; showroom: ValePass; closet: ValePass }
async function newUnit(over: { expiresAt?: Date } = {}): Promise<Unit> {
  const campaign = await prisma.valePassCampaign.create({ data: { name: `${TAG}-camp-${counter++}`, amountCents: 35_000, validityDays: 30, shopifyVariantId: `${TAG}-var-${counter++}`, voucherValidFrom: new Date('2026-01-01'), voucherValidUntil: new Date('2027-09-30') } });
  campaignIds.push(campaign.id);
  const [b1, b2] = await Promise.all([
    prisma.valePassCampaignBenefit.create({ data: { campaignId: campaign.id, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 } }),
    prisma.valePassCampaignBenefit.create({ data: { campaignId: campaign.id, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 } }),
  ]);
  const orderId = `${TAG}-o${counter++}`;
  orderIds.push(orderId);
  const groupId = randomUUID();
  const common = { campaignId: campaign.id, groupId, shopifyOrderId: orderId, shopifyOrderName: '#T-BLOQ', status: 'ACTIVE' as const, purchasedAt: new Date(), expiresAt: over.expiresAt ?? new Date('2027-10-01T03:00:00Z'), validFrom: new Date('2026-01-01T03:00:00Z'), customerName: 'Maria da Silva', customerEmail: 'maria@exemplo.invalid' };
  const showroom = await prisma.valePass.create({ data: { ...common, code: `VALLE-${TAG.slice(-4)}-A${counter++}`.toUpperCase(), amountCents: 50_000, company: 'VALLE_SHOWROOM', benefitId: b1.id } });
  const closet = await prisma.valePass.create({ data: { ...common, code: `VALLE-${TAG.slice(-4)}-B${counter++}`.toUpperCase(), amountCents: 5_000, company: 'VS_BY_CLOSET', benefitId: b2.id } });
  return { campaignId: campaign.id, orderId, groupId, showroom, closet };
}

const voucher = (id: string) => prisma.valePass.findUniqueOrThrow({ where: { id } });
const events = (id: string) => prisma.valePassBlockEvent.findMany({ where: { valePassId: id }, orderBy: { seq: 'asc' } });
const op = () => `op-${randomUUID()}`;
const block = (v: ValePass, over: Partial<{ reason: string; operationId: string; confirmCode: string }> = {}, actor: Actor = admin) =>
  blocks.confirmBlock(v.code, { reason: REASON, operationId: op(), confirmCode: v.code, ...over }, actor);
const unblock = (v: ValePass, over: Partial<{ reason: string; operationId: string; confirmCode: string }> = {}, actor: Actor = admin) =>
  blocks.confirmUnblock(v.code, { reason: 'Conferido e liberado pelo administrador', operationId: op(), confirmCode: v.code, ...over }, actor);
const redeem = async (v: ValePass, cents: number) => {
  const current = await voucher(v.id);
  return redemption.confirmRedeem(v.code, { company: v.company as string, amountCents: cents, reference: 'Nota 1', operationId: op(), expectedBalanceCents: current.balanceCents, confirmAmountCents: cents }, admin);
};
const rejection = async (promise: Promise<unknown>) => promise.then(() => null, (err: unknown) => err as { status?: number; response?: { code?: string }; message: string });

async function cleanRows() {
  const ids = campaignIds.splice(0);
  const orders = orderIds.splice(0);
  await prisma.$transaction(async (tx) => {
    const rows = await tx.valePass.findMany({ where: { campaignId: { in: ids } }, select: { id: true } });
    await purgeLedgerForTest(tx, { campaignIds: ids });
    await tx.valePassEvent.deleteMany({ where: { valePassId: { in: rows.map((r) => r.id) } } });
    await tx.adminAuditEvent.deleteMany({ where: { OR: [{ entityId: { in: rows.map((r) => r.id) } }, { adminUserId: { in: [admin?.id, staff.id].filter(Boolean) as string[] } }] } });
    await tx.valePassRefundApplication.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.valePassOrderCancellation.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.valePassOrder.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.valePass.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaignBenefit.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaign.deleteMany({ where: { id: { in: ids } } });
  });
}
beforeAll(async () => {
  if (!localDatabase) return;
  const row = await prisma.adminUser.create({ data: { name: 'Admin Teste Bloqueio', phone: `${TAG}-admin`, pinHash: 'x', role: 'ADMIN', active: true } });
  admin = { id: row.id, name: row.name, role: 'ADMIN' };
  staff.id = (await prisma.adminUser.create({ data: { name: staff.name, phone: `${TAG}-staff`, pinHash: 'x', role: 'STAFF', active: true } })).id;
});
afterEach(async () => {
  if (localDatabase) await cleanRows();
});
afterAll(async () => {
  if (localDatabase) {
    await cleanRows();
    await prisma.adminUser.deleteMany({ where: { id: { in: [admin.id, staff.id] } } });
  }
  await prisma.$disconnect();
});

localDescribe('bloquear: não altera status, saldo nem histórico; fica auditado', () => {
  test('prévia não grava; confirmação bloqueia, congela o saldo parcial e registra evento, auditoria CRÍTICA e histórico', async () => {
    const u = await newUnit();
    await redemption.confirmRedeem(u.showroom.code, { company: 'VALLE_SHOWROOM', amountCents: 20_000, reference: 'Nota 1', operationId: op(), expectedBalanceCents: 50_000, confirmAmountCents: 20_000 }, admin);
    const preview = await blocks.prepareBlock(u.showroom.code, admin);
    expect(preview).toMatchObject({ canProceed: true, problems: [], blocked: false, status: 'ACTIVE', balanceCents: 30_000 });
    expect(await events(u.showroom.id)).toHaveLength(0);
    const done = await block(u.showroom, { operationId: preview.operationId });
    expect(done).toMatchObject({ replayed: false, blocked: true, status: 'ACTIVE', balanceCents: 30_000, event: { seq: 1, kind: 'BLOCK', reason: REASON, actorName: admin.name, balanceCents: 30_000 } });
    expect(await voucher(u.showroom.id)).toMatchObject({ status: 'ACTIVE', balanceCents: 30_000, blockReason: REASON, blockedBy: admin.id, cancelledAt: null });
    expect((await voucher(u.showroom.id)).blockedAt).not.toBeNull();
    expect(await prisma.valePassLedgerEntry.count({ where: { valePassId: u.showroom.id } })).toBe(1); // o histórico de saldo ficou intacto
    expect(await ledger.reconcile()).toEqual([]);
    const audits = await prisma.adminAuditEvent.findMany({ where: { entityId: u.showroom.id, action: 'VALE_PASS_BLOCKED' } });
    expect(audits).toMatchObject([{ isCritical: true }]);
    expect(JSON.stringify(audits)).not.toContain(u.showroom.code);
    expect(await prisma.valePassEvent.count({ where: { valePassId: u.showroom.id, type: 'BLOCKED' } })).toBe(1);
    const view = await redemption.lookup(u.showroom.code, admin);
    expect(view).toMatchObject({ redeemable: false, blockedReason: REASON, blockHistory: [{ kind: 'BLOCK', reason: REASON }] });
    expect(view.restrictions.map((r) => r.code)).toContain('BLOCKED');
    const asStaff = await redemption.lookup(u.showroom.code, staff);
    expect(asStaff.blockedReason).toBeNull(); // a justificativa (pode citar fraude) só vai para administrador
    expect(asStaff.blockHistory[0].reason).toBeNull();
    expect(asStaff.blockedAt).not.toBeNull();
  });

  test('o bloqueio de uma empresa não afeta o voucher irmão (outra empresa)', async () => {
    const u = await newUnit();
    await block(u.showroom);
    expect((await voucher(u.closet.id)).blockedAt).toBeNull();
    await expect(redeem(u.closet, 1_000)).resolves.toMatchObject({ balanceCents: 4_000 });
  });

  test('voucher bloqueado: resgate, reversão e "usado" (endpoint antigo) são recusados; nada muda', async () => {
    const u = await newUnit();
    const first = await redeem(u.showroom, 10_000);
    await block(u.showroom);
    expect((await rejection(redeem(u.showroom, 100)))?.response?.code).toBe('BLOCKED');
    expect((await rejection(redeem(u.showroom, 100)))).toBeInstanceOf(ConflictException);
    const rev = await rejection(redemption.confirmReverse(u.showroom.code, first.entry.id, { reason: 'Reversão tentada com voucher bloqueado', operationId: op(), expectedBalanceCents: 40_000, confirmAmountCents: 10_000 }, admin));
    expect(rev?.response?.code).toBe('BLOCKED');
    expect(await rejection(vouchersService.markUsed(u.closet.code, admin.id, admin.name))).toBeNull(); // o irmão não bloqueado segue normal
    await block(u.closet).catch(() => undefined);
    // o banco recusa mesmo sem passar pelos serviços
    await expect(prisma.valePassLedgerEntry.create({ data: { valePassId: u.showroom.id, seq: 1, balanceAfterCents: 0, kind: 'REDEEM', deltaCents: -100, idempotencyKey: op() } })).rejects.toThrow(/vale_pass_ledger_blocked/);
    await expect(prisma.valePassLedgerEntry.create({ data: { valePassId: u.showroom.id, seq: 1, balanceAfterCents: 0, kind: 'REVERSAL', deltaCents: 10_000, reversesEntryId: first.entry.id, idempotencyKey: op() } })).rejects.toThrow(/vale_pass_ledger_blocked/);
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 40_000, status: 'ACTIVE' });
  });

  test('voucher LEGADO bloqueado: "usado" recusado pelo serviço e pelo banco', async () => {
    const u = await newUnit();
    const legacy = await prisma.valePass.create({ data: { code: `VALLE-${TAG.slice(-4)}-LEG${counter++}`.toUpperCase(), campaignId: u.campaignId, amountCents: 35_000, purchasedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) } });
    await block(legacy);
    await expect(vouchersService.markUsed(legacy.code, admin.id, admin.name)).rejects.toBeInstanceOf(ConflictException);
    await expect(prisma.valePass.update({ where: { id: legacy.id }, data: { status: 'USED', usedAt: new Date() } })).rejects.toThrow(/vale_pass_use_blocked:/);
    expect((await voucher(legacy.id)).status).toBe('ACTIVE');
  });

  test('cancelar e restaurar não removem o bloqueio; bloquear não cancela', async () => {
    const u = await newUnit();
    await block(u.closet);
    await vouchersService.cancel(u.closet.code, 'cancelamento administrativo (teste)', admin.id, admin.name);
    expect(await voucher(u.closet.id)).toMatchObject({ status: 'CANCELLED' });
    expect((await voucher(u.closet.id)).blockedAt).not.toBeNull();
    await vouchersService.restore(u.closet.code, 'restauração administrativa (teste)', admin.id, admin.name);
    expect(await voucher(u.closet.id)).toMatchObject({ status: 'ACTIVE' });
    expect((await voucher(u.closet.id)).blockedAt).not.toBeNull(); // continua bloqueado
    await expect(redeem(u.closet, 100)).rejects.toBeInstanceOf(ConflictException);
  });

  test('e-mail: voucher bloqueado não tem o código enviado (precisa de atenção)', async () => {
    const u = await newUnit();
    await prisma.valePassOrder.create({ data: { shopifyOrderId: u.orderId, status: 'CONFIRMED', quantity: 1, lastSyncSource: 'test' } });
    await block(u.closet);
    expect(await evaluateGroup(prisma, u.orderId, u.groupId)).toMatchObject({ ok: false, outcome: 'NEEDS_ATTENTION', reason: 'voucher_blocked' });
    await unblock(u.closet);
    expect(await evaluateGroup(prisma, u.orderId, u.groupId)).toMatchObject({ ok: true });
  });
});

localDescribe('desbloquear: nunca ignora cancelamento, expiração, uso nem revisão de reembolso', () => {
  test('desbloqueio devolve o resgate, sem mexer em saldo; histórico mostra os dois eventos', async () => {
    const u = await newUnit();
    await block(u.showroom);
    const preview = await blocks.prepareUnblock(u.showroom.code, admin);
    expect(preview).toMatchObject({ canProceed: true, blocked: true, stillRestricted: [] });
    const done = await unblock(u.showroom, { operationId: preview.operationId });
    expect(done).toMatchObject({ blocked: false, status: 'ACTIVE', balanceCents: 50_000, event: { seq: 2, kind: 'UNBLOCK' } });
    expect(await voucher(u.showroom.id)).toMatchObject({ blockedAt: null, blockedBy: null, blockReason: null });
    await expect(redeem(u.showroom, 10_000)).resolves.toMatchObject({ balanceCents: 40_000 });
    expect((await events(u.showroom.id)).map((e) => [e.seq, e.kind, e.balanceCents])).toEqual([[1, 'BLOCK', 50_000], [2, 'UNBLOCK', 50_000]]);
    expect(await prisma.adminAuditEvent.count({ where: { entityId: u.showroom.id, action: 'VALE_PASS_UNBLOCKED', isCritical: true } })).toBe(1);
  });

  test('voucher cancelado: desbloqueio recusado (serviço e banco); continua cancelado e bloqueado', async () => {
    const u = await newUnit();
    await block(u.closet);
    await vouchersService.cancel(u.closet.code, 'cancelamento administrativo (teste)', admin.id, admin.name);
    expect((await blocks.prepareUnblock(u.closet.code, admin)).problems.map((p) => p.code)).toContain('CANCELLED');
    expect((await rejection(unblock(u.closet)))?.response?.code).toBe('CANCELLED');
    await expect(prisma.valePassBlockEvent.create({ data: { valePassId: u.closet.id, seq: 1, kind: 'UNBLOCK', reason: 'tentativa direta no banco', idempotencyKey: op() } })).rejects.toThrow(/vale_pass_unblock_cancelled/);
    expect(await voucher(u.closet.id)).toMatchObject({ status: 'CANCELLED' });
    expect((await voucher(u.closet.id)).blockedAt).not.toBeNull();
  });

  test('reembolso em revisão: desbloqueio espera a decisão (serviço e banco); resolvida a revisão, desbloqueia', async () => {
    const u = await newUnit();
    await block(u.showroom);
    const review = await prisma.valePassRefundApplication.create({ data: { shopifyRefundId: `${TAG}-rf-${counter++}`, shopifyOrderId: u.orderId, classification: 'UNITS', refundedUnits: 1, status: 'NEEDS_REVIEW', reviewReasons: ['UNIT_CONFIRMATION_REQUIRED'], detail: { reviewGroupIds: [u.groupId] } } });
    expect((await rejection(unblock(u.showroom)))?.response?.code).toBe('REFUND_UNDER_REVIEW');
    await expect(prisma.valePassBlockEvent.create({ data: { valePassId: u.showroom.id, seq: 1, kind: 'UNBLOCK', reason: 'tentativa direta no banco', idempotencyKey: op() } })).rejects.toThrow(/vale_pass_unblock_refund_review/);
    expect((await voucher(u.showroom.id)).blockedAt).not.toBeNull();
    await prisma.valePassRefundApplication.update({ where: { id: review.id }, data: { status: 'RESOLVED', resolution: 'KEEP_VOUCHERS', resolvedAt: new Date(), resolvedBy: randomUUID(), resolutionNote: 'decisão do administrador (teste)' } });
    await expect(unblock(u.showroom)).resolves.toMatchObject({ blocked: false });
  });

  test('voucher expirado: desbloquear é permitido, mas NADA é reativado (continua expirado e sem resgate)', async () => {
    const u = await newUnit({ expiresAt: new Date(Date.now() - 3_600_000) });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica'); // início de uso no passado para o cenário
      await tx.$executeRaw`UPDATE vale_passes SET valid_from = now() - interval '2 days' WHERE id = ${u.showroom.id}::uuid`;
    });
    await block(u.showroom);
    const preview = await blocks.prepareUnblock(u.showroom.code, admin);
    expect(preview).toMatchObject({ canProceed: true });
    expect(preview.stillRestricted.map((r) => r.code)).toContain('EXPIRED');
    await unblock(u.showroom);
    expect((await redemption.lookup(u.showroom.code, admin)).restrictions.map((r) => r.code)).toContain('EXPIRED');
    expect((await rejection(redeem(u.showroom, 100)))?.response?.code).toBe('EXPIRED');
  });

  test('desbloquear voucher que não está bloqueado e bloquear de novo são recusados (409)', async () => {
    const u = await newUnit();
    expect((await rejection(unblock(u.showroom)))?.response?.code).toBe('NOT_BLOCKED');
    await block(u.showroom);
    expect((await rejection(block(u.showroom)))?.response?.code).toBe('ALREADY_BLOCKED');
    expect(await events(u.showroom.id)).toHaveLength(1);
  });

  test('pedido cancelado/reembolsado: o voucher não é desbloqueado', async () => {
    const u = await newUnit();
    await block(u.showroom);
    await prisma.valePassOrderCancellation.create({ data: { shopifyOrderId: u.orderId, topic: 'orders/cancelled' } });
    expect((await rejection(unblock(u.showroom)))?.response?.code).toBe('ORDER_CANCELLED');
  });
});

localDescribe('idempotência, permissões e entrada', () => {
  test('mesma operação repetida = resultado original (sem novo evento); mesma chave com outro conteúdo = 409; 8 em paralelo = um evento', async () => {
    const u = await newUnit();
    const operationId = op();
    const first = await block(u.showroom, { operationId });
    const again = await block(u.showroom, { operationId });
    expect(again).toMatchObject({ replayed: true, event: { id: first.event.id } });
    expect((await rejection(block(u.showroom, { operationId, reason: 'Outra justificativa diferente' })))?.response?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await rejection(unblock(u.showroom, { operationId })))?.response?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await events(u.showroom.id)).toHaveLength(1);
    const u2 = await newUnit();
    const same = op();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => block(u2.showroom, { operationId: same })));
    expect(results.filter((r) => r.status === 'fulfilled' && !r.value.replayed)).toHaveLength(1);
    expect(await events(u2.showroom.id)).toHaveLength(1);
  });

  test('STAFF não bloqueia nem desbloqueia (403); código de confirmação errado, justificativa curta/longa e código inexistente/malformado recusados', async () => {
    const u = await newUnit();
    await expect(blocks.prepareBlock(u.showroom.code, staff)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(blocks.confirmBlock(u.showroom.code, { reason: REASON, operationId: op(), confirmCode: u.showroom.code }, staff)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(blocks.prepareUnblock(u.showroom.code, staff)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(block(u.showroom, { confirmCode: 'VALLE-ERRO-ERRO' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(block(u.showroom, { reason: 'curta' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(block(u.showroom, { reason: 'x'.repeat(501) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(blocks.prepareBlock('VALLE-ZZZZ-ZZZZ', admin)).rejects.toBeInstanceOf(NotFoundException);
    await expect(blocks.prepareBlock("' OR 1=1 --", admin)).rejects.toBeInstanceOf(NotFoundException);
    expect(await events(u.showroom.id)).toHaveLength(0);
    expect((await voucher(u.showroom.id)).blockedAt).toBeNull();
  });

  test('contrato HTTP: as 4 rotas exigem ADMIN; validação de entrada do corpo', async () => {
    const proto = ValePassLedgerController.prototype as unknown as Record<string, object>;
    for (const name of ['prepareBlock', 'block', 'prepareUnblock', 'unblock']) expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto[name]), name).toBe('ADMIN');
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const ok = { reason: REASON, operationId: 'op-12345678', confirmCode: 'VALLE-AAAA-BBBB' };
    await expect(pipe.transform(ok, { type: 'body', metatype: ConfirmBlockDto })).resolves.toBeTruthy();
    for (const bad of [{ reason: 'curta' }, { operationId: "x'; DROP" }, { confirmCode: 'abc' }, { blocked: true }, { reason: 'x'.repeat(501) }]) {
      await expect(pipe.transform({ ...ok, ...bad }, { type: 'body', metatype: ConfirmBlockDto }), JSON.stringify(bad)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  test('falha no meio (auditoria não grava): tudo é desfeito — sem evento, sem bloqueio; 503 neutro', async () => {
    const u = await newUnit();
    const ghost: Actor = { id: randomUUID(), name: 'Operador removido', role: 'ADMIN' };
    const err = await rejection(block(u.showroom, {}, ghost));
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err?.message).not.toMatch(/VALLE-|vale_pass|prisma/i);
    expect(await events(u.showroom.id)).toHaveLength(0);
    expect((await voucher(u.showroom.id)).blockedAt).toBeNull();
  });
});

localDescribe('o banco protege o bloqueio e o histórico', () => {
  test('UPDATE direto de blocked_* recusado; histórico imutável (UPDATE/DELETE/TRUNCATE); justificativa e chave validadas; seq e saldo calculados pelo banco', async () => {
    const u = await newUnit();
    await expect(prisma.valePass.update({ where: { id: u.showroom.id }, data: { blockedAt: new Date(), blockReason: 'por fora do histórico' } })).rejects.toThrow(/vale_pass_block_direct_update/);
    await expect(prisma.valePassBlockEvent.create({ data: { valePassId: u.showroom.id, seq: 1, kind: 'BLOCK', reason: 'curta', idempotencyKey: op() } })).rejects.toThrow(/reason_len|23514/);
    await expect(prisma.valePassBlockEvent.create({ data: { valePassId: u.showroom.id, seq: 1, kind: 'BLOCK', reason: REASON, idempotencyKey: 'curta' } })).rejects.toThrow(/idempotency_key_len|23514/);
    const e = await prisma.valePassBlockEvent.create({ data: { valePassId: u.showroom.id, seq: 99, kind: 'BLOCK', reason: REASON, idempotencyKey: op(), balanceCents: 7 } });
    expect(e).toMatchObject({ seq: 1, balanceCents: 50_000 }); // seq e retrato do saldo vêm do gatilho, não do cliente
    await expect(prisma.valePassBlockEvent.update({ where: { id: e.id }, data: { reason: 'alterado depois do fato' } })).rejects.toThrow(/vale_pass_block_immutable/);
    await expect(prisma.valePassBlockEvent.deleteMany({ where: { valePassId: u.showroom.id } })).rejects.toThrow(/vale_pass_block_immutable/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE vale_pass_block_events')).rejects.toThrow(/vale_pass_block_immutable/);
    await expect(prisma.valePassBlockEvent.create({ data: { valePassId: u.showroom.id, seq: 1, kind: 'BLOCK', reason: REASON, idempotencyKey: op() } })).rejects.toThrow(/vale_pass_block_already_blocked/);
    await expect(prisma.valePass.delete({ where: { id: u.showroom.id } })).rejects.toThrow(); // FK do histórico
  });
});

localDescribe('concorrência: resgate × bloqueio × desbloqueio', () => {
  test('20 rodadas: resgates simultâneos ao bloqueio — nenhum resgate passa depois do bloqueio; saldo = valor + Σ lançamentos; conciliação vazia', async () => {
    for (let round = 0; round < 20; round++) {
      const u = await newUnit();
      const results = await Promise.allSettled([
        ...Array.from({ length: 5 }, () => redemption.confirmRedeem(u.showroom.code, { company: 'VALLE_SHOWROOM', amountCents: 1_000, reference: 'x', operationId: op(), expectedBalanceCents: 50_000, confirmAmountCents: 1_000 }, admin)),
        block(u.showroom),
      ]);
      expect(results[5].status).toBe('fulfilled');
      const v = await voucher(u.showroom.id);
      expect(v.blockedAt).not.toBeNull();
      const sum = (await prisma.valePassLedgerEntry.findMany({ where: { valePassId: v.id } })).reduce((acc, e) => acc + e.deltaCents, 0);
      expect(v.balanceCents).toBe(v.amountCents + sum);
      const before = v.balanceCents;
      await expect(redeem(u.showroom, 100)).rejects.toBeInstanceOf(ConflictException); // depois do bloqueio, nenhum resgate
      expect((await voucher(v.id)).balanceCents).toBe(before);
    }
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('desbloqueio simultâneo a resgates: só passam resgates depois do desbloqueio; invariantes mantidas; sem deadlock em operações mistas', async () => {
    let deadlocks = 0;
    for (let round = 0; round < 15; round++) {
      const u = await newUnit();
      await block(u.showroom);
      const ops: Promise<unknown>[] = [
        unblock(u.showroom),
        block(u.closet),
        ...Array.from({ length: 4 }, () => redemption.confirmRedeem(u.showroom.code, { company: 'VALLE_SHOWROOM', amountCents: 1_000, reference: 'x', operationId: op(), expectedBalanceCents: 50_000, confirmAmountCents: 1_000 }, admin)),
        vouchersService.cancel(u.closet.code, 'cancelamento de estresse', admin.id, admin.name),
        vouchersService.restore(u.closet.code, 'restauração de estresse', admin.id, admin.name),
        prisma.valePassRefundApplication.create({ data: { shopifyRefundId: `${TAG}-rf-${counter++}`, shopifyOrderId: u.orderId, classification: 'UNITS', refundedUnits: 1, status: 'NEEDS_REVIEW', reviewReasons: ['UNIT_CONFIRMATION_REQUIRED'], detail: { reviewGroupIds: [u.groupId] } } }),
      ];
      for (const r of await Promise.allSettled(ops)) if (r.status === 'rejected' && /deadlock|40P01/i.test(String(r.reason))) deadlocks++;
    }
    expect(deadlocks).toBe(0);
    expect(await ledger.reconcile()).toEqual([]);
  });
});
