import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import type { ValePass } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { REQUIRE_ROLE_KEY } from '../../admin/require-role.decorator';
import { REQUIRE_MODULE_KEY } from '../../admin/require-module.decorator';
import { ValePassVouchersService } from '../vale-pass-vouchers.service';
import { ConfirmRedeemDto, ConfirmReverseDto, PrepareRedeemDto } from '../dto/voucher-balance.dto';
import { ValePassLedgerController } from './ledger.controller';
import { ValePassLedgerService } from './ledger.service';
import { ValePassRedemptionService, type Actor } from './redemption.service';
import { grantAllCompaniesForTest, purgeLedgerForTest } from './ledger-test-utils';

/**
 * Fase 3 / PR B — resgate parcial e reversão (serviço), em PostgreSQL LOCAL descartável. O serviço valida tudo no backend; os gatilhos do PR A são a rede de baixo.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const service = new ValePassRedemptionService(prisma);
const ledger = new ValePassLedgerService(prisma);
const vouchersService = new ValePassVouchersService(prisma);
const TAG = `VPRD-${Date.now()}`;
let counter = 0;
let admin: Actor;
const staff = { id: randomUUID(), name: 'Funcionário Teste', role: 'STAFF' } as { id: string; name: string; role: 'STAFF' };
const campaignIds: string[] = [];
const orderIds: string[] = [];
const REF = 'Nota 123 (teste)';

interface Unit { campaignId: string; orderId: string; groupId: string; showroom: ValePass; closet: ValePass }
async function newUnit(over: { validFrom?: Date | null; expiresAt?: Date; customer?: boolean } = {}): Promise<Unit> {
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
  const groupId = randomUUID();
  const common = {
    campaignId: campaign.id, groupId, shopifyOrderId: orderId, shopifyOrderName: '#T1001', status: 'ACTIVE' as const, purchasedAt: new Date(),
    expiresAt: over.expiresAt ?? new Date('2027-10-01T03:00:00Z'), validFrom: over.validFrom === undefined ? new Date('2026-01-01T03:00:00Z') : over.validFrom,
    ...(over.customer === false ? {} : { customerName: 'Maria da Silva Souza', customerPhone: '+55 11 91234-5678', customerEmail: 'maria.souza@exemplo.invalid' }),
  };
  const showroom = await prisma.valePass.create({ data: { ...common, code: `VALLE-${TAG.slice(-4)}-A${counter++}`.toUpperCase(), amountCents: 50_000, company: 'VALLE_SHOWROOM', benefitId: b1.id } });
  const closet = await prisma.valePass.create({ data: { ...common, code: `VALLE-${TAG.slice(-4)}-B${counter++}`.toUpperCase(), amountCents: 5_000, company: 'VS_BY_CLOSET', benefitId: b2.id } });
  return { campaignId: campaign.id, orderId, groupId, showroom, closet };
}

const voucher = (id: string) => prisma.valePass.findUniqueOrThrow({ where: { id } });
const entries = (id: string) => prisma.valePassLedgerEntry.findMany({ where: { valePassId: id }, orderBy: { seq: 'asc' } });
const op = () => `op-${randomUUID()}`;
type Redeem = { company?: string; amountCents: number; reference?: string; operationId?: string; expectedBalanceCents?: number; confirmAmountCents?: number; identityChecked?: boolean };
/** Resgate completo pelo caminho de produção: prévia + confirmação (saldo esperado = o lido agora). */
async function redeem(v: ValePass, amountCents: number, over: Partial<Redeem> = {}, actor: Actor = admin) {
  const current = await voucher(v.id);
  return service.confirmRedeem(v.code, {
    company: v.company as string, amountCents, reference: REF, operationId: op(), expectedBalanceCents: current.balanceCents, confirmAmountCents: amountCents, ...over,
  }, actor);
}
const rejection = async (promise: Promise<unknown>) => promise.then(() => null, (err: unknown) => err as { status?: number; response?: { code?: string; balanceCents?: number }; message: string });

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
    await tx.valePass.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaignBenefit.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaign.deleteMany({ where: { id: { in: ids } } });
  });
}
beforeAll(async () => {
  if (!localDatabase) return;
  const row = await prisma.adminUser.create({ data: { name: 'Admin Teste Resgate', phone: `${TAG}-admin`, pinHash: 'x', role: 'ADMIN', active: true } });
  await grantAllCompaniesForTest(prisma, row.id); // a política exige vínculo para ADMIN resgatar
  admin = { id: row.id, name: row.name, role: 'ADMIN' };
  const staffRow = await prisma.adminUser.create({ data: { name: staff.name, phone: `${TAG}-staff`, pinHash: 'x', role: 'STAFF', active: true } });
  staff.id = staffRow.id;
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

localDescribe('resgate parcial — exemplos obrigatórios', () => {
  test('Valle Showroom: R$ 500 → resgata R$ 200 (saldo R$ 300) → resgata R$ 100 (saldo R$ 200); VS BY CLOSET: R$ 50 → R$ 20 (saldo R$ 30); saldos nunca se misturam', async () => {
    const u = await newUnit();
    const a = await redeem(u.showroom, 20_000);
    expect(a).toMatchObject({ replayed: false, balanceCents: 30_000, usedCents: 20_000, status: 'ACTIVE', entry: { seq: 1, kind: 'REDEEM', deltaCents: -20_000, balanceAfterCents: 30_000, company: 'VALLE_SHOWROOM', reference: REF, actorName: admin.name, reversed: false } });
    const b = await redeem(u.showroom, 10_000);
    expect(b).toMatchObject({ balanceCents: 20_000, usedCents: 30_000, entry: { seq: 2 } });
    const c = await redeem(u.closet, 2_000);
    expect(c).toMatchObject({ balanceCents: 3_000, usedCents: 2_000, entry: { company: 'VS_BY_CLOSET', seq: 1 } });
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 20_000 });
    expect(await voucher(u.closet.id)).toMatchObject({ balanceCents: 3_000 });
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('resgate total vira USED; depois disso nada mais; a consulta mostra tudo (saldo, usado, histórico) e o voucher sem saldo não é "resgatável"', async () => {
    const u = await newUnit();
    await redeem(u.closet, 3_000);
    const last = await redeem(u.closet, 2_000);
    expect(last).toMatchObject({ balanceCents: 0, status: 'USED', usedCents: 5_000 });
    const view = await service.lookup(u.closet.code, admin);
    expect(view).toMatchObject({ amountCents: 5_000, balanceCents: 0, usedCents: 5_000, redeemable: false, company: 'VS_BY_CLOSET', status: 'USED' });
    expect(view.restrictions.map((r) => r.code)).toContain('USED_UP');
    expect(view.entries.map((e) => e.seq)).toEqual([2, 1]); // mais recente primeiro
    const err = await rejection(redeem(u.closet, 100));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err?.response?.code).toBe('USED_UP');
  });
});

localDescribe('duas etapas: a confirmação revalida TUDO', () => {
  test('a prévia não grava nada e devolve operationId + saldo esperado; prévia antiga (saldo mudou) é recusada na confirmação', async () => {
    const u = await newUnit();
    const preview = await service.prepareRedeem(u.showroom.code, { company: 'VALLE_SHOWROOM', amountCents: 20_000, reference: REF }, admin);
    expect(preview).toMatchObject({ canRedeem: true, balanceBeforeCents: 50_000, balanceAfterCents: 30_000, expectedBalanceCents: 50_000, problems: [] });
    expect(preview.operationId.length).toBeGreaterThanOrEqual(8);
    expect(await entries(u.showroom.id)).toHaveLength(0);
    await redeem(u.showroom, 15_000); // outro operador usou no meio
    const err = await rejection(service.confirmRedeem(u.showroom.code, { company: 'VALLE_SHOWROOM', amountCents: 20_000, reference: REF, operationId: preview.operationId, expectedBalanceCents: preview.expectedBalanceCents, confirmAmountCents: 20_000 }, admin));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err?.response).toMatchObject({ code: 'BALANCE_CHANGED', balanceCents: 35_000 });
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 35_000 });
  });

  test('prévia avisa o que impediria (empresa errada, saldo insuficiente) sem gravar', async () => {
    const u = await newUnit();
    const wrong = await service.prepareRedeem(u.showroom.code, { company: 'VS_BY_CLOSET', amountCents: 100, reference: REF }, admin);
    expect(wrong).toMatchObject({ canRedeem: false, balanceAfterCents: null });
    expect(wrong.problems.map((p) => p.code)).toEqual(['COMPANY_MISMATCH']);
    const big = await service.prepareRedeem(u.closet.code, { company: 'VS_BY_CLOSET', amountCents: 5_001, reference: REF }, admin);
    expect(big.problems.map((p) => p.code)).toEqual(['INSUFFICIENT_BALANCE']);
    expect(await entries(u.closet.id)).toHaveLength(0);
  });

  test('a confirmação exige que o valor seja digitado de novo (confirmAmountCents igual) e a referência', async () => {
    const u = await newUnit();
    await expect(redeem(u.showroom, 20_000, { confirmAmountCents: 2_000 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(redeem(u.showroom, 20_000, { reference: '  ' })).rejects.toBeInstanceOf(BadRequestException);
    expect(await entries(u.showroom.id)).toHaveLength(0);
  });
});

localDescribe('valores: só centavos inteiros positivos; nunca acima do saldo', () => {
  test.each([[0], [-100], [350.5], [NaN], [Infinity], [1e21], [100_000_001]])('valor %s é recusado (400) e nada é gravado', async (value) => {
    const u = await newUnit();
    await expect(redeem(u.showroom, value as number, { confirmAmountCents: value as number })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.prepareRedeem(u.showroom.code, { company: 'VALLE_SHOWROOM', amountCents: value as number, reference: REF }, admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(await entries(u.showroom.id)).toHaveLength(0);
  });

  test('texto no lugar de número é recusado; valores de borda: 1 centavo e o saldo exato passam, saldo + 1 não', async () => {
    const u = await newUnit();
    await expect(redeem(u.closet, '100' as unknown as number)).rejects.toBeInstanceOf(BadRequestException);
    const over = await rejection(redeem(u.closet, 5_001));
    expect(over?.response).toMatchObject({ code: 'INSUFFICIENT_BALANCE', balanceCents: 5_000 });
    await expect(redeem(u.closet, 1)).resolves.toMatchObject({ balanceCents: 4_999 });
    await expect(redeem(u.closet, 4_999)).resolves.toMatchObject({ balanceCents: 0, status: 'USED' });
  });
});

localDescribe('idempotência e concorrência', () => {
  test('a mesma operação repetida devolve o resultado original e NÃO desconta de novo; mesma chave com conteúdo diferente = 409', async () => {
    const u = await newUnit();
    const operationId = op();
    const first = await redeem(u.showroom, 20_000, { operationId });
    const again = await service.confirmRedeem(u.showroom.code, { company: 'VALLE_SHOWROOM', amountCents: 20_000, reference: REF, operationId, expectedBalanceCents: 50_000, confirmAmountCents: 20_000 }, admin);
    expect(again).toMatchObject({ replayed: true, entry: { id: first.entry.id }, balanceCents: 30_000 });
    expect(await entries(u.showroom.id)).toHaveLength(1);
    const diffAmount = await rejection(service.confirmRedeem(u.showroom.code, { company: 'VALLE_SHOWROOM', amountCents: 10_000, reference: REF, operationId, expectedBalanceCents: 30_000, confirmAmountCents: 10_000 }, admin));
    expect(diffAmount).toBeInstanceOf(ConflictException);
    expect(diffAmount?.response?.code).toBe('IDEMPOTENCY_CONFLICT');
    const diffRef = await rejection(service.confirmRedeem(u.showroom.code, { company: 'VALLE_SHOWROOM', amountCents: 20_000, reference: 'Outra nota', operationId, expectedBalanceCents: 30_000, confirmAmountCents: 20_000 }, admin));
    expect(diffRef?.response?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 30_000 });
  });

  test('requisição administrativa duplicada em paralelo (mesma chave, 8 vezes): um único lançamento; as demais voltam como repetição ou "em andamento"', async () => {
    const u = await newUnit();
    const operationId = op();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => redeem(u.showroom, 20_000, { operationId, expectedBalanceCents: 50_000 })));
    expect(results.filter((r) => r.status === 'fulfilled' && !r.value.replayed)).toHaveLength(1);
    expect(await entries(u.showroom.id)).toHaveLength(1);
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 30_000 });
  });

  test('dez operadores com a MESMA prévia (saldo esperado igual): exatamente um confirma; os outros veem BALANCE_CHANGED; saldo nunca negativo', async () => {
    const u = await newUnit();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => redeem(u.showroom, 30_000, { expectedBalanceCents: 50_000 })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect((r.reason as { response?: { code?: string } }).response?.code).toBe('BALANCE_CHANGED');
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 20_000 });
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('resgates simultâneos com saldo lido na hora: nunca passam do saldo (total gasto ≤ R$ 500), cada um idempotente', async () => {
    const u = await newUnit();
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, async () => {
        const fresh = await voucher(u.showroom.id);
        return service.confirmRedeem(u.showroom.code, { company: 'VALLE_SHOWROOM', amountCents: 12_000, reference: REF, operationId: op(), expectedBalanceCents: fresh.balanceCents, confirmAmountCents: 12_000 }, admin);
      }),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const v = await voucher(u.showroom.id);
    expect(v.balanceCents).toBe(50_000 - ok * 12_000);
    expect(v.balanceCents).toBeGreaterThanOrEqual(0);
    expect(ok).toBeLessThanOrEqual(4);
    expect(await ledger.reconcile()).toEqual([]);
  });
});

localDescribe('empresa e restrições do voucher', () => {
  test('empresa informada diferente da do voucher: 409 COMPANY_MISMATCH; o saldo de uma empresa nunca é usado na outra', async () => {
    const u = await newUnit();
    const err = await rejection(redeem(u.showroom, 100, { company: 'VS_BY_CLOSET' }));
    expect(err?.response?.code).toBe('COMPANY_MISMATCH');
    const err2 = await rejection(redeem(u.closet, 100, { company: 'VALLE_SHOWROOM' }));
    expect(err2?.response?.code).toBe('COMPANY_MISMATCH');
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 50_000 });
    expect(await voucher(u.closet.id)).toMatchObject({ balanceCents: 5_000 });
  });

  test.each([
    ['CANCELLED', async (u: Unit) => { await prisma.valePass.update({ where: { id: u.showroom.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'teste' } }); }],
    ['EXPIRED', async (u: Unit) => { await prisma.valePass.update({ where: { id: u.showroom.id }, data: { status: 'EXPIRED' } }); }],
    ['BLOCKED', async (u: Unit) => { await prisma.valePassBlockEvent.create({ data: { valePassId: u.showroom.id, seq: 1, kind: 'BLOCK', reason: 'suspeita de fraude (teste)', idempotencyKey: `blk-${randomUUID()}` } }); }],
    ['ORDER_CANCELLED', async (u: Unit) => { await prisma.valePassOrderCancellation.create({ data: { shopifyOrderId: u.orderId, topic: 'orders/cancelled' } }); }],
    ['REFUND_UNDER_REVIEW', async (u: Unit) => { await prisma.valePassRefundApplication.create({ data: { shopifyRefundId: `${TAG}-rf-${counter++}`, shopifyOrderId: u.orderId, classification: 'UNITS', refundedUnits: 1, status: 'NEEDS_REVIEW', reviewReasons: ['UNIT_CONFIRMATION_REQUIRED'], detail: { reviewGroupIds: [u.groupId] } } }); }],
  ])('voucher %s: resgate recusado (409) com o código do motivo; nada muda', async (code, arrange) => {
    const u = await newUnit();
    await arrange(u);
    const err = await rejection(redeem(u.showroom, 100));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err?.response?.code).toBe(code);
    expect(await entries(u.showroom.id)).toHaveLength(0);
    const view = await service.lookup(u.showroom.code, admin);
    expect(view.redeemable).toBe(false);
    expect(view.restrictions.map((r) => r.code)).toContain(code);
  });

  test('fora da validade (data) e antes do início: recusados; legado (sem empresa) não tem saldo', async () => {
    const past = await newUnit({ expiresAt: new Date(Date.now() - 3_600_000), validFrom: new Date('2025-01-01') });
    expect((await rejection(redeem(past.showroom, 100)))?.response?.code).toBe('EXPIRED');
    const future = await newUnit({ validFrom: new Date(Date.now() + 86_400_000) });
    expect((await rejection(redeem(future.showroom, 100)))?.response?.code).toBe('NOT_YET_VALID');
    const u = await newUnit();
    const legacy = await prisma.valePass.create({ data: { code: `VALLE-${TAG.slice(-4)}-LEG${counter++}`.toUpperCase(), campaignId: u.campaignId, amountCents: 35_000, purchasedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) } });
    const err = await rejection(service.confirmRedeem(legacy.code, { company: 'VALLE_SHOWROOM', amountCents: 100, reference: REF, operationId: op(), expectedBalanceCents: 35_000, confirmAmountCents: 100 }, admin));
    expect(err?.response?.code).toBe('LEGACY_NO_BALANCE');
  });
});

localDescribe('autorização, privacidade e enumeração', () => {
  test('STAFF não resgata nem reverte (403) — não há vínculo operador↔empresa; consulta funciona com dados mascarados', async () => {
    const u = await newUnit();
    const body = { company: 'VALLE_SHOWROOM', amountCents: 100, reference: REF };
    await expect(service.prepareRedeem(u.showroom.code, body, staff)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.confirmRedeem(u.showroom.code, { ...body, operationId: op(), expectedBalanceCents: 50_000, confirmAmountCents: 100 }, staff)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.prepareReverse(u.showroom.code, randomUUID(), staff)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.confirmReverse(u.showroom.code, randomUUID(), { reason: 'tentativa sem permissão', operationId: op(), expectedBalanceCents: 0, confirmAmountCents: 1 }, staff)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await entries(u.showroom.id)).toHaveLength(0);
    const view = await service.lookup(u.showroom.code, staff);
    expect(view.holder).toEqual({ name: 'Maria S.', phoneMasked: '***78', emailMasked: 'm***@exemplo.invalid' });
    expect(JSON.stringify(view)).not.toMatch(/maria\.souza|91234|Silva/);
    const full = await service.lookup(u.showroom.code, admin);
    expect(full.holder.name).toBe('Maria da Silva Souza');
    expect(full.holder.phoneMasked).toBe('***78'); // telefone e e-mail completos nunca saem nestas respostas
  });

  test('o endpoint legado de "usado": STAFF não consome saldo de voucher novo (403); ADMIN pode (resgate integral pelo ledger); legado segue livre para STAFF', async () => {
    const u = await newUnit();
    await expect(vouchersService.markUsed(u.showroom.code, staff.id, staff.name, { role: 'STAFF' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(await entries(u.showroom.id)).toHaveLength(0);
    await expect(vouchersService.markUsed(u.showroom.code, admin.id, admin.name, { role: 'ADMIN' })).resolves.toMatchObject({ status: 'USED', balanceCents: 0 });
    expect(await entries(u.showroom.id)).toMatchObject([{ reference: 'LEGACY_USE_ENDPOINT' }]);
    const legacy = await prisma.valePass.create({ data: { code: `VALLE-${TAG.slice(-4)}-LEG${counter++}`.toUpperCase(), campaignId: u.campaignId, amountCents: 35_000, purchasedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) } });
    await expect(vouchersService.markUsed(legacy.code, staff.id, staff.name, { role: 'STAFF' })).resolves.toMatchObject({ status: 'USED' });
  });

  test('código inexistente e código malformado dão a MESMA resposta (404) — nenhuma pista para enumerar; nenhum dado vaza', async () => {
    const unknown = await rejection(service.lookup('VALLE-ZZZZ-ZZZZ', admin));
    const malformed = await rejection(service.lookup("' OR 1=1 --", admin));
    const empty = await rejection(service.lookup('', admin));
    for (const err of [unknown, malformed, empty]) {
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err?.message).toBe('Voucher não encontrado.');
    }
  });

  test('contrato HTTP: sessão administrativa + módulo VALLE_PASS em tudo; escrita e conciliação só ADMIN; consulta sem papel específico', () => {
    const proto = ValePassLedgerController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, ValePassLedgerController)).toBe('VALLE_PASS');
    for (const name of ['prepareReverse', 'reverse', 'reconcile']) expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto[name]), name).toBe('ADMIN');
    // Resgate: liberado ao módulo; a decisão por estabelecimento (STAFF só nas empresas vinculadas) é do serviço, por voucher.
    for (const name of ['prepareRedeem', 'redeem']) expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto[name]), name).toBeUndefined();
    for (const name of ['balance', 'history']) expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto[name]), name).toBeUndefined();
    const guards = Reflect.getMetadata('__guards__', ValePassLedgerController) as unknown[];
    expect(guards.map((g) => (g as { name: string }).name)).toEqual(['AdminAuthGuard', 'AdminRoleGuard']);
  });

  test('o SERVIÇO registra a conferência de identidade (informada ou não) no histórico e na auditoria, sem mudar o saldo nem entrar na idempotência (a exigência vive no controlador HTTP, testado abaixo)', async () => {
    const u = await newUnit();
    const first = await redeem(u.showroom, 10_000); // não informada
    expect(first.balanceCents).toBe(40_000);
    const second = await redeem(u.showroom, 5_000, { identityChecked: true });
    expect(second.balanceCents).toBe(35_000);
    const third = await redeem(u.showroom, 5_000, { identityChecked: false });
    expect(third.balanceCents).toBe(30_000);
    const events = await prisma.valePassEvent.findMany({ where: { valePassId: u.showroom.id, type: 'REDEEMED' }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => (e.detail as { identityChecked: boolean | null }).identityChecked)).toEqual([null, true, false]);
    const audits = await prisma.adminAuditEvent.findMany({ where: { entityId: u.showroom.id, action: 'VALE_PASS_REDEEMED' }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => (a.detail as { identityChecked: boolean | null }).identityChecked)).toEqual([null, true, false]);
    // Repetição da MESMA operação com outro valor da conferência: devolve o original, não desconta nem regrava o registro.
    const op1 = op();
    const original = await redeem(u.showroom, 1_000, { operationId: op1, identityChecked: true });
    const replay = await redeem(u.showroom, 1_000, { operationId: op1, identityChecked: false, expectedBalanceCents: 29_000 });
    expect(replay.replayed).toBe(true);
    expect(replay.entry.id).toBe(original.entry.id);
    expect(await prisma.valePassEvent.count({ where: { valePassId: u.showroom.id, type: 'REDEEMED' } })).toBe(4);
    expect((await voucher(u.showroom.id)).balanceCents).toBe(29_000);
    // O registro não guarda nada pessoal: só o booleano.
    expect(JSON.stringify([events, audits])).not.toMatch(/cpf|documento|passaporte|maria\.souza|91234|Silva/i);
  });

  test('validação de entrada (ValidationPipe do app): decimal, texto, campos extras, operationId inseguro e motivo curto são recusados', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const ok = { company: 'VALLE_SHOWROOM', amountCents: 20_000, reference: REF, operationId: 'op-12345678', expectedBalanceCents: 50_000, confirmAmountCents: 20_000 };
    await expect(pipe.transform(ok, { type: 'body', metatype: ConfirmRedeemDto })).resolves.toMatchObject({ amountCents: 20_000 });
    // Conferência de identidade: opcional e só booleana (nunca texto, número nem outro campo livre).
    await expect(pipe.transform({ ...ok, identityChecked: true }, { type: 'body', metatype: ConfirmRedeemDto })).resolves.toMatchObject({ identityChecked: true });
    await expect(pipe.transform({ ...ok, identityChecked: false }, { type: 'body', metatype: ConfirmRedeemDto })).resolves.toMatchObject({ identityChecked: false });
    for (const bad of [{ identityChecked: 'sim' }, { identityChecked: 1 }, { identityChecked: { cpf: '000' } }]) {
      await expect(pipe.transform({ ...ok, ...bad }, { type: 'body', metatype: ConfirmRedeemDto }), JSON.stringify(bad)).rejects.toBeInstanceOf(BadRequestException);
    }
    for (const bad of [{ amountCents: 200.5 }, { amountCents: '20000' }, { amountCents: 0 }, { amountCents: -5 }, { company: 'OUTRA' }, { reference: 'ab' }, { operationId: "x'; DROP" }, { operationId: 'curto' }, { expectedBalanceCents: -1 }, { confirmAmountCents: 1.5 }, { saldo: 99 }]) {
      await expect(pipe.transform({ ...ok, ...bad }, { type: 'body', metatype: ConfirmRedeemDto }), JSON.stringify(bad)).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(pipe.transform({ company: 'VALLE_SHOWROOM', amountCents: 100, reference: REF, extra: 1 }, { type: 'body', metatype: PrepareRedeemDto })).rejects.toBeInstanceOf(BadRequestException);
    const rv = { reason: 'lançado por engano na nota', operationId: 'op-12345678', expectedBalanceCents: 0, confirmAmountCents: 100 };
    await expect(pipe.transform(rv, { type: 'body', metatype: ConfirmReverseDto })).resolves.toBeTruthy();
    await expect(pipe.transform({ ...rv, reason: 'curto' }, { type: 'body', metatype: ConfirmReverseDto })).rejects.toBeInstanceOf(BadRequestException);
  });
});

localDescribe('reversão auditada', () => {
  test('reverte um resgate: devolve o saldo, mantém o histórico, reativa o voucher zerado; reversão repetida (mesma chave) é idempotente; segunda reversão = 409', async () => {
    const u = await newUnit();
    const used = await redeem(u.closet, 5_000); // zera → USED
    expect(await voucher(u.closet.id)).toMatchObject({ status: 'USED' });
    const prep = await service.prepareReverse(u.closet.code, used.entry.id, admin);
    expect(prep).toMatchObject({ canReverse: true, balanceBeforeCents: 0, balanceAfterCents: 5_000 });
    const operationId = op();
    const reversed = await service.confirmReverse(u.closet.code, used.entry.id, { reason: 'Resgate lançado por engano na nota 123', operationId, expectedBalanceCents: 0, confirmAmountCents: 5_000 }, admin);
    expect(reversed).toMatchObject({ replayed: false, balanceCents: 5_000, status: 'ACTIVE', entry: { kind: 'REVERSAL', deltaCents: 5_000, reversesEntryId: used.entry.id, actorName: admin.name } });
    expect(await entries(u.closet.id)).toHaveLength(2); // histórico preservado
    const replay = await service.confirmReverse(u.closet.code, used.entry.id, { reason: 'Resgate lançado por engano na nota 123', operationId, expectedBalanceCents: 0, confirmAmountCents: 5_000 }, admin);
    expect(replay).toMatchObject({ replayed: true, balanceCents: 5_000 });
    const second = await rejection(service.confirmReverse(u.closet.code, used.entry.id, { reason: 'Segunda tentativa de reversão', operationId: op(), expectedBalanceCents: 5_000, confirmAmountCents: 5_000 }, admin));
    expect(second).toBeInstanceOf(ConflictException);
    expect(second?.response?.code).toBe('ALREADY_REVERSED');
    const view = await service.lookup(u.closet.code, admin);
    expect(view.entries.find((e) => e.id === used.entry.id)).toMatchObject({ reversed: true });
    await expect(redeem(u.closet, 5_000)).resolves.toMatchObject({ balanceCents: 0 }); // volta a poder ser resgatado
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('recusas: valor digitado errado (400), motivo curto (400), lançamento de outro voucher/inexistente, reversão de reversão; mesma chave com motivo diferente = 409', async () => {
    const u = await newUnit();
    const a = await redeem(u.showroom, 10_000);
    const other = await redeem(u.closet, 1_000);
    const base = { reason: 'Reversão de teste com justificativa', operationId: op(), expectedBalanceCents: 40_000, confirmAmountCents: 10_000 };
    await expect(service.confirmReverse(u.showroom.code, a.entry.id, { ...base, confirmAmountCents: 9_999 }, admin)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.confirmReverse(u.showroom.code, a.entry.id, { ...base, reason: 'curta' }, admin)).rejects.toBeInstanceOf(BadRequestException);
    expect((await rejection(service.confirmReverse(u.showroom.code, other.entry.id, base, admin)))?.response?.code).toBe('ENTRY_NOT_FOUND');
    expect((await rejection(service.confirmReverse(u.showroom.code, 'não-é-uuid', base, admin)))?.response?.code).toBe('ENTRY_NOT_FOUND');
    expect((await rejection(service.confirmReverse(u.showroom.code, a.entry.id, { ...base, expectedBalanceCents: 1 }, admin)))?.response?.code).toBe('BALANCE_CHANGED');
    const done = await service.confirmReverse(u.showroom.code, a.entry.id, base, admin);
    expect((await rejection(service.confirmReverse(u.showroom.code, done.entry.id, { ...base, operationId: op(), expectedBalanceCents: 50_000 }, admin)))?.response?.code).toBe('NOT_A_REDEMPTION');
    expect((await rejection(service.confirmReverse(u.showroom.code, a.entry.id, { ...base, reason: 'Outro motivo diferente' }, admin)))?.response?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 50_000 });
  });

  test('reversões concorrentes do mesmo resgate: exatamente uma vale', async () => {
    const u = await newUnit();
    const a = await redeem(u.showroom, 10_000);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () =>
      service.confirmReverse(u.showroom.code, a.entry.id, { reason: 'Reversão concorrente de teste', operationId: op(), expectedBalanceCents: 40_000, confirmAmountCents: 10_000 }, admin)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 50_000 });
    expect((await entries(u.showroom.id)).filter((e) => e.kind === 'REVERSAL')).toHaveLength(1);
  });
});

localDescribe('auditoria, trilhas e falhas', () => {
  test('resgate grava evento do voucher e auditoria (código mascarado, sem dados pessoais); reversão é auditoria CRÍTICA', async () => {
    const u = await newUnit();
    const done = await redeem(u.showroom, 20_000);
    const events = await prisma.valePassEvent.findMany({ where: { valePassId: u.showroom.id } });
    expect(events).toMatchObject([{ type: 'REDEEMED', detail: { ledgerEntryId: done.entry.id, deltaCents: -20_000, balanceAfterCents: 30_000, actorId: admin.id } }]);
    await service.confirmReverse(u.showroom.code, done.entry.id, { reason: 'Reversão auditada de teste', operationId: op(), expectedBalanceCents: 30_000, confirmAmountCents: 20_000 }, admin);
    const audits = await prisma.adminAuditEvent.findMany({ where: { entityId: u.showroom.id }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => [a.action, a.isCritical])).toEqual([['VALE_PASS_REDEEMED', false], ['VALE_PASS_REDEMPTION_REVERSED', true]]);
    const dump = JSON.stringify([events, audits]);
    expect(dump).not.toContain(u.showroom.code); // só o código mascarado
    expect(dump).not.toMatch(/maria\.souza|91234|Silva/);
    expect(dump).toContain('VALLE-');
  });

  test('falha no meio (auditoria não consegue gravar): a transação inteira é desfeita — saldo, lançamento e status intactos; resposta 503 neutra', async () => {
    const u = await newUnit();
    const ghost: Actor = { id: randomUUID(), name: 'Operador removido', role: 'SUPER_ADMIN' }; // sem linha em admin_users (o proprietário passa pela autorização): a auditoria falha
    const err = await rejection(service.confirmRedeem(u.closet.code, { company: 'VS_BY_CLOSET', amountCents: 5_000, reference: REF, operationId: op(), expectedBalanceCents: 5_000, confirmAmountCents: 5_000 }, ghost));
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err?.message).not.toMatch(/VALLE-|vale_pass|prisma/i);
    expect(await voucher(u.closet.id)).toMatchObject({ balanceCents: 5_000, status: 'ACTIVE' });
    expect(await entries(u.closet.id)).toHaveLength(0);
  });

  test('alterar saldo "por fora" do serviço é impossível: UPDATE direto e status USED são recusados pelo banco', async () => {
    const u = await newUnit();
    await expect(prisma.valePass.update({ where: { id: u.showroom.id }, data: { balanceCents: 0 } })).rejects.toThrow(/vale_pass_balance_direct_update/);
    await expect(prisma.valePass.update({ where: { id: u.showroom.id }, data: { status: 'USED' } })).rejects.toThrow(/vale_pass_used_requires_zero_balance/);
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 50_000, status: 'ACTIVE' });
  });

  test('HTTP: resgate sem a conferência de identidade é recusado (400 IDENTITY_CHECK_REQUIRED) e NADA é gravado; com a conferência grava, registra o operador e repetir devolve o original', async () => {
    const u = await newUnit();
    const controller = new ValePassLedgerController(service, ledger, {} as never);
    const req = { adminUser: { id: admin.id, name: admin.name, role: 'ADMIN' } } as never;
    const body = (over: Record<string, unknown> = {}) => ({ company: 'VALLE_SHOWROOM', amountCents: 10_000, reference: REF, operationId: op(), expectedBalanceCents: 50_000, confirmAmountCents: 10_000, ...over });
    for (const over of [{}, { identityChecked: false }, { identityChecked: 'true' }]) {
      await expect(controller.redeem(u.showroom.code, body(over) as never, req)).rejects.toMatchObject({ status: 400, response: { code: 'IDENTITY_CHECK_REQUIRED' } });
    }
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 50_000, status: 'ACTIVE' });
    expect(await entries(u.showroom.id)).toHaveLength(0);
    expect(await prisma.valePassEvent.count({ where: { valePassId: u.showroom.id, type: 'REDEEMED' } })).toBe(0);
    // A autorização vem ANTES: STAFF sem vínculo recebe 403 mesmo sem a conferência (a recusa por identidade não substitui a de permissão).
    const staffReq = { adminUser: { id: staff.id, name: staff.name, role: 'STAFF' } } as never;
    await expect(controller.redeem(u.showroom.code, body() as never, staffReq)).rejects.toBeInstanceOf(ForbiddenException);
    // Empresa incorreta, mesmo com a conferência: 409 COMPANY_MISMATCH e nada gravado.
    await expect(controller.redeem(u.showroom.code, body({ company: 'VS_BY_CLOSET', identityChecked: true }) as never, req)).rejects.toMatchObject({ status: 409, response: { code: 'COMPANY_MISMATCH' } });
    expect(await entries(u.showroom.id)).toHaveLength(0);

    const same = body({ identityChecked: true });
    const first = await controller.redeem(u.showroom.code, same as never, req);
    const again = await controller.redeem(u.showroom.code, same as never, req);
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.entry.id).toBe(first.entry.id);
    expect(await entries(u.showroom.id)).toHaveLength(1);
    expect((await voucher(u.showroom.id)).balanceCents).toBe(40_000);
    const event = await prisma.valePassEvent.findFirstOrThrow({ where: { valePassId: u.showroom.id, type: 'REDEEMED' } });
    expect(event.detail).toMatchObject({ identityChecked: true, identityConfirmation: 'OPERATOR_IN_PERSON' });
    const audit = await prisma.adminAuditEvent.findFirstOrThrow({ where: { entityId: u.showroom.id, action: 'VALE_PASS_REDEEMED' } });
    expect(audit).toMatchObject({ adminUserId: admin.id });
    expect(audit.detail).toMatchObject({ identityChecked: true, identityConfirmation: 'OPERATOR_IN_PERSON' });
    // Nada de documento, foto ou dado pessoal novo no registro.
    expect(JSON.stringify([event.detail, audit.detail])).not.toMatch(/cpf|rg\b|documento|foto|maria\.souza|91234/i);
  });

  test('"usado" por inteiro (caminho HTTP) exige a conferência no voucher com empresa: sem ela, 400 e nada muda; com ela, grava o registro; STAFF segue recusado antes', async () => {
    const u = await newUnit();
    const refused = await rejection(vouchersService.markUsed(u.showroom.code, admin.id, admin.name, { role: 'ADMIN', requireIdentity: true, identityChecked: false }));
    expect(refused).toBeInstanceOf(BadRequestException);
    expect(refused?.response?.code).toBe('IDENTITY_CHECK_REQUIRED');
    expect(await voucher(u.showroom.id)).toMatchObject({ balanceCents: 50_000, status: 'ACTIVE' });
    expect(await entries(u.showroom.id)).toHaveLength(0);
    // STAFF: a recusa por papel vem antes (não revela nada sobre a conferência).
    await expect(vouchersService.markUsed(u.showroom.code, staff.id, staff.name, { role: 'STAFF', requireIdentity: true, identityChecked: true })).rejects.toBeInstanceOf(ForbiddenException);
    const used = await vouchersService.markUsed(u.showroom.code, admin.id, admin.name, { role: 'ADMIN', requireIdentity: true, identityChecked: true });
    expect(used.status).toBe('USED');
    const event = await prisma.valePassEvent.findFirstOrThrow({ where: { valePassId: u.showroom.id, type: 'USED' } });
    expect(event.detail).toMatchObject({ identityChecked: true });
  });

  test('lista restrita (operador sem privilégio): sem busca parcial por código nem por dados do cliente; código exato e pedido continuam achando', async () => {
    const u = await newUnit();
    const fragment = u.showroom.code.slice(0, 11); // "VALLE-XXXX"
    const restricted = (search: string) => vouchersService.list({ search }, { restricted: true });
    expect((await restricted(fragment)).filter((v) => v.code === u.showroom.code)).toHaveLength(0);
    expect((await restricted('maria.souza')).filter((v) => v.shopifyOrderId === u.orderId)).toHaveLength(0);
    expect((await restricted('91234')).filter((v) => v.shopifyOrderId === u.orderId)).toHaveLength(0);
    expect((await restricted(u.showroom.code.toLowerCase())).map((v) => v.code)).toEqual([u.showroom.code]);
    expect((await restricted(u.orderId)).map((v) => v.code).sort()).toEqual([u.closet.code, u.showroom.code].sort());
    // Administrador mantém a busca ampla.
    expect((await vouchersService.list({ search: fragment })).some((v) => v.code === u.showroom.code)).toBe(true);
    expect((await vouchersService.list({ search: 'maria.souza' })).some((v) => v.shopifyOrderId === u.orderId)).toBe(true);
  });
});
