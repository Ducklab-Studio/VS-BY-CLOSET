import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ValePass } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { REQUIRE_ROLE_KEY } from '../../admin/require-role.decorator';
import { ValePassVouchersService } from '../vale-pass-vouchers.service';
import { ValePassLedgerController } from './ledger.controller';
import { ValePassBlockService } from './block.service';
import { ValePassVouchersController } from '../vale-pass-vouchers.controller';
import { OPERATOR_POLICY } from './operator-scope';
import { ValePassOperatorScopeController } from './operator-scope.controller';
import { ValePassOperatorScopeService } from './operator-scope.service';
import { ValePassRedemptionService, type Actor } from './redemption.service';
import { ValePassLedgerService } from './ledger.service';
import { purgeLedgerForTest } from './ledger-test-utils';

/**
 * Resgate por estabelecimento: vínculo explícito operador↔empresa, validado no BACKEND (serviço e API direta), nunca só na tela. Banco LOCAL descartável.
 * Nenhum vínculo real é criado: todos os usuários e vínculos aqui são sintéticos e removidos ao final.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const redemption = new ValePassRedemptionService(prisma);
const scopes = new ValePassOperatorScopeService(prisma);
const vouchersService = new ValePassVouchersService(prisma);
const ledger = new ValePassLedgerService(prisma);
const TAG = `VPOS-${Date.now()}`;
let counter = 0;
const campaignIds: string[] = [];
const orderIds: string[] = [];
const userIds: string[] = [];
const REF = 'Nota 321 (teste)';

async function newUser(role: 'SUPER_ADMIN' | 'ADMIN' | 'STAFF', active = true): Promise<Actor & { id: string }> {
  const row = await prisma.adminUser.create({ data: { name: `${role} ${TAG}-${counter}`, phone: `${TAG}-${counter++}`, pinHash: 'x', role, active } });
  userIds.push(row.id);
  return { id: row.id, name: row.name, role };
}

interface Unit { campaignId: string; showroom: ValePass; closet: ValePass }
async function newUnit(): Promise<Unit> {
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
  const common = {
    campaignId: campaign.id, groupId: randomUUID(), shopifyOrderId: orderId, shopifyOrderName: '#T2001', status: 'ACTIVE' as const, purchasedAt: new Date(),
    expiresAt: new Date('2027-10-01T03:00:00Z'), validFrom: new Date('2026-01-01T03:00:00Z'), customerName: 'Maria da Silva Souza', customerPhone: '+55 11 91234-5678', customerEmail: 'maria.souza@exemplo.invalid',
  };
  const showroom = await prisma.valePass.create({ data: { ...common, code: `VALLE-${TAG.slice(-4)}-A${counter++}`.toUpperCase(), amountCents: 50_000, company: 'VALLE_SHOWROOM', benefitId: b1.id } });
  const closet = await prisma.valePass.create({ data: { ...common, code: `VALLE-${TAG.slice(-4)}-B${counter++}`.toUpperCase(), amountCents: 5_000, company: 'VS_BY_CLOSET', benefitId: b2.id } });
  return { campaignId: campaign.id, showroom, closet };
}

const entries = (id: string) => prisma.valePassLedgerEntry.findMany({ where: { valePassId: id }, orderBy: { seq: 'asc' } });
const voucher = (id: string) => prisma.valePass.findUniqueOrThrow({ where: { id } });
async function redeem(v: ValePass, actor: Actor, amountCents = 1_000, over: { company?: string } = {}) {
  return redemption.confirmRedeem(v.code, { company: over.company ?? (v.company as string), amountCents, reference: REF, operationId: `op-${randomUUID()}`, expectedBalanceCents: (await voucher(v.id)).balanceCents, confirmAmountCents: amountCents }, actor);
}
const rejection = (promise: Promise<unknown>) => promise.then(() => null, (err: unknown) => err as { status?: number; response?: { code?: string }; message: string });
const owner = async () => newUser('SUPER_ADMIN');

async function cleanRows() {
  const ids = campaignIds.splice(0);
  const orders = orderIds.splice(0);
  const users = userIds.splice(0);
  await prisma.$transaction(async (tx) => {
    const rows = await tx.valePass.findMany({ where: { campaignId: { in: ids } }, select: { id: true } });
    await purgeLedgerForTest(tx, { campaignIds: ids });
    await tx.valePassEvent.deleteMany({ where: { valePassId: { in: rows.map((r) => r.id) } } });
    await tx.adminAuditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...rows.map((r) => r.id), ...users] } }, { adminUserId: { in: users } }] } });
    await tx.valePassRefundApplication.deleteMany({ where: { shopifyOrderId: { in: orders } } });
    await tx.valePass.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaignBenefit.deleteMany({ where: { campaignId: { in: ids } } });
    await tx.valePassCampaign.deleteMany({ where: { id: { in: ids } } });
    await tx.valePassOperatorScope.deleteMany({ where: { adminUserId: { in: users } } });
    await tx.adminUser.deleteMany({ where: { id: { in: users } } });
  });
}
beforeAll(() => undefined);
afterEach(async () => {
  if (localDatabase) await cleanRows();
});
afterAll(async () => {
  if (localDatabase) await cleanRows();
  await prisma.$disconnect();
});

localDescribe('nenhum vínculo é criado por padrão', () => {
  test('usuários novos nascem sem nenhuma autorização de estabelecimento', async () => {
    const staff = await newUser('STAFF');
    const admin = await newUser('ADMIN');
    expect(await prisma.valePassOperatorScope.count({ where: { adminUserId: { in: [staff.id, admin.id] } } })).toBe(0);
  });

  test('STAFF sem estabelecimento autorizado não resgata nem reverte — nem pelo serviço, nem pela consulta de "usado" legada', async () => {
    const staff = await newUser('STAFF');
    const u = await newUnit();
    expect((await rejection(redeem(u.showroom, staff)))?.response?.code).toBe('NO_COMPANY_AUTHORIZED');
    expect((await rejection(redeem(u.closet, staff)))?.response?.code).toBe('NO_COMPANY_AUTHORIZED');
    await expect(redemption.prepareRedeem(u.showroom.code, { company: 'VALLE_SHOWROOM', amountCents: 100, reference: REF }, staff)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(vouchersService.markUsed(u.closet.code, staff.id, staff.name, { role: 'STAFF' })).rejects.toBeInstanceOf(ForbiddenException);
    // código inexistente: também 403 (quem não opera nada nem descobre se o código existe)
    await expect(redemption.prepareRedeem('VALLE-NAOEXISTE-0000', { company: 'VALLE_SHOWROOM', amountCents: 100, reference: REF }, staff)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await entries(u.showroom.id)).toHaveLength(0);
    expect(await entries(u.closet.id)).toHaveLength(0);
  });
});

localDescribe('isolamento entre Valle Showroom e VS BY CLOSET', () => {
  test('operador (ADMIN) vinculado só à Valle Showroom resgata o voucher dela e é recusado no da VS BY CLOSET — inclusive declarando a empresa errada (API direta)', async () => {
    const boss = await owner();
    const op = await newUser('ADMIN');
    await scopes.grant(op.id, 'VALLE_SHOWROOM', boss);
    const u = await newUnit();

    expect(await redeem(u.showroom, op, 2_000)).toMatchObject({ balanceCents: 48_000, entry: { company: 'VALLE_SHOWROOM' } });
    // resgate cruzado direto na API: código do voucher da VS BY CLOSET
    expect((await rejection(redeem(u.closet, op)))?.response?.code).toBe('COMPANY_NOT_AUTHORIZED');
    // tentando enganar com a empresa do próprio vínculo no corpo: a empresa vem do VOUCHER, não do pedido
    expect((await rejection(redeem(u.closet, op, 1_000, { company: 'VALLE_SHOWROOM' })))?.response?.code).toBe('COMPANY_NOT_AUTHORIZED');
    expect(await entries(u.closet.id)).toHaveLength(0);
    expect((await voucher(u.closet.id)).balanceCents).toBe(5_000);
    // a prévia também recusa
    await expect(redemption.prepareRedeem(u.closet.code, { company: 'VS_BY_CLOSET', amountCents: 100, reference: REF }, op)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('operador (ADMIN) vinculado às DUAS lojas opera as duas, com saldos separados', async () => {
    const boss = await owner();
    const op = await newUser('ADMIN');
    await scopes.grant(op.id, 'VALLE_SHOWROOM', boss);
    await scopes.grant(op.id, 'VS_BY_CLOSET', boss);
    const u = await newUnit();
    expect(await redeem(u.showroom, op, 10_000)).toMatchObject({ balanceCents: 40_000 });
    expect(await redeem(u.closet, op, 2_000)).toMatchObject({ balanceCents: 3_000 });
    expect((await voucher(u.showroom.id)).balanceCents).toBe(40_000);
    expect((await voucher(u.closet.id)).balanceCents).toBe(3_000);
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('os saldos das duas lojas NUNCA se misturam: cada lançamento fica na empresa do voucher e não há caminho para mover valor entre eles', async () => {
    const u = await newUnit();
    const admin = await owner(); // só o proprietário opera as duas empresas sem vínculo
    await redeem(u.showroom, admin, 7_000);
    await redeem(u.closet, admin, 1_500);
    const showroomRows = await entries(u.showroom.id);
    const closetRows = await entries(u.closet.id);
    expect(showroomRows.every((e) => e.company === 'VALLE_SHOWROOM')).toBe(true);
    expect(closetRows.every((e) => e.company === 'VS_BY_CLOSET')).toBe(true);
    // o saldo de cada voucher é exatamente o valor nominal menos o que ELE mesmo gastou
    expect((await voucher(u.showroom.id)).balanceCents).toBe(50_000 - 7_000);
    expect((await voucher(u.closet.id)).balanceCents).toBe(5_000 - 1_500);
    // resgate maior que o saldo do voucher da VS BY CLOSET é recusado mesmo que a Valle Showroom tenha saldo de sobra
    expect((await rejection(redeem(u.closet, admin, 4_000)))?.response?.code).toBe('INSUFFICIENT_BALANCE');
    // o banco recusa mexer no saldo por fora do livro-razão (nenhuma "transferência" de saldo por UPDATE direto)
    await expect(prisma.$executeRaw`UPDATE vale_passes SET balance_cents = balance_cents + 1000 WHERE id = ${u.closet.id}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE vale_passes SET company = 'VS_BY_CLOSET' WHERE id = ${u.showroom.id}::uuid`).rejects.toThrow();
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('revogar vale NA HORA: a prévia feita antes não autoriza a confirmação depois', async () => {
    const boss = await owner();
    const op = await newUser('ADMIN');
    await scopes.grant(op.id, 'VALLE_SHOWROOM', boss);
    const u = await newUnit();
    const preview = await redemption.prepareRedeem(u.showroom.code, { company: 'VALLE_SHOWROOM', amountCents: 1_000, reference: REF }, op);
    expect(preview.canRedeem).toBe(true);
    await scopes.revoke(op.id, 'VALLE_SHOWROOM', boss);
    // sem vínculo nenhum, o ADMIN volta ao acesso legado (política atual): a revogação restringe só quando há OUTRO vínculo. Para isolar de verdade, restringe à outra loja.
    await scopes.grant(op.id, 'VS_BY_CLOSET', boss);
    const err = await rejection(redemption.confirmRedeem(u.showroom.code, { company: 'VALLE_SHOWROOM', amountCents: 1_000, reference: REF, operationId: preview.operationId, expectedBalanceCents: preview.expectedBalanceCents, confirmAmountCents: 1_000 }, op));
    expect(err?.response?.code).toBe('COMPANY_NOT_AUTHORIZED');
    expect(await entries(u.showroom.id)).toHaveLength(0);
  });

  test('reversão segue a mesma regra: vinculado numa loja não reverte o resgate da outra', async () => {
    const boss = await owner();
    const showroomOp = await newUser('ADMIN');
    const closetOp = await newUser('ADMIN');
    await scopes.grant(showroomOp.id, 'VALLE_SHOWROOM', boss);
    await scopes.grant(closetOp.id, 'VS_BY_CLOSET', boss);
    const u = await newUnit();
    const a = await redeem(u.showroom, showroomOp, 5_000);
    const b = await redeem(u.closet, closetOp, 1_000);
    const reverse = (v: ValePass, entryId: string, actor: Actor) => redemption.confirmReverse(v.code, entryId, { reason: 'conferência de reversão', operationId: `op-${randomUUID()}`, expectedBalanceCents: 0, confirmAmountCents: 0 }, actor);
    await expect(redemption.prepareReverse(u.showroom.code, a.entry.id, closetOp)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(reverse(u.showroom, a.entry.id, closetOp)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(reverse(u.closet, b.entry.id, showroomOp)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await entries(u.showroom.id)).toHaveLength(1);
    expect(await entries(u.closet.id)).toHaveLength(1);
    // quem é da loja reverte o da própria loja
    const prep = await redemption.prepareReverse(u.showroom.code, a.entry.id, showroomOp);
    const done = await redemption.confirmReverse(u.showroom.code, a.entry.id, { reason: 'lançamento feito por engano', operationId: prep.operationId, expectedBalanceCents: prep.expectedBalanceCents, confirmAmountCents: 5_000 }, showroomOp);
    expect(done.balanceCents).toBe(50_000);
  });

  test('o endpoint antigo "marcar como usado" não é atalho entre lojas', async () => {
    const boss = await owner();
    const op = await newUser('ADMIN');
    await scopes.grant(op.id, 'VALLE_SHOWROOM', boss);
    const u = await newUnit();
    await expect(vouchersService.markUsed(u.closet.code, op.id, op.name, { role: 'ADMIN' })).rejects.toBeInstanceOf(ForbiddenException);
    expect((await voucher(u.closet.id)).status).toBe('ACTIVE');
    expect(await entries(u.closet.id)).toHaveLength(0);
    await expect(vouchersService.markUsed(u.showroom.code, op.id, op.name, { role: 'ADMIN' })).resolves.toMatchObject({ status: 'USED' });
  });

  test('pelas rotas HTTP (controladores): o mesmo isolamento vale no resgate, na reversão e no endpoint antigo — a rota não é um caminho paralelo', async () => {
    const boss = await owner();
    const op = await newUser('ADMIN');
    await scopes.grant(op.id, 'VALLE_SHOWROOM', boss);
    const u = await newUnit();
    const req = { adminUser: { id: op.id, name: op.name, role: 'ADMIN' as const } };
    const ledgerController = new ValePassLedgerController(redemption, ledger, new ValePassBlockService(prisma, redemption));
    const vouchersController = new ValePassVouchersController(vouchersService);
    await expect(ledgerController.prepareRedeem(u.closet.code, { company: 'VS_BY_CLOSET', amountCents: 100, reference: REF }, req)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ledgerController.redeem(u.closet.code, { company: 'VS_BY_CLOSET', amountCents: 100, reference: REF, operationId: `op-${randomUUID()}`, expectedBalanceCents: 5_000, confirmAmountCents: 100 }, req)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(vouchersController.markUsed(u.closet.code, req)).rejects.toBeInstanceOf(ForbiddenException);
    const done = await ledgerController.redeem(u.showroom.code, { company: 'VALLE_SHOWROOM', amountCents: 100, reference: REF, operationId: `op-${randomUUID()}`, expectedBalanceCents: 50_000, confirmAmountCents: 100 }, req);
    expect(done.balanceCents).toBe(49_900);
    await expect(ledgerController.prepareReverse(u.closet.code, done.entry.id, req)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await entries(u.closet.id)).toHaveLength(0);
  });
});

localDescribe('STAFF: pode RESGATAR só nas empresas vinculadas; nunca reverter, bloquear ou consumir de outra empresa', () => {
  test('STAFF sem vínculo: 403 NO_COMPANY_AUTHORIZED em todos os caminhos (inclusive código inexistente)', async () => {
    const staff = await newUser('STAFF');
    const u = await newUnit();
    expect((await rejection(redeem(u.showroom, staff)))?.response?.code).toBe('NO_COMPANY_AUTHORIZED');
    await expect(redemption.prepareRedeem('VALLE-NAOEXISTE-0000', { company: 'VALLE_SHOWROOM', amountCents: 100, reference: REF }, staff)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(vouchersService.markUsed(u.closet.code, staff.id, staff.name, { role: 'STAFF' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(await entries(u.closet.id)).toHaveLength(0);
  });

  test('STAFF COM vínculo resgata (prévia + confirmação) na SUA empresa, com auditoria completa (quem, base SCOPE, referência) e saldo/histórico corretos', async () => {
    const boss = await owner();
    const staff = await newUser('STAFF');
    await scopes.grant(staff.id, 'VALLE_SHOWROOM', boss);
    const u = await newUnit();
    expect(OPERATOR_POLICY.staffMayRedeem).toBe(true);
    const preview = await redemption.prepareRedeem(u.showroom.code, { company: 'VALLE_SHOWROOM', amountCents: 20_000, reference: REF }, staff);
    expect(preview.canRedeem).toBe(true);
    const body = { company: 'VALLE_SHOWROOM', amountCents: 20_000, reference: REF, operationId: preview.operationId, expectedBalanceCents: preview.expectedBalanceCents, confirmAmountCents: 20_000 };
    const done = await redemption.confirmRedeem(u.showroom.code, body, staff);
    expect(done.balanceCents).toBe(30_000);
    const rows = await entries(u.showroom.id);
    expect(rows.map((r) => [r.seq, r.deltaCents, r.balanceAfterCents, r.actorAdminId, r.reference])).toEqual([[1, -20_000, 30_000, staff.id, REF]]);
    const audit = await prisma.adminAuditEvent.findMany({ where: { adminUserId: staff.id, action: 'VALE_PASS_REDEEMED' } });
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toMatchObject({ accessBasis: 'SCOPE', reference: REF });
    // idempotência: repetir a MESMA operação devolve o original e não desconta de novo
    const again = await redemption.confirmRedeem(u.showroom.code, body, staff);
    expect(again.replayed).toBe(true);
    expect(await entries(u.showroom.id)).toHaveLength(1);
    expect((await voucher(u.showroom.id)).balanceCents).toBe(30_000);
    // a tela recebe a decisão do servidor por voucher
    expect((await redemption.lookup(u.showroom.code, staff)).operatorAccess).toMatchObject({ canOperate: true, companies: ['VALLE_SHOWROOM'] });
    expect((await redemption.lookup(u.closet.code, staff)).operatorAccess).toMatchObject({ canOperate: false });
  });

  test('STAFF vinculado a UMA empresa não toca vouchers da outra (resgate, prévia e endpoint antigo), mesmo informando a empresa certa no corpo; nada muda', async () => {
    const boss = await owner();
    const staff = await newUser('STAFF');
    await scopes.grant(staff.id, 'VALLE_SHOWROOM', boss);
    const u = await newUnit();
    const closetBefore = await voucher(u.closet.id);
    expect((await rejection(redeem(u.closet, staff)))?.response?.code).toBe('COMPANY_NOT_AUTHORIZED');
    expect((await rejection(redemption.prepareRedeem(u.closet.code, { company: 'VS_BY_CLOSET', amountCents: 100, reference: REF }, staff)))?.response?.code).toBe('COMPANY_NOT_AUTHORIZED');
    expect(await rejection(redeem(u.closet, staff, 100, { company: 'VALLE_SHOWROOM' }))).not.toBeNull(); // empresa trocada no corpo: recusado de qualquer forma
    await expect(vouchersService.markUsed(u.closet.code, staff.id, staff.name, { role: 'STAFF' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(await entries(u.closet.id)).toHaveLength(0);
    expect(await voucher(u.closet.id)).toMatchObject({ balanceCents: closetBefore.balanceCents, status: closetBefore.status });
  });

  test('STAFF vinculado NUNCA reverte, bloqueia ou desbloqueia (serviço); histórico e bloqueio intactos', async () => {
    const boss = await owner();
    const staff = await newUser('STAFF');
    const admin = await newUser('ADMIN');
    await scopes.grant(staff.id, 'VALLE_SHOWROOM', boss);
    await scopes.grant(staff.id, 'VS_BY_CLOSET', boss);
    await scopes.grant(admin.id, 'VALLE_SHOWROOM', boss);
    const u = await newUnit();
    const done = await redeem(u.showroom, admin, 1_000);
    const blocks = new ValePassBlockService(prisma, redemption);
    await expect(redemption.prepareReverse(u.showroom.code, done.entry.id, staff)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(redemption.confirmReverse(u.showroom.code, done.entry.id, { reason: 'tentativa sem permissão', operationId: `op-${randomUUID()}`, expectedBalanceCents: 49_000, confirmAmountCents: 1_000 }, staff)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(blocks.prepareBlock(u.showroom.code, staff)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(blocks.confirmBlock(u.showroom.code, { reason: 'tentativa sem permissão', operationId: `op-${randomUUID()}`, confirmCode: u.showroom.code }, staff)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await entries(u.showroom.id)).toHaveLength(1); // só o resgate do admin; nenhum lançamento compensatório
    expect((await voucher(u.showroom.id)).blockedAt).toBeNull();
  });

  test('endpoint antigo "usado": STAFF vinculado NÃO consome o voucher por inteiro (nem na própria empresa); só o resgate com prévia e valor; ADMIN vinculado segue podendo', async () => {
    const boss = await owner();
    const staff = await newUser('STAFF');
    const admin = await newUser('ADMIN');
    await scopes.grant(staff.id, 'VALLE_SHOWROOM', boss);
    await scopes.grant(admin.id, 'VALLE_SHOWROOM', boss);
    const u = await newUnit();
    await expect(vouchersService.markUsed(u.showroom.code, staff.id, staff.name, { role: 'STAFF' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(await entries(u.showroom.id)).toHaveLength(0);
    expect((await voucher(u.showroom.id)).status).toBe('ACTIVE');
    await vouchersService.markUsed(u.showroom.code, admin.id, admin.name, { role: 'ADMIN' });
    expect(await entries(u.showroom.id)).toHaveLength(1);
  });

  test('vínculo revogado: o STAFF volta a ser recusado imediatamente (a decisão vem do banco a cada operação)', async () => {
    const boss = await owner();
    const staff = await newUser('STAFF');
    await scopes.grant(staff.id, 'VALLE_SHOWROOM', boss);
    const u = await newUnit();
    await redeem(u.showroom, staff, 1_000);
    await scopes.revoke(staff.id, 'VALLE_SHOWROOM', boss);
    expect((await rejection(redeem(u.showroom, staff, 1_000)))?.response?.code).toBe('NO_COMPANY_AUTHORIZED');
    expect(await entries(u.showroom.id)).toHaveLength(1);
  });

  test('concorrência: vários STAFF resgatando o MESMO voucher ao mesmo tempo nunca passam do saldo, e a mesma operação em paralelo grava uma vez', async () => {
    const boss = await owner();
    const a = await newUser('STAFF');
    const b = await newUser('STAFF');
    await scopes.grant(a.id, 'VALLE_SHOWROOM', boss);
    await scopes.grant(b.id, 'VALLE_SHOWROOM', boss);
    const u = await newUnit(); // R$ 500
    // 8 tentativas de R$ 100 (4 por funcionário) = R$ 800 > R$ 500: no máximo 5 passam
    const attempts = [a, b, a, b, a, b, a, b].map((actor, i) =>
      redemption
        .confirmRedeem(u.showroom.code, { company: 'VALLE_SHOWROOM', amountCents: 10_000, reference: `${REF} #${i}`, operationId: `op-conc-${i}-${randomUUID()}`, expectedBalanceCents: 50_000, confirmAmountCents: 10_000 }, actor)
        .then(() => 'ok', () => 'recusado'),
    );
    const results = await Promise.all(attempts);
    const rows = await entries(u.showroom.id);
    const spent = -rows.reduce((s, r) => s + r.deltaCents, 0);
    expect(spent).toBeLessThanOrEqual(50_000);
    expect((await voucher(u.showroom.id)).balanceCents).toBe(50_000 - spent);
    expect(rows.length).toBe(results.filter((r) => r === 'ok').length);
    expect(rows.every((r, i) => r.seq === i + 1 && r.balanceAfterCents >= 0)).toBe(true);
    const u2 = await newUnit();
    const same = `op-same-${randomUUID()}`;
    const body = { company: 'VALLE_SHOWROOM', amountCents: 5_000, reference: REF, operationId: same, expectedBalanceCents: 50_000, confirmAmountCents: 5_000 };
    await Promise.all([a, b, a, b].map((actor) => redemption.confirmRedeem(u2.showroom.code, body, actor).then(() => null, () => null)));
    expect((await entries(u2.showroom.id)).length).toBe(1);
  });

  test('guards das rotas coerentes com a política: resgate liberado ao módulo (decisão por empresa no serviço); reversão, bloqueio, conciliação e vínculos continuam restritos', () => {
    const ledgerProto = ValePassLedgerController.prototype as unknown as Record<string, unknown>;
    for (const name of ['prepareRedeem', 'redeem']) expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, ledgerProto[name] as object), name).toBeUndefined();
    for (const name of ['prepareReverse', 'reverse', 'prepareBlock', 'block', 'prepareUnblock', 'unblock', 'reconcile']) expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, ledgerProto[name] as object), name).toBe('ADMIN');
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, ValePassOperatorScopeController)).toBe('SUPER_ADMIN');
  });
});

localDescribe('permissões administrativas existentes preservadas', () => {
  test('ADMIN SEM vínculo é recusado nas DUAS empresas em todos os caminhos (prévia, resgate, reversão, endpoint antigo, API direta com a empresa trocada); o proprietário continua operando as duas', async () => {
    const boss = await owner();
    const admin = await newUser('ADMIN');
    const u = await newUnit();
    for (const target of [u.showroom, u.closet]) {
      expect((await rejection(redeem(target, admin, 1_000)))?.response?.code).toBe('NO_COMPANY_AUTHORIZED');
      // API direta declarando a empresa do OUTRO voucher não muda nada
      expect((await rejection(redeem(target, admin, 1_000, { company: target.company === 'VALLE_SHOWROOM' ? 'VS_BY_CLOSET' : 'VALLE_SHOWROOM' })))?.response?.code).toBe('NO_COMPANY_AUTHORIZED');
      await expect(redemption.prepareRedeem(target.code, { company: target.company as string, amountCents: 100, reference: REF }, admin)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(vouchersService.markUsed(target.code, admin.id, admin.name, { role: 'ADMIN' })).rejects.toBeInstanceOf(ForbiddenException);
    }
    // reversão de um resgate feito pelo proprietário: o ADMIN sem vínculo também não reverte
    const done = await redeem(u.showroom, boss, 1_000);
    await expect(redemption.prepareReverse(u.showroom.code, done.entry.id, admin)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await entries(u.showroom.id)).toHaveLength(1); // só o resgate do proprietário
    expect(await entries(u.closet.id)).toHaveLength(0);
    expect((await voucher(u.closet.id)).balanceCents).toBe(5_000);
    await redeem(u.closet, boss, 500); // o proprietário segue operando a outra empresa
    expect(await ledger.reconcile()).toEqual([]);
  });

  test('a política padrão do código é ESTRITA: ADMIN e STAFF só operam com vínculo; só o SUPER_ADMIN opera sem vínculo', () => {
    expect(OPERATOR_POLICY).toEqual({ staffMayRedeem: true, adminRequiresScope: true });
  });

  test('ADMIN com vínculo explícito fica restrito a ele; SUPER_ADMIN opera sempre as duas', async () => {
    const boss = await owner();
    const admin = await newUser('ADMIN');
    await scopes.grant(admin.id, 'VS_BY_CLOSET', boss);
    const u = await newUnit();
    expect((await rejection(redeem(u.showroom, admin)))?.response?.code).toBe('COMPANY_NOT_AUTHORIZED');
    await redeem(u.closet, admin, 500);
    await redeem(u.showroom, boss, 500);
    await redeem(u.closet, boss, 500);
    const basis = (await prisma.adminAuditEvent.findMany({ where: { adminUserId: { in: [admin.id, boss.id] }, action: 'VALE_PASS_REDEEMED' } })).map((a) => (a.detail as { accessBasis?: string }).accessBasis).sort();
    expect(basis).toEqual(['OWNER', 'OWNER', 'SCOPE']);
  });

});

localDescribe('gestão do vínculo: só o proprietário, auditada, idempotente', () => {
  test('ADMIN e STAFF não concedem nem revogam nem consultam; o proprietário sim', async () => {
    const boss = await owner();
    const admin = await newUser('ADMIN');
    const staff = await newUser('STAFF');
    for (const actor of [admin, staff]) {
      await expect(scopes.grant(staff.id, 'VALLE_SHOWROOM', actor)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(scopes.revoke(staff.id, 'VALLE_SHOWROOM', actor)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(scopes.view(staff.id, actor)).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(await prisma.valePassOperatorScope.count({ where: { adminUserId: staff.id } })).toBe(0);
    const ok = await scopes.grant(staff.id, 'VS_BY_CLOSET', boss);
    expect(ok).toMatchObject({ changed: true, view: { companies: ['VS_BY_CLOSET'] } });
  });

  test('conceder e revogar são idempotentes, auditados como críticos e o histórico fica preservado', async () => {
    const boss = await owner();
    const staff = await newUser('STAFF');
    expect((await scopes.grant(staff.id, 'VALLE_SHOWROOM', boss)).changed).toBe(true);
    expect((await scopes.grant(staff.id, 'VALLE_SHOWROOM', boss)).changed).toBe(false);
    expect((await scopes.revoke(staff.id, 'VALLE_SHOWROOM', boss)).changed).toBe(true);
    expect((await scopes.revoke(staff.id, 'VALLE_SHOWROOM', boss)).changed).toBe(false);
    const again = await scopes.grant(staff.id, 'VALLE_SHOWROOM', boss);
    expect(again.view.companies).toEqual(['VALLE_SHOWROOM']);
    expect(again.view.history).toHaveLength(2); // a revogada continua no histórico
    expect(again.view.history[0]).toMatchObject({ revokedByName: boss.name });
    const audits = await prisma.adminAuditEvent.findMany({ where: { adminUserId: boss.id, entityId: staff.id }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => a.action)).toEqual(['VALE_PASS_OPERATOR_SCOPE_GRANTED', 'VALE_PASS_OPERATOR_SCOPE_REVOKED', 'VALE_PASS_OPERATOR_SCOPE_GRANTED']);
    expect(audits.every((a) => a.isCritical)).toBe(true);
  });

  test('visão do proprietário: lista quem opera o quê, conta administradores sem vínculo e operações pelo acesso legado; só o proprietário vê', async () => {
    const boss = await owner();
    const admin = await newUser('ADMIN');
    const scoped = await newUser('ADMIN');
    const staff = await newUser('STAFF');
    await prisma.adminUser.update({ where: { id: staff.id }, data: { moduleAccess: ['VALLE_PASS'] } });
    await scopes.grant(scoped.id, 'VALLE_SHOWROOM', boss);
    const u = await newUnit();
    await expect(redeem(u.closet, admin, 500)).rejects.toBeDefined(); // ADMIN sem vínculo não opera mais
    const overview = await scopes.overview(boss);
    const mine = overview.users.filter((x) => [admin.id, scoped.id, staff.id].includes(x.id));
    expect(mine.map((x) => [x.role, x.companies.length]).sort()).toEqual([['ADMIN', 0], ['ADMIN', 1], ['STAFF', 0]]);
    expect(overview.users.some((x) => x.id === boss.id)).toBe(false); // o proprietário não aparece (sempre opera)
    expect(overview.policy).toEqual({ staffMayRedeem: true, adminRequiresScope: true });
    expect(overview.summary.adminsWithoutScope).toBeGreaterThanOrEqual(1);
    expect(overview.summary.legacyAdminOperationsLast30Days).toBeGreaterThanOrEqual(0); // só mede o histórico anterior à política estrita
    for (const actor of [admin, staff]) await expect(scopes.overview(actor)).rejects.toBeInstanceOf(ForbiddenException);
    expect(JSON.stringify(overview)).not.toMatch(/pinHash|phone/i);
  });

  test('concessões simultâneas não duplicam o vínculo', async () => {
    const boss = await owner();
    const staff = await newUser('STAFF');
    await Promise.all(Array.from({ length: 6 }, () => scopes.grant(staff.id, 'VALLE_SHOWROOM', boss)));
    expect(await prisma.valePassOperatorScope.count({ where: { adminUserId: staff.id, revokedAt: null } })).toBe(1);
  });

  test('entradas inválidas: empresa desconhecida (400), usuário inexistente/malformado (404), usuário inativo (409)', async () => {
    const boss = await owner();
    const staff = await newUser('STAFF');
    const inactive = await newUser('STAFF', false);
    await expect(scopes.grant(staff.id, 'OUTRA_LOJA', boss)).rejects.toBeInstanceOf(BadRequestException);
    await expect(scopes.grant(randomUUID(), 'VALLE_SHOWROOM', boss)).rejects.toBeInstanceOf(NotFoundException);
    await expect(scopes.grant('nao-e-um-id', 'VALLE_SHOWROOM', boss)).rejects.toBeInstanceOf(NotFoundException);
    await expect(scopes.grant(inactive.id, 'VALLE_SHOWROOM', boss)).rejects.toBeInstanceOf(ConflictException);
  });

  test('excluir o funcionário leva o vínculo junto; o banco recusa duas autorizações ativas e revogação antes da concessão', async () => {
    const boss = await owner();
    const staff = await newUser('STAFF');
    await scopes.grant(staff.id, 'VS_BY_CLOSET', boss);
    await expect(prisma.valePassOperatorScope.create({ data: { adminUserId: staff.id, company: 'VS_BY_CLOSET' } })).rejects.toThrow();
    await expect(prisma.valePassOperatorScope.create({ data: { adminUserId: staff.id, company: 'VALLE_SHOWROOM', revokedAt: new Date(Date.now() - 86_400_000) } })).rejects.toThrow();
    await prisma.adminUser.delete({ where: { id: staff.id } });
    expect(await prisma.valePassOperatorScope.count({ where: { adminUserId: staff.id } })).toBe(0);
  });
});

localDescribe('o que a tela recebe (informativo; a decisão é do servidor)', () => {
  test('a consulta informa a situação do operador para o voucher consultado', async () => {
    const boss = await owner();
    const staff = await newUser('STAFF');
    const op = await newUser('ADMIN');
    const u = await newUnit();
    expect((await redemption.lookup(u.showroom.code, staff)).operatorAccess).toMatchObject({ canOperate: false, companies: [], summary: expect.stringMatching(/Sem estabelecimento/) });
    expect((await redemption.lookup(u.showroom.code, op)).operatorAccess).toMatchObject({ canOperate: false, companies: [], summary: expect.stringMatching(/Sem estabelecimento/) }); // ADMIN sem vínculo não opera
    await scopes.grant(op.id, 'VALLE_SHOWROOM', boss);
    expect((await redemption.lookup(u.showroom.code, op)).operatorAccess).toMatchObject({ canOperate: true, message: null, companies: ['VALLE_SHOWROOM'] });
    expect((await redemption.lookup(u.closet.code, op)).operatorAccess).toMatchObject({ canOperate: false, message: expect.stringMatching(/VS BY CLOSET/) });
  });
});
