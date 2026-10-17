import 'reflect-metadata';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { AdminCalendarService } from '../admin-panel/calendar.service';
import { AdminReservationsService } from '../admin-reservations/admin-reservations.service';
import { loadOccupations } from '../availability/occupations';
import { kindForReservationStatus } from '../availability/unavailable-reason';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';
import { addDays, civilDateFromISO, civilDateToISO, type CivilDate } from '../rental-rules/civil-date';
import { today as engineToday } from '../rental-rules/rental-engine';
import { OCCUPYING_RESERVATION_STATUSES } from '../reservation-status';
import { heldUntilCompleted, occupiesWindow } from './occupancy-sql';

/**
 * Leitura por peça (Fase 3): EQUIVALÊNCIA entre o SQL/leitura ANTIGOS e os novos fragmentos, e comportamento com peças
 * da mesma reserva em períodos diferentes. Integração contra PostgreSQL LOCAL de teste (sem `DATABASE_URL` de loopback
 * com nome de teste o arquivo é pulado).
 *
 * O SQL antigo está copiado abaixo, VERBATIM (como era em `main` antes desta mudança), e serve de oráculo. A matriz
 * roda dentro de uma transação que sempre desfaz; só o bloco "recebimento" grava de verdade (e limpa no fim).
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const rules = new RentalRuleConfigService(prisma);
const iso = civilDateToISO;
const pg = (d: CivilDate) => new Date(`${iso(d)}T00:00:00.000Z`);

class Rollback extends Error {}
type Tx = Prisma.TransactionClient;
async function inTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 20_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

// ── SQL ANTIGO (oráculo), verbatim ─────────────────────────────────────────────────────────────────────────────────
/** holds.service / admin-reservations.service (criação manual): unidades ocupadas na janela. */
const LEGACY_OCCUPIED_UNITS = `
  SELECT DISTINCT rental_unit_id AS "rentalUnitId"
  FROM reservation_items
  WHERE rental_unit_id = ANY($1::uuid[])
    AND status = ANY($2::"reservation_status"[])
    AND (
      blocked_range && daterange($3::date, $4::date, '[)')
      OR (status IN ('returned', 'cleaning') AND lower(blocked_range) <= $4::date)
    )`;
/** availability/occupations.ts */
const LEGACY_OCCUPATIONS = `
  SELECT
    ri.rental_unit_id AS "rentalUnitId",
    ri.status::text AS "status",
    CASE WHEN ri.status IN ('returned', 'cleaning') THEN $3::date ELSE lower(ri.blocked_range) END AS "lo",
    CASE WHEN ri.status IN ('returned', 'cleaning') THEN $4::date ELSE upper(ri.blocked_range) END AS "hi",
    r.pickup_date AS "pickup",
    r.return_date AS "return"
  FROM reservation_items ri
  JOIN reservations r ON r.id = ri.reservation_id
  WHERE ri.rental_unit_id = ANY($1::uuid[])
    AND ri.status = ANY($2::"reservation_status"[])
    AND (
      ri.blocked_range && daterange($3::date, $4::date, '[)')
      OR (ri.status IN ('returned', 'cleaning') AND lower(ri.blocked_range) <= $4::date)
    )`;
/** admin-panel/calendar.service.ts */
const LEGACY_CALENDAR = `
  SELECT
    ri.reservation_id AS "reservationId", ri.status, r.source, r.customer_name AS "customerName",
    ri.rental_unit_id AS "rentalUnitId", ru.code AS "rentalUnitCode",
    r.pickup_date::text AS "pickupDate", r.return_date::text AS "effectiveReturnDate",
    (CASE WHEN ri.status IN ('returned', 'cleaning') THEN $1::date ELSE lower(ri.blocked_range) END)::text AS "blockedFrom",
    (CASE WHEN ri.status IN ('returned', 'cleaning') THEN $2::date ELSE upper(ri.blocked_range) END)::text AS "blockedUntilExclusive"
  FROM reservation_items ri
  JOIN reservations r ON r.id = ri.reservation_id
  JOIN rental_units ru ON ru.id = ri.rental_unit_id
  WHERE ri.status = ANY($3::"reservation_status"[])
    AND (
      ri.blocked_range && daterange($1::date, $2::date, '[)')
      OR (ri.status IN ('returned', 'cleaning') AND lower(ri.blocked_range) <= $2::date)
    )
  ORDER BY "blockedFrom"`;

// ── fixtures dentro da transação ───────────────────────────────────────────────────────────────────────────────────
let seq = 0;
async function insertStore(tx: Tx, id: string) {
  await tx.$executeRawUnsafe(`INSERT INTO stores (id, shopify_domain, currency) VALUES ('${id}', '${id}.invalid', 'BRL')`);
}
async function insertUnit(tx: Tx, prefix: string): Promise<{ id: string; code: string }> {
  const code = `${prefix}-U${++seq}`;
  const [row] = await tx.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO rental_units (code, name, shopify_variant_id) VALUES ('${code}', 'peça', '${code}') RETURNING id`);
  return { id: row.id, code };
}
async function insertReservation(tx: Tx, store: string, status: string, pickup: CivilDate, ret: CivilDate): Promise<string> {
  const [row] = await tx.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO reservations (id, status, source, origin_store_id, pickup_date, return_date) VALUES (gen_random_uuid(), '${status}', 'manual_admin', '${store}', '${iso(pickup)}', '${iso(ret)}') RETURNING id`);
  return row.id;
}
async function insertLegacyItem(tx: Tx, reservationId: string, unitId: string, status: string, from: CivilDate, until: CivilDate): Promise<string> {
  const [row] = await tx.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO reservation_items (reservation_id, rental_unit_id, status, blocked_range) VALUES ('${reservationId}', '${unitId}', '${status}', daterange('${iso(from)}', '${iso(until)}', '[)')) RETURNING id`);
  return row.id;
}
/** Item com cronograma PRÓPRIO (colunas da A1), coerente com os CHECKs: devolução = retirada + dias, janela = [retirada − prep, devolução + limpeza + 1). */
async function insertPieceItem(tx: Tx, reservationId: string, unitId: string, status: string, pickup: CivilDate, days: number, prep = 3, clean = 2): Promise<{ id: string; ret: CivilDate }> {
  const ret = addDays(pickup, days);
  const [row] = await tx.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO reservation_items (reservation_id, rental_unit_id, status, blocked_range, pickup_date, rental_days, calculated_return_date, return_date, prep_days_applied, cleaning_days_applied)
     VALUES ('${reservationId}', '${unitId}', '${status}', daterange('${iso(addDays(pickup, -prep))}', '${iso(addDays(ret, clean + 1))}', '[)'),
             '${iso(pickup)}', ${days}, '${iso(ret)}', '${iso(ret)}', ${prep}, ${clean}) RETURNING id`);
  return { id: row.id, ret };
}
const occupiedUnits = async (tx: Tx, unitIds: string[], from: CivilDate, to: CivilDate): Promise<string[]> =>
  (await tx.$queryRaw<{ rentalUnitId: string }[]>`SELECT DISTINCT rental_unit_id AS "rentalUnitId" FROM reservation_items
     WHERE rental_unit_id = ANY(${unitIds}::uuid[]) AND ${occupiesWindow(iso(from), iso(to))}`).map((r) => r.rentalUnitId).sort();

localDescribe('leitura por peça — equivalência e períodos diferentes (Postgres local)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('matriz status × posição da janela: SQL antigo × fragmentos novos', () => {
    const S = civilDateFromISO('2027-03-01');
    const T = addDays(S, 10);
    const POSITIONS: [string, number, number][] = [
      ['termina bem antes de S', -30, -20],
      ['termina exatamente em S (encosta)', -10, 0],
      ['cruza o início', -5, 3],
      ['dentro', 2, 6],
      ['cruza o fim', 8, 15],
      ['começa exatamente em T', 10, 15],
      ['começa um dia depois de T', 11, 16],
      ['depois', 100, 110],
    ];

    test('ocupação por unidade: igual ao SQL antigo E igual à regra escrita do zero, em TODAS as combinações', async () => {
      await inTx(async (tx) => {
        const statuses = (await tx.$queryRawUnsafe<{ s: string }[]>('SELECT unnest(enum_range(NULL::reservation_status))::text AS s')).map((r) => r.s);
        expect(statuses.length).toBeGreaterThanOrEqual(13);
        await insertStore(tx, 'rd-matrix');
        const cases: { unitId: string; code: string; status: string; position: string; a: number; b: number }[] = [];
        for (const status of statuses) {
          for (const [position, a, b] of POSITIONS) {
            const unit = await insertUnit(tx, 'MX');
            const reservationId = await insertReservation(tx, 'rd-matrix', status, S, T);
            await insertLegacyItem(tx, reservationId, unit.id, status, addDays(S, a), addDays(S, b));
            cases.push({ unitId: unit.id, code: unit.code, status, position, a, b });
          }
        }
        const unitIds = cases.map((c) => c.unitId);

        const legacy = (await tx.$queryRawUnsafe<{ rentalUnitId: string }[]>(LEGACY_OCCUPIED_UNITS, unitIds, [...OCCUPYING_RESERVATION_STATUSES], iso(S), iso(T))).map((r) => r.rentalUnitId).sort();
        const novo = await occupiedUnits(tx, unitIds, S, T);
        expect(novo).toEqual(legacy);

        // regra escrita do zero (não depende de nenhum dos dois SQLs)
        const held = ['returned', 'cleaning'];
        const expected = cases
          .filter((c) => {
            const occupying = (OCCUPYING_RESERVATION_STATUSES as readonly string[]).includes(c.status);
            const overlaps = c.a < 10 && 0 < c.b; // [a,b) cruza [0,10)
            return occupying && (overlaps || (held.includes(c.status) && c.a <= 10));
          })
          .map((c) => c.unitId)
          .sort();
        expect(novo).toEqual(expected);
        expect(novo.length).toBeGreaterThan(20); // a matriz de fato exercita ocupação
        expect(novo.length).toBeLessThan(unitIds.length); // e de fato exclui casos

        // fronteiras que importam para "nunca liberar indevidamente"
        const by = (status: string, position: string) => cases.find((c) => c.status === status && c.position === position)!.unitId;
        for (const status of held) {
          for (const position of ['termina bem antes de S', 'termina exatamente em S (encosta)', 'começa exatamente em T']) {
            expect(novo, `${status} / ${position} deve seguir ocupada`).toContain(by(status, position));
          }
          expect(novo, `${status} / começa um dia depois de T`).not.toContain(by(status, 'começa um dia depois de T'));
        }
        for (const status of ['confirmed', 'picked_up', 'completed', 'cancelled', 'expired']) {
          expect(novo, `${status} / termina bem antes de S`).not.toContain(by(status, 'termina bem antes de S'));
        }
        for (const status of ['completed', 'cancelled', 'expired', 'late_payment_conflict']) {
          for (const [position] of POSITIONS) expect(novo, `${status} / ${position} nunca ocupa`).not.toContain(by(status, position));
        }
      });
    }, 120_000);

    test('disponibilidade (loadOccupations) e calendário: mesmas linhas do SQL antigo', async () => {
      await inTx(async (tx) => {
        const statuses = ['hold', 'pending_payment', 'confirmed', 'picked_up', 'returned', 'cleaning', 'completed', 'cancelled', 'problem'];
        await insertStore(tx, 'rd-views');
        const units: { id: string; code: string }[] = [];
        for (const status of statuses) {
          for (const [, a, b] of POSITIONS) {
            const unit = await insertUnit(tx, 'VW');
            units.push(unit);
            const pickup = addDays(S, a + 2);
            const reservationId = await insertReservation(tx, 'rd-views', status, pickup, addDays(pickup, 2));
            await insertLegacyItem(tx, reservationId, unit.id, status, addDays(S, a), addDays(S, b));
          }
        }
        const unitIds = units.map((u) => u.id);

        // disponibilidade
        const legacyRows = await tx.$queryRawUnsafe<{ rentalUnitId: string; status: string; lo: Date; hi: Date; pickup: Date | null; return: Date | null }[]>(
          LEGACY_OCCUPATIONS, unitIds, [...OCCUPYING_RESERVATION_STATUSES], iso(S), iso(T));
        const expectedOccupations = legacyRows.map((row) => {
          const kind = kindForReservationStatus(row.status);
          const rentalPeriod = kind !== 'preparation' && row.pickup && row.return ? `${iso(civilDateFromISO(row.pickup.toISOString().slice(0, 10)))}|${iso(addDays(civilDateFromISO(row.return.toISOString().slice(0, 10)), 1))}` : '-';
          return `${row.rentalUnitId}|${row.lo.toISOString().slice(0, 10)}|${row.hi.toISOString().slice(0, 10)}|${kind}|${rentalPeriod}`;
        }).sort();
        const actual = (await loadOccupations(tx, unitIds, S, T)).map((o) =>
          `${o.unitId}|${iso(o.range.blockedFrom)}|${iso(o.range.blockedUntilExclusive)}|${o.kind}|${o.rentalPeriod ? `${iso(o.rentalPeriod.blockedFrom)}|${iso(o.rentalPeriod.blockedUntilExclusive)}` : '-'}`).sort();
        expect(actual).toEqual(expectedOccupations);
        expect(actual.length).toBeGreaterThan(20);

        // calendário
        const mine = new Set(units.map((u) => u.code));
        const legacyCalendar = (await tx.$queryRawUnsafe<Record<string, string>[]>(LEGACY_CALENDAR, iso(S), iso(T), [...OCCUPYING_RESERVATION_STATUSES]))
          .filter((row) => mine.has(row.rentalUnitCode)).map((row) => JSON.stringify(row, Object.keys(row).sort())).sort();
        const calendar = new AdminCalendarService(tx as unknown as PrismaService);
        const novoCalendar = (await calendar.getCalendar(iso(S), iso(T)))
          .filter((row) => mine.has(row.rentalUnitCode)).map((row) => JSON.stringify(row, Object.keys(row).sort())).sort();
        expect(novoCalendar).toEqual(legacyCalendar);
        expect(novoCalendar.length).toBeGreaterThan(20);
      });
    }, 120_000);
  });

  describe('peças da MESMA reserva em períodos diferentes', () => {
    const D = civilDateFromISO('2027-03-01');

    test('calendário e disponibilidade mostram as datas e a janela de CADA peça (item legado segue com as da reserva)', async () => {
      await inTx(async (tx) => {
        await insertStore(tx, 'rd-piece');
        const a = await insertUnit(tx, 'PC');
        const b = await insertUnit(tx, 'PC');
        const legacyUnit = await insertUnit(tx, 'PC');
        // reserva por peça: A retira 02/03 por 3 dias; B retira 20/03 por 2 dias. Datas do pedido = mín./máx. dos itens.
        const reservationId = await insertReservation(tx, 'rd-piece', 'confirmed', addDays(D, 1), addDays(D, 21));
        const itemA = await insertPieceItem(tx, reservationId, a.id, 'confirmed', addDays(D, 1), 3); // 02/03 → 05/03, janela [27/02, 08/03)
        const itemB = await insertPieceItem(tx, reservationId, b.id, 'confirmed', addDays(D, 19), 2); // 20/03 → 22/03, janela [17/03, 25/03)
        const legacyRes = await insertReservation(tx, 'rd-piece', 'confirmed', addDays(D, 9), addDays(D, 11));
        await insertLegacyItem(tx, legacyRes, legacyUnit.id, 'confirmed', addDays(D, 4), addDays(D, 16));

        const calendar = new AdminCalendarService(tx as unknown as PrismaService);
        const rows = await calendar.getCalendar(iso(addDays(D, -10)), iso(addDays(D, 40)));
        const byCode = new Map(rows.map((r) => [r.rentalUnitCode, r]));
        expect([byCode.get(a.code)?.pickupDate, byCode.get(a.code)?.effectiveReturnDate]).toEqual([iso(addDays(D, 1)), iso(itemA.ret)]);
        expect([byCode.get(b.code)?.pickupDate, byCode.get(b.code)?.effectiveReturnDate]).toEqual([iso(addDays(D, 19)), iso(itemB.ret)]);
        // item legado: datas da reserva (a leitura antiga)
        expect([byCode.get(legacyUnit.code)?.pickupDate, byCode.get(legacyUnit.code)?.effectiveReturnDate]).toEqual([iso(addDays(D, 9)), iso(addDays(D, 11))]);
        // o que a leitura ANTIGA mostraria para a peça A seria 02/03–22/03 (datas do pedido): a nova mostra 02/03–05/03
        expect(byCode.get(a.code)?.effectiveReturnDate).not.toBe(iso(addDays(D, 21)));

        // janelas independentes dentro da mesma reserva
        const occupied = (from: number, to: number) => occupiedUnits(tx, [a.id, b.id], addDays(D, from), addDays(D, to));
        expect(await occupied(9, 14)).toEqual([]); // entre as duas janelas: nenhuma peça ocupada
        expect(await occupied(23, 30)).toEqual([b.id]); // só B (a janela de B é [17/03, 25/03))
        expect(await occupied(0, 3)).toEqual([a.id]); // só A
        expect(await occupied(0, 40)).toEqual([a.id, b.id].sort());

        // período de aluguel (rentalPeriod) por peça na disponibilidade
        const occ = await loadOccupations(tx, [a.id, b.id], addDays(D, -10), addDays(D, 40));
        const period = (unitId: string) => occ.find((o) => o.unitId === unitId)?.rentalPeriod;
        expect([iso(period(a.id)!.blockedFrom), iso(period(a.id)!.blockedUntilExclusive)]).toEqual([iso(addDays(D, 1)), iso(addDays(itemA.ret, 1))]);
        expect([iso(period(b.id)!.blockedFrom), iso(period(b.id)!.blockedUntilExclusive)]).toEqual([iso(addDays(D, 19)), iso(addDays(itemB.ret, 1))]);
      });
    });

    test('ciclo de devolução por peça: recebida e em higienização seguem ocupadas em QUALQUER janela futura; só completed libera', async () => {
      await inTx(async (tx) => {
        await insertStore(tx, 'rd-cycle');
        const a = await insertUnit(tx, 'CY');
        const b = await insertUnit(tx, 'CY');
        const reservationId = await insertReservation(tx, 'rd-cycle', 'confirmed', addDays(D, 1), addDays(D, 21));
        const itemA = await insertPieceItem(tx, reservationId, a.id, 'confirmed', addDays(D, 1), 3);
        await insertPieceItem(tx, reservationId, b.id, 'confirmed', addDays(D, 19), 2);
        const farFuture: [CivilDate, CivilDate][] = [[addDays(D, 50), addDays(D, 60)], [addDays(D, 400), addDays(D, 410)], [addDays(D, 3000), addDays(D, 3005)]];

        for (const [status, mustBeHeld] of [['confirmed', false], ['picked_up', false], ['returned', true], ['cleaning', true], ['completed', false]] as const) {
          await tx.$executeRawUnsafe(`UPDATE reservation_items SET status = '${status}' WHERE id = '${itemA.id}'`);
          for (const [from, to] of farFuture) {
            const occupied = await occupiedUnits(tx, [a.id, b.id], from, to);
            expect(occupied.includes(a.id), `${status} em [${iso(from)}, ${iso(to)})`).toBe(mustBeHeld);
            expect(occupied.includes(b.id), 'a OUTRA peça da reserva (ainda confirmada) não é afetada').toBe(false);
          }
        }
        // peça devolvida atrasada: janela planejada já terminou, mas continua ocupada hoje
        await tx.$executeRawUnsafe(`UPDATE reservation_items SET status = 'returned' WHERE id = '${itemA.id}'`);
        expect(await occupiedUnits(tx, [a.id], addDays(itemA.ret, 40), addDays(itemA.ret, 41))).toEqual([a.id]);
      });
    });
  });

  describe('recebimento, ocorrência e atraso lidos por peça (fixtures gravadas, limpas no fim)', () => {
    const prefix = `RDR-${Date.now()}`;
    const storeId = `${prefix}-store`;
    // Atraso e ocorrência gravam auditoria (FK para admin_users): o operador precisa existir de verdade.
    let actor: { id: string; name: string };
    const service = new AdminReservationsService(prisma, rules);
    const reservationIds: string[] = [];
    const unitIds: string[] = [];
    let today: CivilDate;

    const make = async (pickup: CivilDate, ret: CivilDate) => {
      const code = `${prefix}-${unitIds.length}`;
      const unit = await prisma.rentalUnit.create({ data: { code, name: 'peça', shopifyVariantId: code, active: true, reservableOnline: true, countsTowardRentalDuration: true } });
      unitIds.push(unit.id);
      const reservation = await prisma.reservation.create({ data: { status: 'confirmed', source: 'manual_admin', originStoreId: storeId, pickupDate: pg(pickup), returnDate: pg(ret), confirmedAt: new Date() } });
      reservationIds.push(reservation.id);
      return { reservationId: reservation.id, unitId: unit.id };
    };
    const addUnit = async () => {
      const code = `${prefix}-${unitIds.length}`;
      const unit = await prisma.rentalUnit.create({ data: { code, name: 'peça', shopifyVariantId: code, active: true, reservableOnline: true, countsTowardRentalDuration: true } });
      unitIds.push(unit.id);
      return unit.id;
    };
    const legacyItem = async (reservationId: string, unitId: string, pickup: CivilDate, ret: CivilDate) => {
      const [row] = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO reservation_items (reservation_id, rental_unit_id, status, blocked_range) VALUES ('${reservationId}', '${unitId}', 'confirmed', daterange('${iso(addDays(pickup, -3))}', '${iso(addDays(ret, 3))}', '[)')) RETURNING id`);
      return row.id;
    };
    const pieceItem = async (reservationId: string, unitId: string, ret: CivilDate) => {
      const pickup = addDays(ret, -2);
      const [row] = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO reservation_items (reservation_id, rental_unit_id, status, blocked_range, pickup_date, rental_days, calculated_return_date, return_date, prep_days_applied, cleaning_days_applied)
         VALUES ('${reservationId}', '${unitId}', 'confirmed', daterange('${iso(addDays(pickup, -3))}', '${iso(addDays(ret, 3))}', '[)'), '${iso(pickup)}', 2, '${iso(ret)}', '${iso(ret)}', 3, 2) RETURNING id`);
      return row.id;
    };
    const returnRecord = (itemId: string) => prisma.reservationItemReturn.findFirstOrThrow({ where: { reservationItemId: itemId } });
    const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

    beforeAll(async () => {
      today = engineToday(DEFAULT_RENTAL_RULE_CONFIG);
      const admin = await prisma.adminUser.create({ data: { name: 'Operador sintético', phone: `${prefix}-admin`, pinHash: 'test-only-hash', role: 'ADMIN', active: true } });
      actor = { id: admin.id, name: admin.name };
      await prisma.store.create({ data: { id: storeId, shopifyDomain: `${prefix.toLowerCase()}.invalid`, currency: 'BRL' } });
    });
    afterAll(async () => {
      if (reservationIds.length) {
        await prisma.reservationItemOccurrence.deleteMany({ where: { reservationId: { in: reservationIds } } });
        await prisma.reservationItemReturn.deleteMany({ where: { reservationId: { in: reservationIds } } });
        await prisma.reservationEvent.deleteMany({ where: { reservationId: { in: reservationIds } } });
        await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
        await prisma.reservation.deleteMany({ where: { id: { in: reservationIds } } });
      }
      if (unitIds.length) await prisma.rentalUnit.deleteMany({ where: { id: { in: unitIds } } });
      await prisma.store.delete({ where: { id: storeId } });
      await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE admin_user_id = ${actor.id}::uuid`;
      await prisma.$executeRaw`DELETE FROM admin_users WHERE id = ${actor.id}::uuid`;
    });

    test('reserva LEGADA: atraso e devolução prevista saem da reserva (comportamento idêntico ao de antes)', async () => {
      const ret = addDays(today, -6);
      const r = await make(addDays(ret, -2), ret);
      const itemId = await legacyItem(r.reservationId, r.unitId, addDays(ret, -2), ret);
      const detail = await service.getReservationDetail(r.reservationId);
      expect(detail.overdueDays).toBe(6);
      expect(detail.items[0].overdueDays).toBe(6);
      await service.advanceOperational(r.reservationId, itemId, 'receive', actor, undefined, { condition: 'good' });
      const record = await returnRecord(itemId);
      expect(record.daysLate).toBe(6);
      expect(dayOf(record.expectedReturnDate)).toBe(iso(ret));
    }, 60_000);

    test('duas peças da mesma reserva com devoluções diferentes: atraso e prevista de CADA uma, não o do pedido', async () => {
      const retA = addDays(today, -9);
      const retB = addDays(today, -2);
      const r = await make(addDays(retA, -2), retB); // pedido: mín. da retirada, máx. da devolução
      const itemA = await pieceItem(r.reservationId, r.unitId, retA);
      const itemB = await pieceItem(r.reservationId, await addUnit(), retB);

      const detail = await service.getReservationDetail(r.reservationId);
      const overdue = Object.fromEntries(detail.items.map((i) => [i.id, i.overdueDays]));
      expect(overdue[itemA]).toBe(9); // a leitura antiga daria 2 (data do pedido)
      expect(overdue[itemB]).toBe(2);
      expect(detail.overdueDays).toBe(9);

      await service.advanceOperational(r.reservationId, itemA, 'receive', actor, undefined, { condition: 'good' });
      await service.advanceOperational(r.reservationId, itemB, 'receive', actor, undefined, { condition: 'good' });
      const [recordA, recordB] = [await returnRecord(itemA), await returnRecord(itemB)];
      expect([recordA.daysLate, dayOf(recordA.expectedReturnDate)]).toEqual([9, iso(retA)]);
      expect([recordB.daysLate, dayOf(recordB.expectedReturnDate)]).toEqual([2, iso(retB)]);
    }, 60_000);

    test('"peça não devolvida" vale pela data DA PEÇA: a vencida aceita, a que ainda não venceu recusa', async () => {
      const retA = addDays(today, -1);
      const retC = addDays(today, 10);
      const r = await make(addDays(retA, -2), retC);
      const itemA = await pieceItem(r.reservationId, r.unitId, retA);
      const itemC = await pieceItem(r.reservationId, await addUnit(), retC);
      await expect(service.recordOccurrence(r.reservationId, itemA, 'not_returned', 'Cliente não devolveu', actor)).resolves.toBeDefined();
      await expect(service.recordOccurrence(r.reservationId, itemC, 'not_returned', 'Ainda não deveria', actor)).rejects.toThrow(/ainda não chegou/);
      // reserva LEGADA com devolução no futuro: segue recusando
      const legacy = await make(addDays(today, 5), addDays(today, 8));
      const legacyItemId = await legacyItem(legacy.reservationId, legacy.unitId, addDays(today, 5), addDays(today, 8));
      await expect(service.recordOccurrence(legacy.reservationId, legacyItemId, 'not_returned', 'Cedo demais', actor)).rejects.toThrow(/ainda não chegou/);
    }, 60_000);
  });

  describe('a regra não voltou a ser copiada', () => {
    test('fora de reservation-schedule/ só resta a cópia da recuperação de pagamento tardio (webhook de pagamento, fora do escopo)', () => {
      const srcDir = path.resolve(__dirname, '..');
      const offenders: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = path.join(dir, entry);
          if (statSync(full).isDirectory()) { walk(full); continue; }
          const rel = path.relative(srcDir, full).split(path.sep).join('/');
          if (!rel.endsWith('.ts') || rel.endsWith('.test.ts') || rel.startsWith('reservation-schedule/')) continue;
          const text = readFileSync(full, 'utf8');
          if (/lower\((ri\.)?blocked_range\)\s*<=/.test(text) || /status IN \('returned', 'cleaning'\)/.test(text)) offenders.push(rel);
        }
      };
      walk(srcDir);
      // webhooks.service.ts (attemptLatePaymentRecovery) mantém a cópia inline de propósito: é caminho de pagamento e
      // não pode ser alterado sem autorização própria. Quando for migrado, esta lista passa a ser vazia.
      expect(offenders).toEqual(['webhooks/webhooks.service.ts']);
    });

    test('a cópia que sobrou é igual à regra central (mesma semântica) — para o dia em que for migrada', async () => {
      const webhooks = readFileSync(path.resolve(__dirname, '../webhooks/webhooks.service.ts'), 'utf8');
      expect(webhooks).toContain("blocked_range && daterange(${from}::date, ${until}::date, '[)')");
      expect(webhooks).toContain("OR (status IN ('returned', 'cleaning') AND lower(blocked_range) <= ${until}::date)");
      expect(heldUntilCompleted().text.replace(/\s+/g, ' ')).toBe("status IN ('returned', 'cleaning')");
    });
  });
});
