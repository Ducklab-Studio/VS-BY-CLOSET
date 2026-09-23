import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { AvailabilityService } from '../availability/availability.service';
import { HoldsService } from '../holds/holds.service';
import { AdminReservationsService } from '../admin-reservations/admin-reservations.service';
import { AdminBlocksService } from './blocks.service';
import { AdminRulesService } from './rules.service';
import { AdminBlocksController } from './blocks.controller';
import { AdminRulesController } from './rules.controller';
import type { UpdateRulesDto } from './dto/update-rules.dto';
import { lockOperationalBlocks } from '../admin/operational-blocks';
import { REQUIRE_ROLE_KEY } from '../admin/require-role.decorator';
import { REQUIRE_MODULE_KEY } from '../admin/require-module.decorator';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';
import { addDays, civilDate, civilDateToISO, isSunday, type CivilDate } from '../rental-rules/civil-date';
import { today as engineToday } from '../rental-rules/rental-engine';

/**
 * Calendário flexível: data de início da operação + períodos fechados
 * (operational_blocks) configurados pelo painel. Integração real contra
 * PostgreSQL LOCAL — sem `DATABASE_URL` de loopback com nome de teste, o
 * arquivo é pulado. Chama os mesmos serviços que o painel e o site usam.
 *
 * Cada teste usa a sua própria janela de datas (distantes 30 dias entre si)
 * pra que períodos fechados de um teste não interfiram nos outros.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const rules = new RentalRuleConfigService(prisma);
const availability = new AvailabilityService(prisma, rules);
const holds = new HoldsService(prisma, rules);
const manual = new AdminReservationsService(prisma, rules);
const blocksAdmin = new AdminBlocksService(prisma);
const rulesAdmin = new AdminRulesService(prisma);

const PREFIX = `OPCAL-${Date.now()}`;
const VARIANT_A = `${PREFIX}-variant-a`; // 2 unidades
const VARIANT_B = `${PREFIX}-variant-b`; // 1 unidade
const TODAY = engineToday(DEFAULT_RENTAL_RULE_CONFIG);

let admin: { id: string; name: string };
let unitA1: string;
let unitA2: string;
let unitB1: string;
let originalBlackout: { start: string | null; end: string | null };
let windowCounter = 0;

const iso = (d: CivilDate) => civilDateToISO(d);
/** Retirada de 1 peça sem exceção de domingo: nem ela nem a devolução (+2) caem em domingo. */
function plainPickup(from: CivilDate): CivilDate {
  let d = from;
  while (isSunday(d) || isSunday(addDays(d, 2))) d = addDays(d, 1);
  return d;
}
/** Janela exclusiva do teste, sempre além da antecedência mínima. */
function nextWindow(): CivilDate {
  return plainPickup(addDays(TODAY, 40 + 30 * windowCounter++));
}
const settle = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function dayInfo(variant: string, date: CivilDate) {
  return (await availability.getAvailability({ shopifyVariantId: variant, countedPieces: 1, from: iso(date), to: iso(date) })).days[0];
}
function hold(variant: string, date: CivilDate) {
  return holds.createHold({ items: [{ shopifyVariantId: variant, quantity: 1 }], pickupDate: iso(date), termsAccepted: true });
}
function manualReservation(unitId: string, date: CivilDate) {
  return manual.createManual({
    adminUserId: admin.id,
    adminUserName: admin.name,
    customerName: 'Cliente Calendário',
    customerPhone: '+56 9 5555 0000',
    pickupDate: iso(date),
    items: [{ rentalUnitId: unitId }],
  });
}
function storeBlock(start: CivilDate, end: CivilDate, label = 'loja fechada') {
  return blocksAdmin.create({ scope: 'STORE_WIDE', startDate: iso(start), endDate: iso(end), reason: `${PREFIX} ${label}`, adminUserId: admin.id }, admin.id, admin.name);
}
function unitBlock(unitId: string, start: CivilDate, end: CivilDate) {
  return blocksAdmin.create({ scope: 'UNIT', rentalUnitId: unitId, startDate: iso(start), endDate: iso(end), reason: `${PREFIX} peça em conserto`, adminUserId: admin.id }, admin.id, admin.name);
}
function setOperationStart(date: CivilDate | null) {
  return rulesAdmin.update({ operationStartDate: date ? iso(date) : null, adminUserId: admin.id } as UpdateRulesDto, admin.id, admin.name);
}

async function cleanup() {
  const reservationIds = (await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id FROM reservation_items ri JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ru.code LIKE ${PREFIX + '%'}
  `).map((r) => r.id);
  if (reservationIds.length) {
    await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM hold_idempotency_keys WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM manual_reservation_idempotency_keys WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${reservationIds}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM operational_blocks WHERE reason LIKE ${PREFIX + '%'}`;
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
  const admins = (await prisma.adminUser.findMany({ where: { phone: { startsWith: PREFIX } }, select: { id: true } })).map((a) => a.id);
  if (admins.length) {
    await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE admin_user_id = ANY(${admins}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM admin_users WHERE id = ANY(${admins}::uuid[])`;
  }
}

localDescribe('Calendário flexível — início da operação e períodos fechados (Postgres local)', () => {
  beforeAll(async () => {
    await cleanup();
    const [row] = await prisma.$queryRaw<{ start: string | null; end: string | null }[]>`SELECT blackout_start AS start, blackout_end AS "end" FROM rental_rule_config WHERE id = 'default'`;
    originalBlackout = row;
    const created = await prisma.adminUser.create({ data: { name: 'Admin Calendário', phone: `${PREFIX}-admin`, pinHash: 'test-only-hash', role: 'ADMIN', active: true } });
    admin = { id: created.id, name: created.name };
    const make = (code: string, variant: string) =>
      prisma.rentalUnit.create({ data: { code: `${PREFIX}-${code}`, name: 'Peça calendário', shopifyVariantId: variant, active: true, reservableOnline: true, countsTowardRentalDuration: true } });
    unitA1 = (await make('A1', VARIANT_A)).id;
    unitA2 = (await make('A2', VARIANT_A)).id;
    unitB1 = (await make('B1', VARIANT_B)).id;
  });

  afterAll(async () => {
    await prisma.$executeRaw`UPDATE rental_rule_config SET operation_start_date = NULL, blackout_start = ${originalBlackout.start}, blackout_end = ${originalBlackout.end} WHERE id = 'default'`;
    await cleanup();
    await prisma.$disconnect();
  });

  describe('data de início da operação', () => {
    test('antes do início indisponível; no dia do início disponível; depois o HOLD funciona normalmente', async () => {
      const start = nextWindow();
      await setOperationStart(start);
      try {
        const before = plainPickup(addDays(start, -6));
        const beforeInfo = await dayInfo(VARIANT_B, before);
        expect(beforeInfo).toMatchObject({ bookable: false, reason: 'pickup_before_operation_start' });
        await expect(hold(VARIANT_B, before)).rejects.toMatchObject({ status: 422, response: { violations: expect.arrayContaining(['pickup_before_operation_start']) } });

        expect(await dayInfo(VARIANT_B, start)).toMatchObject({ bookable: true, quantityAvailable: 1 });
        const after = plainPickup(addDays(start, 10));
        expect(await dayInfo(VARIANT_A, after)).toMatchObject({ bookable: true, quantityAvailable: 2 });
        await expect(hold(VARIANT_A, after)).resolves.toMatchObject({ status: 'hold', pickupDate: iso(after) });

        const response = await availability.getAvailability({ shopifyVariantId: VARIANT_B, countedPieces: 1, from: iso(start), to: iso(start) });
        expect(response.operationStartDate).toBe(iso(start));
      } finally {
        await setOperationStart(null);
      }
    });

    test('alteração pelo painel vale na próxima consulta, sem reiniciar nada', async () => {
      const start = nextWindow();
      const probe = plainPickup(addDays(start, -8));
      expect((await dayInfo(VARIANT_B, probe)).bookable).toBe(true);
      await setOperationStart(start);
      expect(await dayInfo(VARIANT_B, probe)).toMatchObject({ bookable: false, reason: 'pickup_before_operation_start' });
      await setOperationStart(null);
      expect((await dayInfo(VARIANT_B, probe)).bookable).toBe(true);
    });

    test('atravessa o ano: início em janeiro, dezembro anterior fica fechado', async () => {
      const year = TODAY.year + 2;
      const start = plainPickup(civilDate(year, 1, 5));
      await setOperationStart(start);
      try {
        expect(await dayInfo(VARIANT_B, plainPickup(civilDate(year - 1, 12, 28)))).toMatchObject({ bookable: false, reason: 'pickup_before_operation_start' });
        expect((await dayInfo(VARIANT_B, plainPickup(addDays(start, 1)))).bookable).toBe(true);
      } finally {
        await setOperationStart(null);
      }
    });

    test('painel: data inexistente → 422; null limpa; auditoria RULE_MODIFIED guarda antes/depois', async () => {
      await expect(rulesAdmin.update({ operationStartDate: '2031-02-30', adminUserId: admin.id } as UpdateRulesDto, admin.id, admin.name)).rejects.toMatchObject({ status: 422 });
      const start = nextWindow();
      const view = await setOperationStart(start);
      expect(view.operationStartDate).toBe(iso(start));
      expect(view).not.toHaveProperty('blackoutStart');
      const cleared = await setOperationStart(null);
      expect(cleared.operationStartDate).toBeNull();

      const audits = await prisma.adminAuditEvent.findMany({ where: { adminUserId: admin.id, action: 'RULE_MODIFIED' }, orderBy: { createdAt: 'desc' }, take: 2 });
      expect(audits[0]).toMatchObject({ isCritical: true, before: expect.objectContaining({ operationStartDate: iso(start) }), after: expect.objectContaining({ operationStartDate: null }) });
      expect(audits[1]).toMatchObject({ after: expect.objectContaining({ operationStartDate: iso(start) }) });
    });

    test('legado: a temporada antiga (06-01 a 09-30) gravada no banco não bloqueia mais nada', async () => {
      await prisma.$executeRaw`UPDATE rental_rule_config SET blackout_start = '06-01', blackout_end = '09-30', operation_start_date = NULL WHERE id = 'default'`;
      for (const [month, day] of [[6, 1], [7, 15], [9, 30]]) {
        const d = plainPickup(civilDate(TODAY.year + 1, month, day));
        expect(await dayInfo(VARIANT_B, d), iso(d)).toMatchObject({ bookable: true, reason: null });
      }
    });
  });

  describe('períodos fechados', () => {
    test('loja inteira: bloqueia todas as peças na disponibilidade, no HOLD e na reserva manual', async () => {
      const p = nextWindow();
      await storeBlock(addDays(p, -1), addDays(p, 1));
      expect(await dayInfo(VARIANT_A, p)).toMatchObject({ bookable: false, quantityAvailable: 0 });
      expect(await dayInfo(VARIANT_B, p)).toMatchObject({ bookable: false, quantityAvailable: 0 });
      await expect(hold(VARIANT_A, p)).rejects.toMatchObject({ status: 409 });
      await expect(manualReservation(unitB1, p)).rejects.toMatchObject({ status: 409, response: { reason: `${PREFIX} loja fechada` } });
    });

    test('peça específica: bloqueia só aquela peça', async () => {
      const p = nextWindow();
      await unitBlock(unitA1, p, addDays(p, 1));
      expect(await dayInfo(VARIANT_A, p)).toMatchObject({ bookable: true, quantityAvailable: 1 });
      expect(await dayInfo(VARIANT_B, p)).toMatchObject({ bookable: true, quantityAvailable: 1 });
      await expect(manualReservation(unitA1, p)).rejects.toMatchObject({ status: 409 });
      await expect(manualReservation(unitA2, p)).resolves.toMatchObject({ status: 'confirmed' });
    });

    test('desativado deixa de bloquear; reativado volta; auditoria de criação, ativação e desativação', async () => {
      const p = nextWindow();
      const block = await storeBlock(p, p);
      expect(block).toMatchObject({ active: true, removedAt: null });
      expect((await dayInfo(VARIANT_B, p)).bookable).toBe(false);

      await expect(blocksAdmin.setActive(block.id, false, admin.id, admin.name)).resolves.toMatchObject({ active: false });
      expect((await dayInfo(VARIANT_B, p)).bookable).toBe(true);
      await expect(blocksAdmin.setActive(block.id, false, admin.id, admin.name)).rejects.toMatchObject({ status: 409 });

      await expect(blocksAdmin.setActive(block.id, true, admin.id, admin.name)).resolves.toMatchObject({ active: true });
      expect((await dayInfo(VARIANT_B, p)).bookable).toBe(false);

      const listed = await blocksAdmin.list(true);
      expect(listed.find((b) => b.id === block.id)).toMatchObject({ active: true });

      const actions = (await prisma.adminAuditEvent.findMany({ where: { entityId: block.id }, orderBy: { createdAt: 'asc' } })).map((e) => [e.action, e.adminUserId, e.isCritical]);
      expect(actions).toEqual([
        ['BLOCK_CREATED', admin.id, true],
        ['BLOCK_DEACTIVATED', admin.id, true],
        ['BLOCK_ACTIVATED', admin.id, true],
      ]);
    });

    test('atravessando meses e anos (28/12 → 03/01)', async () => {
      const year = TODAY.year + 1;
      const block = await storeBlock(civilDate(year, 12, 28), civilDate(year + 1, 1, 3), 'recesso de fim de ano');
      try {
        for (const d of [civilDate(year, 12, 29), civilDate(year, 12, 31), civilDate(year + 1, 1, 2)]) {
          const info = await dayInfo(VARIANT_B, d);
          expect(info.bookable, iso(d)).toBe(false);
        }
        expect((await dayInfo(VARIANT_B, plainPickup(civilDate(year + 1, 1, 12)))).bookable).toBe(true);
        expect((await dayInfo(VARIANT_B, plainPickup(civilDate(year, 12, 10)))).bookable).toBe(true);
      } finally {
        // Data fixa (fora da janela deste teste): não pode sobrar ativa pros outros.
        await blocksAdmin.remove(block.id, admin.id, admin.name);
      }
    });

    test('vários períodos sobrepostos: só libera quando todos estão desativados', async () => {
      const p = nextWindow();
      const first = await storeBlock(addDays(p, -2), addDays(p, 1), 'evento');
      const second = await storeBlock(p, addDays(p, 3), 'manutenção');
      await blocksAdmin.setActive(first.id, false, admin.id, admin.name);
      expect((await dayInfo(VARIANT_B, p)).bookable).toBe(false);
      await blocksAdmin.setActive(second.id, false, admin.id, admin.name);
      expect((await dayInfo(VARIANT_B, p)).bookable).toBe(true);
    });

    test('preparação e higienização em volta do período fechado continuam bloqueando (limites exatos)', async () => {
      const config = await rules.load();
      const duration = 2; // 1 peça
      // Período de 1 dia em E. Retirada P ocupa [P - prep, P + duração + limpeza + 1).
      let end = nextWindow();
      const firstFreeAfter = () => addDays(end, config.prepDays + 1);
      const lastFreeBefore = () => addDays(end, -(duration + config.cleaningDays + 1));
      const dates = () => [firstFreeAfter(), addDays(firstFreeAfter(), -1), lastFreeBefore(), addDays(lastFreeBefore(), 1)];
      while (dates().some((d) => isSunday(d) || isSunday(addDays(d, duration)))) end = addDays(end, 1);
      await storeBlock(end, end, 'dia fechado');

      expect((await dayInfo(VARIANT_B, addDays(firstFreeAfter(), -1))).bookable).toBe(false); // preparação cairia no dia fechado
      expect((await dayInfo(VARIANT_B, firstFreeAfter())).bookable).toBe(true);
      expect((await dayInfo(VARIANT_B, addDays(lastFreeBefore(), 1))).bookable).toBe(false); // higienização cairia no dia fechado
      expect((await dayInfo(VARIANT_B, lastFreeBefore())).bookable).toBe(true);
    });

    test('domingo continua obedecendo à regra atual', async () => {
      let sunday = nextWindow();
      while (!isSunday(sunday)) sunday = addDays(sunday, 1);
      expect(await dayInfo(VARIANT_B, sunday)).toMatchObject({ bookable: false, reason: 'pickup_is_sunday' });
    });

    test('edição: muda datas e motivo com auditoria antes/depois; removido não edita; validações', async () => {
      const p = nextWindow();
      const block = await storeBlock(p, p, 'original');
      const edited = await blocksAdmin.update(block.id, { startDate: iso(addDays(p, 5)), endDate: iso(addDays(p, 6)), reason: `${PREFIX} editado`, adminUserId: admin.id }, admin.id, admin.name);
      expect(edited).toMatchObject({ startDate: iso(addDays(p, 5)), endDate: iso(addDays(p, 6)), reason: `${PREFIX} editado` });
      expect(edited.updatedAt).not.toBeNull();
      expect((await dayInfo(VARIANT_B, p)).bookable).toBe(true);

      const audit = await prisma.adminAuditEvent.findFirstOrThrow({ where: { entityId: block.id, action: 'BLOCK_UPDATED' } });
      expect(audit).toMatchObject({ before: expect.objectContaining({ startDate: iso(p), reason: `${PREFIX} original` }), after: expect.objectContaining({ startDate: iso(addDays(p, 5)) }) });

      await expect(blocksAdmin.update(block.id, { endDate: iso(addDays(p, 1)), adminUserId: admin.id }, admin.id, admin.name)).rejects.toMatchObject({ status: 400 });
      await expect(blocksAdmin.update(block.id, { scope: 'UNIT', adminUserId: admin.id }, admin.id, admin.name)).rejects.toMatchObject({ status: 400 });
      await expect(blocksAdmin.update(block.id, { startDate: '2031-02-30', adminUserId: admin.id }, admin.id, admin.name)).rejects.toMatchObject({ status: 400 });
      await expect(blocksAdmin.update('00000000-0000-4000-8000-000000000000', { reason: 'xxx', adminUserId: admin.id }, admin.id, admin.name)).rejects.toMatchObject({ status: 404 });

      await blocksAdmin.remove(block.id, admin.id, admin.name);
      await expect(blocksAdmin.update(block.id, { reason: `${PREFIX} tarde demais`, adminUserId: admin.id }, admin.id, admin.name)).rejects.toMatchObject({ status: 409 });
      await expect(blocksAdmin.setActive(block.id, false, admin.id, admin.name)).rejects.toMatchObject({ status: 409 });
      expect((await blocksAdmin.list(true)).some((b) => b.id === block.id)).toBe(false);
      expect((await blocksAdmin.list(false)).find((b) => b.id === block.id)?.removedAt).not.toBeNull();
    });

    test('criar período por cima de reserva confirmada não altera a reserva', async () => {
      const p = nextWindow();
      const existing = await manualReservation(unitB1, p);
      const before = await prisma.reservation.findUniqueOrThrow({ where: { id: existing.reservationId }, include: { items: true } });
      await storeBlock(addDays(p, -1), addDays(p, 1), 'fechado depois da reserva');
      const after = await prisma.reservation.findUniqueOrThrow({ where: { id: existing.reservationId }, include: { items: true } });
      expect(after.status).toBe('confirmed');
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(after.items).toEqual(before.items);
    });

    test('legado: bloqueio gravado antes da coluna `active` continua bloqueando', async () => {
      const p = nextWindow();
      await prisma.$executeRaw`
        INSERT INTO operational_blocks (scope, start_date, end_date, reason, created_by_admin_user_id)
        VALUES ('STORE_WIDE', ${iso(p)}::date, ${iso(p)}::date, ${`${PREFIX} legado`}, ${admin.id}::uuid)
      `;
      expect((await dayInfo(VARIANT_B, p)).bookable).toBe(false);
      expect((await blocksAdmin.list(true)).find((b) => b.reason === `${PREFIX} legado`)).toMatchObject({ active: true });
    });
  });

  describe('concorrência', () => {
    test('criação de período em andamento: o HOLD espera o commit e é recusado', async () => {
      const p = nextWindow();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockedSignal = new Promise<void>((resolve) => (locked = resolve));
      // Mesma sequência de AdminBlocksService.create: lock exclusivo, depois o INSERT.
      const creation = prisma.$transaction(async (tx) => {
        await lockOperationalBlocks(tx, true);
        await tx.operationalBlock.create({ data: { scope: 'STORE_WIDE', startDate: new Date(iso(p)), endDate: new Date(iso(p)), reason: `${PREFIX} concorrente`, createdByAdminUserId: admin.id } });
        locked();
        await gate;
      }, { timeout: 20_000 });
      await lockedSignal;

      let settled = false;
      const attempt = settle(hold(VARIANT_B, p)).finally(() => (settled = true));
      await sleep(700);
      expect(settled).toBe(false);
      release();
      await creation;
      const outcome = await attempt;
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.error).toMatchObject({ status: 409 });
    }, 30_000);

    test('mudança da data de início em andamento: o HOLD espera e usa a regra nova', async () => {
      const p = nextWindow();
      const start = plainPickup(addDays(p, 20));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockedSignal = new Promise<void>((resolve) => (locked = resolve));
      // Mesma sequência de AdminRulesService.update: lock exclusivo, depois o UPDATE.
      const change = prisma.$transaction(async (tx) => {
        await lockOperationalBlocks(tx, true);
        await tx.rentalRuleConfig.update({ where: { id: 'default' }, data: { operationStartDate: new Date(iso(start)) } });
        locked();
        await gate;
      }, { timeout: 20_000 });
      await lockedSignal;

      try {
        let settled = false;
        const attempt = settle(hold(VARIANT_B, p)).finally(() => (settled = true));
        await sleep(700);
        expect(settled).toBe(false);
        release();
        await change;
        const outcome = await attempt;
        expect(outcome.ok).toBe(false);
        expect(!outcome.ok && outcome.error).toMatchObject({ status: 422, response: { violations: expect.arrayContaining(['pickup_before_operation_start']) } });
      } finally {
        release();
        await change.catch(() => undefined);
        await setOperationStart(null);
      }
    }, 30_000);

    test('reserva em andamento: a alteração do período espera ela terminar', async () => {
      const p = nextWindow();
      const block = await storeBlock(p, p, 'para desativar');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockedSignal = new Promise<void>((resolve) => (locked = resolve));
      // Mesma trava que HOLD/reserva manual tomam (compartilhada).
      const allocation = prisma.$transaction(async (tx) => {
        await lockOperationalBlocks(tx);
        locked();
        await gate;
      }, { timeout: 20_000 });
      await lockedSignal;

      let settled = false;
      const change = settle(blocksAdmin.setActive(block.id, false, admin.id, admin.name)).finally(() => (settled = true));
      await sleep(700);
      expect(settled).toBe(false);
      release();
      await allocation;
      expect((await change).ok).toBe(true);
    }, 30_000);

    test('duplo clique em desativar: exatamente uma alteração e uma auditoria', async () => {
      const p = nextWindow();
      const block = await storeBlock(p, p, 'duplo clique');
      const results = await Promise.all([1, 2, 3].map(() => settle(blocksAdmin.setActive(block.id, false, admin.id, admin.name))));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await prisma.adminAuditEvent.count({ where: { entityId: block.id, action: 'BLOCK_DEACTIVATED' } })).toBe(1);
    });
  });

  test('rotas: períodos exigem ADMIN + módulo RULES; regras exigem RULES e ADMIN para alterar', () => {
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, AdminBlocksController)).toBe('ADMIN');
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, AdminBlocksController)).toBe('RULES');
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, AdminRulesController)).toBe('RULES');
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, AdminRulesController.prototype.update)).toBe('ADMIN');
  });
});
