import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { AdminReservationsService } from './admin-reservations.service';
import { type CivilDate, addDays, civilDateToISO, isSunday } from '../rental-rules/civil-date';
import { calculateReturnDate, isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';
import type { CreateManualReservationDto } from './dto/create-manual-reservation.dto';

/**
 * Fase 9, item 8 — /closetadmin/reservas (lista + detalhe). Cobre os
 * novos `listReservations`/`getReservationDetail`, que
 * admin-reservations.service.test.ts (Fase 8) ainda não testava.
 */
const prisma = new PrismaService();
const rentalRuleConfig = new RentalRuleConfigService(prisma);
const service = new AdminReservationsService(prisma, rentalRuleConfig);

const CFG = DEFAULT_RENTAL_RULE_CONFIG;
const PREFIX = `admin-res-list-test-${Date.now()}`;
let unitCounter = 0;

function pickupSafe(date: CivilDate): CivilDate {
  let d = date;
  for (let i = 0; i < 400 && (!isOnlineReservationAllowed(d, CFG) || isSunday(d)); i++) d = addDays(d, 1);
  return d;
}
function futurePickup(daysFromToday: number): CivilDate {
  return pickupSafe(addDays(engineToday(CFG), daysFromToday));
}
function pickupWithoutSundayReturn(durationDays: number, daysFromToday: number): CivilDate {
  let d = futurePickup(daysFromToday);
  for (let i = 0; i < 400 && isSunday(calculateReturnDate(d, durationDays)); i++) d = pickupSafe(addDays(d, 1));
  return d;
}

async function createUnit(): Promise<string> {
  const code = `${PREFIX}-u${unitCounter++}`;
  const unit = await prisma.rentalUnit.create({
    data: { code, name: 'peça de teste', shopifyVariantId: `${code}-variant`, active: true, reservableOnline: true, countsTowardRentalDuration: true },
  });
  return unit.id;
}

/** Reserva source=online criada direto via SQL — o canal público (HOLD +
 *  checkout Shopify) não é o que está sob teste aqui, só o filtro de
 *  listagem por origem/data. Item 2 do pedido do usuário: os testes de
 *  filtro precisam de reservas online DE VERDADE, não só manuais. */
async function createOnlineReservation(opts: { pickup: CivilDate; customerName?: string | null }): Promise<{ reservationId: string; unitId: string }> {
  const unitId = await createUnit();
  const returnDate = addDays(opts.pickup, 2);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservations (id, status, source, origin_store_id, pickup_date, return_date, customer_name)
    VALUES (gen_random_uuid(), 'confirmed', 'online', 'dev-store', ${civilDateToISO(opts.pickup)}::date, ${civilDateToISO(returnDate)}::date, ${opts.customerName ?? null})
    RETURNING id
  `;
  const reservationId = rows[0].id;
  await prisma.$executeRaw`
    INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
    VALUES (gen_random_uuid(), ${reservationId}::uuid, ${unitId}::uuid, 'confirmed',
      daterange(${civilDateToISO(opts.pickup)}::date, ${civilDateToISO(returnDate)}::date, '[)'))
  `;
  return { reservationId, unitId };
}

async function cleanup() {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id FROM reservation_items ri
    JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ru.code LIKE ${PREFIX + '%'}
  `;
  const reservationIds = rows.map((r) => r.id);
  if (reservationIds.length) {
    await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM manual_reservation_idempotency_keys WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${reservationIds}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('AdminReservationsService.listReservations/getReservationDetail (integração real, Neon)', () => {
  test('1) listReservations sem filtro encontra a reserva recém-criada; filtro por unitCode funciona', async () => {
    const unitId = await createUnit();
    const unit = await prisma.rentalUnit.findUniqueOrThrow({ where: { id: unitId } });
    const pickup = pickupWithoutSundayReturn(2, 300);
    const res = await service.createManual({
      customerName: 'Cliente Lista',
      customerPhone: '+56 9 8888 7777',
      items: [{ rentalUnitId: unitId }],
      pickupDate: civilDateToISO(pickup),
    } as CreateManualReservationDto);

    const byUnitCode = await service.listReservations({ unitCode: unit.code });
    expect(byUnitCode.some((r) => r.id === res.reservationId)).toBe(true);

    const bySource = await service.listReservations({ source: 'manual_admin', customer: 'Cliente Lista' });
    expect(bySource.some((r) => r.id === res.reservationId)).toBe(true);
    expect(bySource.find((r) => r.id === res.reservationId)).toMatchObject({ status: 'confirmed', source: 'manual_admin', itemCount: 1 });
  }, 15_000);

  test('2) filtro por status diferente não encontra a reserva confirmed', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 310);
    const res = await service.createManual({
      customerName: 'Cliente Lista 2',
      customerPhone: '+56 9 1111 2222',
      items: [{ rentalUnitId: unitId }],
      pickupDate: civilDateToISO(pickup),
    } as CreateManualReservationDto);

    const wrongStatus = await service.listReservations({ status: 'expired' });
    expect(wrongStatus.some((r) => r.id === res.reservationId)).toBe(false);
  });

  test('3) getReservationDetail traz peças, código físico e eventos', async () => {
    const unitId = await createUnit();
    const unit = await prisma.rentalUnit.findUniqueOrThrow({ where: { id: unitId } });
    const pickup = pickupWithoutSundayReturn(2, 320);
    const res = await service.createManual({
      customerName: 'Cliente Detalhe',
      customerPhone: '+56 9 3333 4444',
      items: [{ rentalUnitId: unitId }],
      pickupDate: civilDateToISO(pickup),
    } as CreateManualReservationDto);

    const detail = await service.getReservationDetail(res.reservationId);
    expect(detail.status).toBe('confirmed');
    expect(detail.source).toBe('manual_admin');
    expect(detail.customerName).toBe('Cliente Detalhe');
    expect(detail.shopifyOrderId).toBeNull(); // reserva manual nunca cria pedido Shopify
    expect(detail.items).toEqual([expect.objectContaining({ rentalUnitId: unitId, code: unit.code, status: 'confirmed' })]);
    expect(detail.events.some((e) => e.type === 'MANUAL_RESERVATION_CREATED')).toBe(true);
  });

  test('4) getReservationDetail de id inexistente → NotFoundException', async () => {
    await expect(service.getReservationDetail('00000000-0000-0000-0000-000000000000')).rejects.toThrow(NotFoundException);
  });

  test('5) getReservationDetail de id malformado → BadRequestException', async () => {
    await expect(service.getReservationDetail('nao-e-um-uuid')).rejects.toThrow(BadRequestException);
  });

  test('6) filtro de origem: "online" só traz reserva online; "manual_admin" só traz manual; sem filtro (todas as origens) traz as duas', async () => {
    const pickup = pickupWithoutSundayReturn(2, 680);
    const manualUnitId = await createUnit();
    const manualUnit = await prisma.rentalUnit.findUniqueOrThrow({ where: { id: manualUnitId } });
    const manual = await service.createManual({
      customerName: 'Cliente Origem Manual',
      customerPhone: '+56 9 4444 5555',
      items: [{ rentalUnitId: manualUnitId }],
      pickupDate: civilDateToISO(pickup),
    } as CreateManualReservationDto);

    const online = await createOnlineReservation({ pickup: addDays(pickup, 1), customerName: 'Cliente Origem Online' });
    const onlineUnit = await prisma.rentalUnit.findUniqueOrThrow({ where: { id: online.unitId } });

    const bothOrigins = await service.listReservations({ from: civilDateToISO(pickup), to: civilDateToISO(addDays(pickup, 1)) });
    const bothIds = bothOrigins.map((r) => r.id);
    expect(bothIds).toEqual(expect.arrayContaining([manual.reservationId, online.reservationId]));

    const onlineOnly = await service.listReservations({ source: 'online', unitCode: onlineUnit.code });
    expect(onlineOnly.map((r) => r.id)).toEqual([online.reservationId]);

    const manualOnly = await service.listReservations({ source: 'manual_admin', unitCode: manualUnit.code });
    expect(manualOnly.map((r) => r.id)).toEqual([manual.reservationId]);

    // origem errada pra uma peça que só existe na outra origem → nada encontrado
    const wrongOrigin = await service.listReservations({ source: 'online', unitCode: manualUnit.code });
    expect(wrongOrigin).toEqual([]);
  }, 20_000);

  test('7) filtro de data de retirada: intervalo inclusivo nos dois extremos; só "from" mostra a partir dela; só "to" mostra até ela', async () => {
    const base = addDays(engineToday(CFG), 700);
    const before = await createOnlineReservation({ pickup: addDays(base, -1) });
    const onStart = await createOnlineReservation({ pickup: base });
    const onEnd = await createOnlineReservation({ pickup: addDays(base, 3) });
    const after = await createOnlineReservation({ pickup: addDays(base, 4) });

    const inRange = await service.listReservations({ from: civilDateToISO(base), to: civilDateToISO(addDays(base, 3)) });
    const inRangeIds = inRange.map((r) => r.id);
    expect(inRangeIds).toEqual(expect.arrayContaining([onStart.reservationId, onEnd.reservationId]));
    expect(inRangeIds).not.toContain(before.reservationId);
    expect(inRangeIds).not.toContain(after.reservationId);

    const fromOnly = await service.listReservations({ from: civilDateToISO(addDays(base, 4)) });
    expect(fromOnly.map((r) => r.id)).toContain(after.reservationId);
    expect(fromOnly.map((r) => r.id)).not.toContain(before.reservationId);
    expect(fromOnly.map((r) => r.id)).not.toContain(onStart.reservationId);

    const toOnly = await service.listReservations({ to: civilDateToISO(addDays(base, -1)) });
    expect(toOnly.map((r) => r.id)).toContain(before.reservationId);
    expect(toOnly.map((r) => r.id)).not.toContain(after.reservationId);
    expect(toOnly.map((r) => r.id)).not.toContain(onStart.reservationId);
  }, 20_000);

  test('8) combinação de origem + intervalo de datas + busca por cliente: só bate quando TODOS os filtros são satisfeitos ao mesmo tempo', async () => {
    const pickup = addDays(engineToday(CFG), 710);
    const target = await createOnlineReservation({ pickup, customerName: 'Fernanda Combinação Teste' });
    const sameWindowDifferentName = await createOnlineReservation({ pickup: addDays(pickup, 1), customerName: 'Outra Pessoa' });

    const combined = await service.listReservations({
      source: 'online',
      from: civilDateToISO(pickup),
      to: civilDateToISO(addDays(pickup, 1)),
      customer: 'Fernanda Combinação',
    });
    expect(combined.map((r) => r.id)).toEqual([target.reservationId]);
    expect(combined.map((r) => r.id)).not.toContain(sameWindowDifferentName.reservationId);
  }, 20_000);

  test('9) filtro sem nenhuma reserva correspondente → lista vazia', async () => {
    const empty = await service.listReservations({ customer: `cliente-inexistente-${PREFIX}` });
    expect(empty).toEqual([]);
  });
});
