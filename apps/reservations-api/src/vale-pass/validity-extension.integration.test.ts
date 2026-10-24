import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ValePass, ValePassCampaign } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REQUIRE_ROLE_KEY } from '../admin/require-role.decorator';
import { purgeLedgerForTest } from './ledger/ledger-test-utils';
import { ValePassLedgerService } from './ledger/ledger.service';
import { ValePassRedemptionService, type Actor } from './ledger/redemption.service';
import { ValePassVouchersService } from './vale-pass-vouchers.service';
import { voucherWindow } from './vale-pass-validity';
import { ValePassValidityExtensionController } from './validity-extension.controller';
import { ValePassValidityExtensionService } from './validity-extension.service';

/**
 * Prorrogação COLETIVA da validade dos vouchers, em PostgreSQL LOCAL descartável. Dados 100% sintéticos; nenhuma data é "a nova data do Valle Pass": as datas daqui são
 * só de teste. Nada de Shopify, e-mail ou pagamento.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const extensions = new ValePassValidityExtensionService(prisma);
const redemption = new ValePassRedemptionService(prisma);
const ledger = new ValePassLedgerService(prisma);
const vouchersService = new ValePassVouchersService(prisma);
const TAG = `VPV-${Date.now()}`;
let counter = 0;
const campaignIds: string[] = [];
const userIds: string[] = [];
const OLD_EXPIRY = new Date('2027-10-01T03:00:00.000Z'); // 30/09/2027 inclusive, America/Sao_Paulo
const NEW_UNTIL = '2027-11-30';
const NEW_EXPIRY = '2027-12-01T03:00:00.000Z';

async function newUser(role: 'SUPER_ADMIN' | 'ADMIN' | 'STAFF'): Promise<Actor & { id: string }> {
  const row = await prisma.adminUser.create({ data: { name: `${role} ${TAG}-${counter}`, phone: `${TAG}-${counter++}`, pinHash: 'x', role, active: true } });
  userIds.push(row.id);
  return { id: row.id, name: row.name, role };
}

async function newCampaign(over: { until?: string | null; benefits?: boolean } = {}): Promise<ValePassCampaign> {
  const until = over.until === undefined ? '2027-09-30' : over.until;
  const campaign = await prisma.valePassCampaign.create({
    data: {
      name: `${TAG}-camp-${counter++}`, amountCents: 35_000, validityDays: 30, globalLimit: 1_000, shopifyVariantId: `${TAG}-var-${counter++}`,
      voucherValidFrom: until ? new Date('2026-01-01') : null, voucherValidUntil: until ? new Date(`${until}T00:00:00.000Z`) : null,
    },
  });
  campaignIds.push(campaign.id);
  if (over.benefits !== false) {
    await prisma.valePassCampaignBenefit.createMany({
      data: [
        { campaignId: campaign.id, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 },
        { campaignId: campaign.id, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 },
      ],
    });
  }
  return campaign;
}

type Over = { status?: 'ACTIVE' | 'USED' | 'EXPIRED' | 'CANCELLED'; expiresAt?: Date };
/** Uma unidade (2 vouchers) no modelo novo. `over` aplica ao voucher da Valle Showroom; o da VS BY CLOSET segue `over2`. */
async function newUnit(campaign: ValePassCampaign, over: Over = {}, over2: Over = {}): Promise<{ showroom: ValePass; closet: ValePass }> {
  const benefits = await prisma.valePassCampaignBenefit.findMany({ where: { campaignId: campaign.id, kind: 'VOUCHER' } });
  const groupId = randomUUID();
  const common = { campaignId: campaign.id, groupId, shopifyOrderId: `${TAG}-o${counter++}`, shopifyOrderName: '#T3001', purchasedAt: new Date(), validFrom: new Date('2026-01-01T03:00:00Z'), customerName: 'Cliente Sintético', customerPhone: '+5500000000000' };
  const make = async (company: 'VALLE_SHOWROOM' | 'VS_BY_CLOSET', amount: number, o: Over) => {
    const status = o.status ?? 'ACTIVE';
    // USED nasce com saldo zero (regra do banco); os demais com saldo cheio
    const row = await prisma.valePass.create({
      data: { ...common, code: `VALLE-${TAG.slice(-4)}-${company === 'VALLE_SHOWROOM' ? 'A' : 'B'}${counter++}`.toUpperCase(), amountCents: amount, company, benefitId: benefits.find((b) => b.company === company)!.id, status: 'ACTIVE', expiresAt: o.expiresAt ?? OLD_EXPIRY },
    });
    if (status === 'USED') {
      await prisma.valePassLedgerEntry.create({ data: { valePassId: row.id, seq: 1, balanceAfterCents: 0, kind: 'REDEEM', deltaCents: -amount, reason: 'teste', reference: 'USO-TOTAL-TESTE', idempotencyKey: `use-${row.id}` } });
    } else if (status !== 'ACTIVE') {
      await prisma.valePass.update({ where: { id: row.id }, data: { status } });
    }
    return prisma.valePass.findUniqueOrThrow({ where: { id: row.id } });
  };
  return { showroom: await make('VALLE_SHOWROOM', 50_000, over), closet: await make('VS_BY_CLOSET', 5_000, over2) };
}

const row = (id: string) => prisma.valePass.findUniqueOrThrow({ where: { id } });
const entriesOf = (id: string) => prisma.valePassLedgerEntry.findMany({ where: { valePassId: id }, orderBy: { seq: 'asc' } });
const rejection = (promise: Promise<unknown>) => promise.then(() => null, (err: unknown) => err as { status?: number; response?: { code?: string }; message: string });
const op = () => `ext-${randomUUID()}`;
async function extend(owner: Actor, campaign: ValePassCampaign, newUntil = NEW_UNTIL, over: { operationId?: string; reason?: string; expected?: number } = {}) {
  const preview = await extensions.prepare(campaign.id, { newUntil }, owner);
  return extensions.confirm(campaign.id, { newUntil, reason: over.reason ?? 'Decisão comercial confirmada (teste)', operationId: over.operationId ?? preview.operationId, confirmDate: newUntil, expectedEligibleCount: over.expected ?? preview.counts.eligible }, owner);
}

async function cleanRows() {
  const ids = campaignIds.splice(0);
  const users = userIds.splice(0);
  await prisma.$transaction(
    async (tx) => {
      const rows = await tx.valePass.findMany({ where: { campaignId: { in: ids } }, select: { id: true } });
      await purgeLedgerForTest(tx, { campaignIds: ids });
      await tx.valePassEvent.deleteMany({ where: { valePassId: { in: rows.map((r) => r.id) } } });
      await tx.adminAuditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...ids, ...rows.map((r) => r.id)] } }, { adminUserId: { in: users } }] } });
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica'); // só a limpeza dos dados SINTÉTICOS (o histórico é imutável por gatilho)
      await tx.$executeRaw`DELETE FROM vale_pass_validity_extensions WHERE campaign_id = ANY(${ids}::uuid[])`;
      await tx.valePass.deleteMany({ where: { campaignId: { in: ids } } });
      await tx.valePassCampaignBenefit.deleteMany({ where: { campaignId: { in: ids } } });
      await tx.valePassCampaign.deleteMany({ where: { id: { in: ids } } });
      await tx.adminUser.deleteMany({ where: { id: { in: users } } });
    },
    { timeout: 60_000 },
  );
}
beforeAll(() => undefined);
afterEach(async () => {
  if (localDatabase) await cleanRows();
});
afterAll(async () => {
  if (localDatabase) await cleanRows();
  await prisma.$disconnect();
});

localDescribe('prévia: nada é gravado e a data nunca é sugerida', () => {
  test('mostra a validade atual, o instante de vencimento no fuso e as contagens; não grava nada', async () => {
    const owner = await newUser('SUPER_ADMIN');
    const c = await newCampaign();
    await newUnit(c);
    await newUnit(c, { status: 'CANCELLED' }, { status: 'CANCELLED' });
    const before = await prisma.valePassValidityExtension.count();
    const p = await extensions.prepare(c.id, { newUntil: NEW_UNTIL }, owner);
    expect(p).toMatchObject({ canProceed: true, problems: [], currentUntil: '2027-09-30', newUntil: NEW_UNTIL, newExpiresAt: NEW_EXPIRY, timezone: 'America/Sao_Paulo' });
    expect(p.counts).toMatchObject({ eligible: 2, eligibleByCompany: { VALLE_SHOWROOM: 1, VS_BY_CLOSET: 1, LEGACY: 0 }, eligibleBalanceCents: 55_000, cancelledNotIncluded: 2, expiredNotIncluded: 0, alreadyLonger: 0 });
    expect(p.operationId).toMatch(/^ext-|^[0-9a-f-]{36}$/);
    expect(await prisma.valePassValidityExtension.count()).toBe(before);
    expect((await row((await prisma.valePass.findFirstOrThrow({ where: { campaignId: c.id, status: 'ACTIVE' } })).id)).expiresAt.toISOString()).toBe(OLD_EXPIRY.toISOString());
  });

  test('datas inválidas, iguais ou anteriores à atual e campanha sem validade são problemas (não prossegue)', async () => {
    const owner = await newUser('SUPER_ADMIN');
    const c = await newCampaign();
    const noWindow = await newCampaign({ until: null });
    expect((await extensions.prepare(c.id, { newUntil: '2027-09-30' }, owner)).problems.map((x) => x.code)).toEqual(['NOT_AFTER_CURRENT']);
    expect((await extensions.prepare(c.id, { newUntil: '2027-01-01' }, owner)).canProceed).toBe(false);
    expect((await extensions.prepare(c.id, { newUntil: '2027-02-31' }, owner)).problems.map((x) => x.code)).toEqual(['INVALID_DATE']);
    expect((await extensions.prepare(noWindow.id, { newUntil: NEW_UNTIL }, owner)).problems.map((x) => x.code)).toContain('NO_VALIDITY_WINDOW');
    await expect(extensions.prepare('nao-e-um-id', { newUntil: NEW_UNTIL }, owner)).rejects.toBeInstanceOf(NotFoundException);
  });
});

localDescribe('prorrogação: só o que deve mudar muda', () => {
  test('ACTIVE e USED ganham a nova validade; saldo, ledger, status, benefícios, empresa e início ficam intactos; evento por voucher; campanha atualizada; auditoria crítica', async () => {
    const owner = await newUser('SUPER_ADMIN');
    const admin = await newUser('ADMIN');
    const c = await newCampaign();
    const u1 = await newUnit(c);
    const u2 = await newUnit(c, { status: 'USED' });
    // resgate parcial ANTES da prorrogação: o saldo e o histórico precisam sobreviver
    await redemption.confirmRedeem(u1.showroom.code, { company: 'VALLE_SHOWROOM', amountCents: 20_000, reference: 'Nota 1 (teste)', operationId: op(), expectedBalanceCents: 50_000, confirmAmountCents: 20_000 }, admin);
    const snapshot = async () => {
      const rows = await prisma.valePass.findMany({ where: { campaignId: c.id }, orderBy: { code: 'asc' } });
      return Promise.all(rows.map(async (r) => ({ id: r.id, status: r.status, balance: r.balanceCents, amount: r.amountCents, company: r.company, benefitId: r.benefitId, groupId: r.groupId, validFrom: r.validFrom?.toISOString(), code: r.code, blockedAt: r.blockedAt, ledger: (await entriesOf(r.id)).map((e) => [e.seq, e.kind, e.deltaCents, e.balanceAfterCents]) })));
    };
    const before = await snapshot();

    const result = await extend(owner, c);
    expect(result.replayed).toBe(false);
    expect(result.extension).toMatchObject({ seq: 1, previousUntil: '2027-09-30', newUntil: NEW_UNTIL, newExpiresAt: NEW_EXPIRY, extendedCount: 4, expiredNotIncluded: 0, cancelledNotIncluded: 0, balanceTotalCents: 40_000 });
    expect(await snapshot()).toEqual(before); // tudo igual, menos a validade
    for (const v of await prisma.valePass.findMany({ where: { campaignId: c.id } })) expect(v.expiresAt.toISOString()).toBe(NEW_EXPIRY);
    expect((await prisma.valePassCampaign.findUniqueOrThrow({ where: { id: c.id } })).voucherValidUntil?.toISOString().slice(0, 10)).toBe(NEW_UNTIL);
    const events = await prisma.valePassEvent.findMany({ where: { type: 'VALIDITY_EXTENDED', valePassId: { in: [u1.showroom.id, u1.closet.id, u2.showroom.id, u2.closet.id] } } });
    expect(events).toHaveLength(4);
    expect(events.every((e) => (e.detail as { previousExpiresAt: string }).previousExpiresAt && (e.detail as { newExpiresAt: string }).newExpiresAt)).toBe(true);
    const audit = await prisma.adminAuditEvent.findFirstOrThrow({ where: { action: 'VALE_PASS_VALIDITY_EXTENDED', entityId: c.id } });
    expect(audit.isCritical).toBe(true);
    expect(audit.adminUserId).toBe(owner.id);
    expect(await ledger.reconcile()).toEqual([]);
    // o voucher continua resgatável normalmente depois
    await expect(redemption.confirmRedeem(u1.showroom.code, { company: 'VALLE_SHOWROOM', amountCents: 1_000, reference: 'Nota 2 (teste)', operationId: op(), expectedBalanceCents: 30_000, confirmAmountCents: 1_000 }, admin)).resolves.toMatchObject({ balanceCents: 29_000 });
  });

  test('cancelados, expirados (por status ou por data) e os que já têm validade maior ficam de FORA; nada é reativado nem encurtado', async () => {
    const owner = await newUser('SUPER_ADMIN');
    const c = await newCampaign();
    const longer = await newUnit(c, { expiresAt: new Date('2028-06-01T03:00:00.000Z') }, { expiresAt: new Date('2028-06-01T03:00:00.000Z') });
    const cancelled = await newUnit(c, { status: 'CANCELLED' }, { status: 'CANCELLED' });
    const expiredStatus = await newUnit(c, { status: 'EXPIRED' }, { status: 'EXPIRED' });
    const expiredByDate = await newUnit(c, { expiresAt: new Date(Date.now() - 86_400_000) });
    const normal = await newUnit(c);

    const preview = await extensions.prepare(c.id, { newUntil: NEW_UNTIL }, owner);
    expect(preview.counts).toMatchObject({ eligible: 3, cancelledNotIncluded: 2, alreadyLonger: 2 });
    expect(preview.counts.expiredNotIncluded).toBe(3); // 2 por status + 1 por data
    const result = await extend(owner, c);
    expect(result.extension).toMatchObject({ extendedCount: 3, cancelledNotIncluded: 2, expiredNotIncluded: 3, alreadyLongerCount: 2 });

    for (const v of [longer.showroom, longer.closet]) expect((await row(v.id)).expiresAt.toISOString()).toBe('2028-06-01T03:00:00.000Z'); // nunca encurta
    for (const v of [cancelled.showroom, cancelled.closet]) expect(await row(v.id)).toMatchObject({ status: 'CANCELLED', expiresAt: OLD_EXPIRY });
    for (const v of [expiredStatus.showroom, expiredStatus.closet]) expect(await row(v.id)).toMatchObject({ status: 'EXPIRED', expiresAt: OLD_EXPIRY });
    expect((await row(expiredByDate.showroom.id)).expiresAt.getTime()).toBeLessThan(Date.now()); // vencido por data continua vencido
    expect((await row(expiredByDate.showroom.id)).expiresAt.toISOString()).not.toBe(NEW_EXPIRY);
    expect((await row(expiredByDate.closet.id)).expiresAt.toISOString()).toBe(NEW_EXPIRY); // o irmão que ainda valia ganha
    for (const v of [normal.showroom, normal.closet]) expect((await row(v.id)).expiresAt.toISOString()).toBe(NEW_EXPIRY);
    // cancelar depois da prorrogação e o status lazy não mexem na regra: o extendido não vira EXPIRED
    expect((await vouchersService.findByCode(normal.closet.code)).status).toBe('ACTIVE');
  });

  test('campanha legada (vouchers sem empresa) também é prorrogada, sem saldo envolvido', async () => {
    const owner = await newUser('SUPER_ADMIN');
    const c = await newCampaign({ benefits: false });
    const legacy = await prisma.valePass.create({ data: { code: `VALLE-${TAG.slice(-4)}-L${counter++}`.toUpperCase(), campaignId: c.id, amountCents: 35_000, purchasedAt: new Date(), expiresAt: OLD_EXPIRY } });
    const p = await extensions.prepare(c.id, { newUntil: NEW_UNTIL }, owner);
    expect(p.counts).toMatchObject({ eligible: 1, eligibleByCompany: { LEGACY: 1 }, eligibleBalanceCents: 0 });
    await extend(owner, c);
    expect((await row(legacy.id)).expiresAt.toISOString()).toBe(NEW_EXPIRY);
  });

  test('prorrogações em sequência: a numeração cresce, cada uma parte da validade vigente; prévia antiga (campanha mudou) é recusada', async () => {
    const owner = await newUser('SUPER_ADMIN');
    const c = await newCampaign();
    await newUnit(c);
    const stale = await extensions.prepare(c.id, { newUntil: '2027-10-31' }, owner); // prévia feita ANTES da primeira prorrogação
    const first = await extend(owner, c, NEW_UNTIL);
    expect(first.extension.seq).toBe(1);
    const err = await rejection(extensions.confirm(c.id, { newUntil: '2027-10-31', reason: 'Decisão comercial confirmada (teste)', operationId: stale.operationId, confirmDate: '2027-10-31', expectedEligibleCount: stale.counts.eligible }, owner));
    expect(err?.response?.code).toBe('NOT_AFTER_CURRENT'); // 31/10 já não é posterior à validade vigente (30/11)
    const second = await extend(owner, c, '2028-01-31');
    expect(second.extension).toMatchObject({ seq: 2, previousUntil: NEW_UNTIL, newUntil: '2028-01-31', extendedCount: 2 });
    expect((await extensions.history(c.id, owner)).map((e) => e.seq)).toEqual([2, 1]);
  });

  test('o fuso é aplicado pelo banco igual ao do emissor: instante de vencimento confere com o cálculo da aplicação em vários fusos e datas', async () => {
    const c = await newCampaign();
    await newUnit(c);
    let previous = '2027-09-30';
    for (const [tz, until] of [['America/Sao_Paulo', '2027-10-31'], ['America/Santiago', '2027-11-30'], ['UTC', '2028-03-31'], ['America/Santiago', '2028-04-30']] as const) {
      const created = await prisma.valePassValidityExtension.create({
        data: { campaignId: c.id, seq: 1, previousUntil: new Date(`${previous}T00:00:00.000Z`), newUntil: new Date(`${until}T00:00:00.000Z`), timezone: tz, newExpiresAt: new Date(0), reason: 'Verificação de fuso (teste)', idempotencyKey: op() },
      });
      expect(created.newExpiresAt.toISOString()).toBe(voucherWindow(until, until, tz).expiresAt.toISOString());
      previous = until;
    }
    await expect(prisma.valePassValidityExtension.create({ data: { campaignId: c.id, seq: 1, previousUntil: new Date(`${previous}T00:00:00.000Z`), newUntil: new Date('2029-01-31T00:00:00.000Z'), timezone: 'Mars/Olympus', newExpiresAt: new Date(0), reason: 'Fuso inexistente (teste)', idempotencyKey: op() } })).rejects.toThrow();
  });
});

localDescribe('o banco é a última linha: só aumenta, só pela prorrogação, histórico imutável', () => {
  test('UPDATE direto da validade (para mais ou para menos) é recusado, inclusive tentando "falsificar" o contexto da prorrogação', async () => {
    const owner = await newUser('SUPER_ADMIN');
    const c = await newCampaign();
    const u = await newUnit(c);
    await expect(prisma.$executeRaw`UPDATE vale_passes SET expires_at = expires_at + interval '30 days' WHERE id = ${u.showroom.id}::uuid`).rejects.toThrow(/vale_pass_immutable/);
    await expect(prisma.$executeRaw`UPDATE vale_passes SET expires_at = expires_at - interval '1 day' WHERE id = ${u.showroom.id}::uuid`).rejects.toThrow(/vale_pass_immutable/);
    const done = await extend(owner, c);
    // mesmo conhecendo o id de uma prorrogação REAL, fora do gatilho dela o UPDATE direto continua recusado
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('vale_pass.extension_id', ${done.extension.id}, true)`;
        await tx.$executeRaw`UPDATE vale_passes SET expires_at = ${new Date('2030-01-01T03:00:00Z')} WHERE id = ${u.closet.id}::uuid`;
      }),
    ).rejects.toThrow(/vale_pass_immutable/);
    expect((await row(u.closet.id)).expiresAt.toISOString()).toBe(NEW_EXPIRY);
    // as demais colunas imutáveis seguem imutáveis
    await expect(prisma.$executeRaw`UPDATE vale_passes SET valid_from = valid_from + interval '1 day' WHERE id = ${u.showroom.id}::uuid`).rejects.toThrow(/vale_pass_immutable/);
    await expect(prisma.$executeRaw`UPDATE vale_passes SET amount_cents = amount_cents + 1 WHERE id = ${u.showroom.id}::uuid`).rejects.toThrow(/vale_pass_immutable/);
  });

  test('prorrogação com data igual/anterior, prévia vencida ou campanha sem validade é recusada pelo próprio banco', async () => {
    const c = await newCampaign();
    const noWindow = await newCampaign({ until: null });
    const insert = (campaignId: string, previous: string, next: string) =>
      prisma.valePassValidityExtension.create({ data: { campaignId, seq: 1, previousUntil: new Date(`${previous}T00:00:00.000Z`), newUntil: new Date(`${next}T00:00:00.000Z`), timezone: 'America/Sao_Paulo', newExpiresAt: new Date(0), reason: 'Tentativa direta (teste)', idempotencyKey: op() } });
    await expect(insert(c.id, '2027-09-30', '2027-09-30')).rejects.toThrow();
    await expect(insert(c.id, '2027-09-30', '2027-08-31')).rejects.toThrow();
    await expect(insert(c.id, '2027-08-31', '2027-12-31')).rejects.toThrow(/vale_pass_validity_stale/); // previous_until não é a validade atual
    await expect(insert(noWindow.id, '2027-09-30', '2027-12-31')).rejects.toThrow(/vale_pass_validity_no_window/);
    expect(await prisma.valePassValidityExtension.count({ where: { campaignId: { in: [c.id, noWindow.id] } } })).toBe(0);
  });

  test('o histórico de prorrogações não se altera nem se apaga (UPDATE, DELETE, TRUNCATE)', async () => {
    const owner = await newUser('SUPER_ADMIN');
    const c = await newCampaign();
    await newUnit(c);
    await extend(owner, c);
    await expect(prisma.$executeRaw`UPDATE vale_pass_validity_extensions SET reason = 'adulterado pelo teste' WHERE campaign_id = ${c.id}::uuid`).rejects.toThrow(/vale_pass_validity_immutable/);
    await expect(prisma.$executeRaw`DELETE FROM vale_pass_validity_extensions WHERE campaign_id = ${c.id}::uuid`).rejects.toThrow(/vale_pass_validity_immutable/);
    await expect(prisma.$executeRaw`TRUNCATE vale_pass_validity_extensions`).rejects.toThrow(/vale_pass_validity_immutable/);
    expect(await prisma.valePassValidityExtension.count({ where: { campaignId: c.id } })).toBe(1);
  });

  test('falha no meio: a transação inteira é desfeita — nenhuma prorrogação parcial (vouchers, campanha e histórico intactos)', async () => {
    const owner = await newUser('SUPER_ADMIN');
    const c = await newCampaign();
    const u = await newUnit(c);
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.valePassValidityExtension.create({ data: { campaignId: c.id, seq: 1, previousUntil: new Date('2027-09-30T00:00:00.000Z'), newUntil: new Date(`${NEW_UNTIL}T00:00:00.000Z`), timezone: 'America/Sao_Paulo', newExpiresAt: new Date(0), reason: 'Será desfeita (teste)', idempotencyKey: op() } });
        expect((await tx.valePass.findUniqueOrThrow({ where: { id: u.showroom.id } })).expiresAt.toISOString()).toBe(NEW_EXPIRY); // dentro da transação já valia
        throw new Error('falha simulada no meio');
      }),
    ).rejects.toThrow('falha simulada');
    expect((await row(u.showroom.id)).expiresAt.toISOString()).toBe(OLD_EXPIRY.toISOString());
    expect((await prisma.valePassCampaign.findUniqueOrThrow({ where: { id: c.id } })).voucherValidUntil?.toISOString().slice(0, 10)).toBe('2027-09-30');
    expect(await prisma.valePassValidityExtension.count({ where: { campaignId: c.id } })).toBe(0);
    expect(await prisma.valePassEvent.count({ where: { valePassId: u.showroom.id, type: 'VALIDITY_EXTENDED' } })).toBe(0);
    // e depois disso a prorrogação normal funciona (numeração recomeça em 1)
    expect((await extend(owner, c)).extension.seq).toBe(1);
  });
});

localDescribe('autorização, confirmação e idempotência', () => {
  test('somente SUPER_ADMIN: ADMIN e STAFF não veem prévia, não confirmam e não consultam o histórico; o controlador exige SUPER_ADMIN', async () => {
    const admin = await newUser('ADMIN');
    const staff = await newUser('STAFF');
    const c = await newCampaign();
    await newUnit(c);
    for (const actor of [admin, staff]) {
      await expect(extensions.prepare(c.id, { newUntil: NEW_UNTIL }, actor)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(extensions.confirm(c.id, { newUntil: NEW_UNTIL, reason: 'Tentativa sem permissão', operationId: op(), confirmDate: NEW_UNTIL, expectedEligibleCount: 2 }, actor)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(extensions.history(c.id, actor)).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, ValePassValidityExtensionController)).toBe('SUPER_ADMIN');
    expect(await prisma.valePassValidityExtension.count({ where: { campaignId: c.id } })).toBe(0);
  });

  test('confirmação explícita: data redigitada diferente, justificativa curta e contagem desatualizada são recusadas e nada muda', async () => {
    const owner = await newUser('SUPER_ADMIN');
    const c = await newCampaign();
    const u = await newUnit(c);
    const p = await extensions.prepare(c.id, { newUntil: NEW_UNTIL }, owner);
    const base = { newUntil: NEW_UNTIL, reason: 'Decisão comercial confirmada (teste)', operationId: p.operationId, confirmDate: NEW_UNTIL, expectedEligibleCount: p.counts.eligible };
    await expect(extensions.confirm(c.id, { ...base, confirmDate: '2027-11-29' }, owner)).rejects.toThrow(/não confere/);
    await expect(extensions.confirm(c.id, { ...base, reason: 'curta' }, owner)).rejects.toThrow(/mínimo de 10/);
    expect((await rejection(extensions.confirm(c.id, { ...base, expectedEligibleCount: p.counts.eligible + 5 }, owner)))?.response?.code).toBe('STALE_PREVIEW');
    expect((await row(u.showroom.id)).expiresAt.toISOString()).toBe(OLD_EXPIRY.toISOString());
    expect(await prisma.valePassValidityExtension.count({ where: { campaignId: c.id } })).toBe(0);
  });

  test('idempotência: repetir a MESMA operação devolve o resultado original sem alterar nada; outro conteúdo com a mesma chave é 409; 6 confirmações simultâneas = uma só prorrogação', async () => {
    const owner = await newUser('SUPER_ADMIN');
    const c = await newCampaign();
    const u = await newUnit(c);
    const p = await extensions.prepare(c.id, { newUntil: NEW_UNTIL }, owner);
    const input = { newUntil: NEW_UNTIL, reason: 'Decisão comercial confirmada (teste)', operationId: p.operationId, confirmDate: NEW_UNTIL, expectedEligibleCount: p.counts.eligible };
    const first = await extensions.confirm(c.id, input, owner);
    const again = await extensions.confirm(c.id, input, owner);
    expect(again.replayed).toBe(true);
    expect(again.extension.id).toBe(first.extension.id);
    expect((await rejection(extensions.confirm(c.id, { ...input, newUntil: '2027-12-31', confirmDate: '2027-12-31' }, owner)))?.response?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await prisma.valePassValidityExtension.count({ where: { campaignId: c.id } })).toBe(1);
    expect(await prisma.valePassEvent.count({ where: { valePassId: u.showroom.id, type: 'VALIDITY_EXTENDED' } })).toBe(1);

    const c2 = await newCampaign();
    await newUnit(c2);
    const p2 = await extensions.prepare(c2.id, { newUntil: NEW_UNTIL }, owner);
    const input2 = { newUntil: NEW_UNTIL, reason: 'Decisão comercial confirmada (teste)', operationId: p2.operationId, confirmDate: NEW_UNTIL, expectedEligibleCount: p2.counts.eligible };
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => extensions.confirm(c2.id, input2, owner).then((r) => r, (e: unknown) => e as { response?: { code?: string } })));
    const created = outcomes.filter((o) => 'replayed' in o && o.replayed === false).length;
    expect(created).toBe(1);
    expect(outcomes.every((o) => 'replayed' in o || ['OPERATION_IN_PROGRESS', 'STALE_PREVIEW', 'NOT_AFTER_CURRENT'].includes((o as { response?: { code?: string } }).response?.code ?? ''))).toBe(true);
    expect(await prisma.valePassValidityExtension.count({ where: { campaignId: c2.id } })).toBe(1);
  });
});

localDescribe('concorrência com resgates e cancelamentos', () => {
  test('restauração concorrente com prorrogação coletiva segue campanha → voucher e termina sem deadlock', async () => {
    const owner = await newUser('SUPER_ADMIN');
    const admin = await newUser('ADMIN');
    const c = await newCampaign();
    await prisma.valePassCampaign.update({ where: { id: c.id }, data: { globalLimit: 100 } });
    const unit = await newUnit(c);
    await vouchersService.cancel(unit.showroom.code, 'cancelado para corrida de teste', admin.id, admin.name);

    const [restoreResult, extensionResult] = await Promise.all([
      vouchersService.restore(unit.showroom.code, 'restaurado em corrida de teste', admin.id, admin.name).then((r) => ({ ok: true as const, value: r }), (error: unknown) => ({ ok: false as const, error })),
      extend(owner, c).then((r) => ({ ok: true as const, value: r }), (error: unknown) => ({ ok: false as const, error })),
    ]);
    if (!restoreResult.ok) throw restoreResult.error;
    if (!extensionResult.ok) {
      expect((extensionResult.error as Error).message).toMatch(/quantidade de vouchers prorrogáveis mudou desde a prévia/i);
      const retried = await extend(owner, c);
      expect(retried.extension.extendedCount).toBeGreaterThan(0);
    }
    const restored = await row(unit.showroom.id);
    expect(restored.status).toBe('ACTIVE');
    expect([OLD_EXPIRY.toISOString(), NEW_EXPIRY]).toContain(restored.expiresAt.toISOString());
    expect(await ledger.reconcile()).toEqual([]);
  }, 60_000);

  test('prorrogação simultânea a resgates e a cancelamentos: sem impasse, saldos e ledger consistentes, cancelados continuam cancelados, nenhum voucher fica pela metade', async () => {
    const owner = await newUser('SUPER_ADMIN');
    const admin = await newUser('ADMIN');
    for (let round = 0; round < 6; round++) {
      const c = await newCampaign();
      const units = await Promise.all(Array.from({ length: 8 }, () => newUnit(c)));
      const redeems = units.slice(0, 4).map((u) => redemption.confirmRedeem(u.showroom.code, { company: 'VALLE_SHOWROOM', amountCents: 1_000, reference: `Nota ${round} (teste)`, operationId: op(), expectedBalanceCents: 50_000, confirmAmountCents: 1_000 }, admin).then((r) => r, (e: unknown) => e));
      const cancels = units.slice(4, 6).map((u) => vouchersService.cancel(u.showroom.code, 'cancelamento concorrente (teste)', admin.id, admin.name).then((r) => r, (e: unknown) => e));
      const ext = extend(owner, c).then((r) => r, (e: unknown) => e as { status?: number; response?: { code?: string } });
      const all = await Promise.all([...redeems, ...cancels, ext]);
      const extResult = all[all.length - 1] as { extension?: { extendedCount: number }; status?: number };
      for (const result of all) if (result instanceof Error && !('response' in result)) throw result;
      const vouchers = await prisma.valePass.findMany({ where: { campaignId: c.id } });
      if (extResult.extension) {
        // sucesso: TODO voucher não cancelado ficou com a nova validade; cancelados não foram reativados nem prorrogados depois de cancelados
        for (const v of vouchers) {
          if (v.status === 'CANCELLED') expect([NEW_EXPIRY, OLD_EXPIRY.toISOString()]).toContain(v.expiresAt.toISOString());
          else expect(v.expiresAt.toISOString()).toBe(NEW_EXPIRY);
        }
        expect(extResult.extension.extendedCount).toBeGreaterThanOrEqual(8 * 2 - 4); // ao menos os não cancelados antes da trava
      } else {
        // recusa limpa (impasse/trava): NADA mudou
        for (const v of vouchers) expect(v.expiresAt.toISOString()).toBe(OLD_EXPIRY.toISOString());
        expect(await prisma.valePassValidityExtension.count({ where: { campaignId: c.id } })).toBe(0);
      }
      expect(await ledger.reconcile()).toEqual([]);
      for (const v of vouchers.filter((x) => x.status !== 'CANCELLED' && x.company === 'VALLE_SHOWROOM')) expect([49_000, 50_000]).toContain(v.balanceCents);
    }
  }, 180_000);
});
