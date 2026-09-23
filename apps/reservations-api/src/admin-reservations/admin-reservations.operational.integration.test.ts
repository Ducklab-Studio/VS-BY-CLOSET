import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { AdminReservationsService } from './admin-reservations.service';
import { AdminCalendarService } from '../admin-panel/calendar.service';
import { AvailabilityService } from '../availability/availability.service';
import { ReservationPdfService } from '../pdf/reservation-pdf.service';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';
import { addDays, civilDateFromISO, civilDateToISO, isSunday, type CivilDate } from '../rental-rules/civil-date';
import { isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';
// pdf-parse does not publish TypeScript declarations.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (buffer: Buffer) => Promise<{ text: string }>;

// A fixture suite must never touch a hosted database, even when invoked alone.
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;
const prisma = new PrismaService();
const rules = new RentalRuleConfigService(prisma);
const service = new AdminReservationsService(prisma, rules);
const calendar = new AdminCalendarService(prisma);
const availability = new AvailabilityService(prisma, rules);
const pdf = new ReservationPdfService();
const prefix = `OPER-${Date.now()}`;
const storeId = `${prefix}-store`;
const actor = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Operador sintético' };
const ids: string[] = [];
const unitIds: string[] = [];
let pickup: string;
let nextDay: string;
let blockedFrom: string;
let blockedUntil: string;

async function fixture(status: 'confirmed' | 'cancelled' | 'expired' | 'returned' | 'cleaning' | 'hold' | 'picked_up', source: 'manual_admin' | 'online' = 'manual_admin') {
  const code = `${prefix}-${unitIds.length}`;
  const unit = await prisma.rentalUnit.create({ data: { code, name: 'Unidade sintética', shopifyVariantId: code, active: true, reservableOnline: true, countsTowardRentalDuration: true } });
  unitIds.push(unit.id);
  const reservation = await prisma.reservation.create({ data: {
    status, source, originStoreId: storeId, pickupDate: new Date(pickup), returnDate: new Date(nextDay),
    confirmedAt: status === 'confirmed' ? new Date() : null,
  } });
  ids.push(reservation.id);
  const [item] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservation_items (reservation_id, rental_unit_id, blocked_range, status)
    VALUES (${reservation.id}::uuid, ${unit.id}::uuid, daterange(${blockedFrom}::date, ${blockedUntil}::date, '[)'), ${status}::reservation_status)
    RETURNING id
  `;
  return { id: reservation.id, itemId: item.id, unitId: unit.id, code };
}

async function multiItemFixture() {
  const reservation = await prisma.reservation.create({ data: {
    status: 'confirmed', source: 'manual_admin', originStoreId: storeId,
    pickupDate: new Date(pickup), returnDate: new Date(nextDay), confirmedAt: new Date(),
  } });
  ids.push(reservation.id);
  const items: { itemId: string; unitId: string; code: string }[] = [];
  for (const suffix of ['A', 'B']) {
    const code = `${prefix}-multi-${unitIds.length}-${suffix}`;
    const unit = await prisma.rentalUnit.create({ data: { code, name: 'Unidade sintética', shopifyVariantId: code, active: true, reservableOnline: true, countsTowardRentalDuration: true } });
    unitIds.push(unit.id);
    const [item] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO reservation_items (reservation_id, rental_unit_id, blocked_range, status)
      VALUES (${reservation.id}::uuid, ${unit.id}::uuid, daterange(${blockedFrom}::date, ${blockedUntil}::date, '[)'), 'confirmed')
      RETURNING id
    `;
    items.push({ itemId: item.id, unitId: unit.id, code });
  }
  return { id: reservation.id, items };
}

async function itemStatus(itemId: string): Promise<string> {
  const [row] = await prisma.$queryRaw<{ status: string }[]>`SELECT status FROM reservation_items WHERE id = ${itemId}::uuid`;
  return row.status;
}
async function eventCount(id: string, type: string): Promise<number> {
  return prisma.reservationEvent.count({ where: { reservationId: id, type } });
}
async function available(code: string, date = pickup): Promise<number> {
  const result = await availability.getAvailability({ shopifyVariantId: code, countedPieces: 1, from: date, to: date });
  return result.days[0].quantityAvailable;
}
async function calendarContains(id: string): Promise<boolean> {
  return (await calendar.getCalendar(blockedFrom, blockedUntil)).some((item) => item.reservationId === id);
}
async function bookSameUnit(unitId: string): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const reservation = await tx.reservation.create({ data: {
      status: 'confirmed', source: 'manual_admin', originStoreId: storeId,
      pickupDate: new Date(pickup), returnDate: new Date(nextDay),
    } });
    await tx.$executeRaw`INSERT INTO reservation_items (reservation_id, rental_unit_id, blocked_range, status)
      VALUES (${reservation.id}::uuid, ${unitId}::uuid, daterange(${blockedFrom}::date, ${blockedUntil}::date, '[)'), 'confirmed')`;
    return reservation.id;
  });
}

localDescribe('ciclo operacional de reservas (PostgreSQL isolado)', () => {
  beforeAll(async () => {
    if (!localDatabase) throw new Error('Banco local obrigatório');
    const isValidPickup = (d: CivilDate) => isOnlineReservationAllowed(d, DEFAULT_RENTAL_RULE_CONFIG) && !isSunday(d);
    let date = addDays(engineToday(DEFAULT_RENTAL_RULE_CONFIG), 60);
    // O dia seguinte ao blocked_range (pickup+6) também é consultado como retirada: se cair
    // num domingo ou na entressafra, a disponibilidade é 0 pelo calendário, não pela peça.
    while (!isValidPickup(date) || isSunday(addDays(date, 2)) || !isValidPickup(addDays(date, 6))) date = addDays(date, 1);
    pickup = civilDateToISO(date);
    nextDay = civilDateToISO(addDays(date, 2));
    blockedFrom = civilDateToISO(addDays(date, -3));
    blockedUntil = civilDateToISO(addDays(date, 5));
    await prisma.store.create({ data: { id: storeId, shopifyDomain: `${prefix.toLowerCase()}.invalid`, currency: 'BRL' } });
  });

  afterAll(async () => {
    if (!localDatabase) return;
    if (ids.length) {
      await prisma.reservationEvent.deleteMany({ where: { reservationId: { in: ids } } });
      await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${ids}::uuid[])`;
      await prisma.reservation.deleteMany({ where: { id: { in: ids } } });
    }
    if (unitIds.length) await prisma.rentalUnit.deleteMany({ where: { id: { in: unitIds } } });
    await prisma.store.delete({ where: { id: storeId } });
    await prisma.$disconnect();
  });

  test('recebimento e limpeza retêm a peça; só completed libera, calendário e PDF acompanham', async () => {
    const r = await fixture('confirmed');
    expect(await available(r.code)).toBe(0);
    expect(await calendarContains(r.id)).toBe(true);
    await expect(service.advanceOperational(r.id, r.itemId, 'receive', actor)).resolves.toMatchObject({ itemStatus: 'returned' });
    expect(await itemStatus(r.itemId)).toBe('returned');
    expect(await available(r.code)).toBe(0);
    expect(await calendarContains(r.id)).toBe(true);
    const returnedDetail = await service.getReservationDetail(r.id);
    expect(returnedDetail.items[0].returnedAt).not.toBeNull();
    expect((await pdfParse(await pdf.generate(returnedDetail))).text).toContain('Devolvida');
    await expect(service.advanceOperational(r.id, r.itemId, 'receive', actor)).rejects.toMatchObject({ status: 409 });
    await expect(bookSameUnit(r.unitId)).rejects.toBeDefined();

    await service.advanceOperational(r.id, r.itemId, 'start-cleaning', actor);
    expect(await itemStatus(r.itemId)).toBe('cleaning');
    expect(await available(r.code)).toBe(0);
    expect(await calendarContains(r.id)).toBe(true);
    const cleaningDetail = await service.getReservationDetail(r.id);
    expect(cleaningDetail.items[0].cleaningStartedAt).not.toBeNull();
    expect((await pdfParse(await pdf.generate(cleaningDetail))).text).toContain('Em higienização');
    await expect(bookSameUnit(r.unitId)).rejects.toBeDefined();

    await service.advanceOperational(r.id, r.itemId, 'complete-cleaning', actor);
    expect(await itemStatus(r.itemId)).toBe('completed');
    expect(await available(r.code)).toBe(1);
    expect(await calendarContains(r.id)).toBe(false);
    const completedDetail = await service.getReservationDetail(r.id);
    expect(completedDetail.items[0].cleaningCompletedAt).not.toBeNull();
    expect((await pdfParse(await pdf.generate(completedDetail))).text).toContain('Concluída');
    const completedItem = await prisma.reservationItem.findUniqueOrThrow({ where: { id: r.itemId } });
    expect(completedItem.cleaningCompletedBy).toBe(actor.id);
    for (const type of ['RESERVATION_ITEM_RETURNED', 'RESERVATION_ITEM_CLEANING_STARTED', 'RESERVATION_ITEM_CLEANING_COMPLETED']) {
      expect(await eventCount(r.id, type)).toBe(1);
      const event = await prisma.reservationEvent.findFirstOrThrow({ where: { reservationId: r.id, type } });
      expect(event.detail).toMatchObject({ adminUserId: actor.id, reservationItemId: r.itemId, at: expect.any(String) });
    }
    await expect(service.advanceOperational(r.id, r.itemId, 'complete-cleaning', actor)).rejects.toMatchObject({ status: 409 });
    ids.push(await bookSameUnit(r.unitId));
  });

  test('cancelamento é recusado quando uma das peças já foi recebida', async () => {
    const r = await multiItemFixture();
    await service.advanceOperational(r.id, r.items[0].itemId, 'receive', actor);
    await expect(service.cancelManual(r.id, {})).rejects.toMatchObject({ status: 409 });
    expect(await itemStatus(r.items[0].itemId)).toBe('returned');
    expect(await itemStatus(r.items[1].itemId)).toBe('confirmed');
    expect(await eventCount(r.id, 'MANUAL_RESERVATION_CANCELLED')).toBe(0);
  });

  test('reserva com múltiplas peças avança por item e só conclui quando todas completam', async () => {
    const r = await multiItemFixture();
    const first = r.items[0];
    const second = r.items[1];

    await service.advanceOperational(r.id, first.itemId, 'receive', actor);
    expect(await itemStatus(first.itemId)).toBe('returned');
    expect(await itemStatus(second.itemId)).toBe('confirmed');
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('confirmed');
    expect(await available(first.code)).toBe(0);
    expect(await available(second.code)).toBe(0);

    await service.advanceOperational(r.id, first.itemId, 'start-cleaning', actor);
    await service.advanceOperational(r.id, first.itemId, 'complete-cleaning', actor);
    expect(await itemStatus(first.itemId)).toBe('completed');
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('confirmed');
    expect(await available(first.code)).toBe(1);
    expect(await available(second.code)).toBe(0);

    await service.advanceOperational(r.id, second.itemId, 'receive', actor);
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('returned');
    await service.advanceOperational(r.id, second.itemId, 'start-cleaning', actor);
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('cleaning');
    await service.advanceOperational(r.id, second.itemId, 'complete-cleaning', actor);
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('completed');
    expect(await eventCount(r.id, 'RESERVATION_ITEM_CLEANING_COMPLETED')).toBe(2);
  });

  test('peça returned/cleaning segue indisponível depois do blocked_range planejado', async () => {
    const r = await fixture('confirmed');
    const afterPlannedWindow = civilDateToISO(addDays(civilDateFromISO(blockedUntil), 1));

    await service.advanceOperational(r.id, r.itemId, 'receive', actor);
    expect(await available(r.code, afterPlannedWindow)).toBe(0);
    await service.advanceOperational(r.id, r.itemId, 'start-cleaning', actor);
    expect(await available(r.code, afterPlannedWindow)).toBe(0);
    await service.advanceOperational(r.id, r.itemId, 'complete-cleaning', actor);
    expect(await available(r.code, afterPlannedWindow)).toBe(1);
  });

  test.each(['cancelled', 'expired', 'returned', 'cleaning', 'hold'] as const)('não recebe reserva %s', async (status) => {
    const r = await fixture(status);
    await expect(service.advanceOperational(r.id, r.itemId, 'receive', actor)).rejects.toMatchObject({ status: 409 });
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(status);
    expect(await eventCount(r.id, 'RESERVATION_ITEM_RETURNED')).toBe(0);
  });

  test('reserva online confirmada pode ser recebida sem alterar pedido ou pagamento', async () => {
    const r = await fixture('confirmed', 'online');
    await expect(service.advanceOperational(r.id, r.itemId, 'receive', actor)).resolves.toMatchObject({ itemStatus: 'returned' });
    const row = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.shopifyOrderId).toBeNull();
    expect(row.checkoutState).toBe('none');
  });

  test.each(['cancelled', 'expired', 'returned', 'cleaning', 'hold'] as const)('cancelamento de %s é rejeitado sem liberar peça', async (status) => {
    const r = await fixture(status);
    if (status === 'cancelled') expect((await service.cancelManual(r.id, {})).status).toBe('cancelled');
    else await expect(service.cancelManual(r.id, {})).rejects.toMatchObject({ status: 409 });
    expect(await itemStatus(r.itemId)).toBe(status);
    expect(await eventCount(r.id, 'MANUAL_RESERVATION_CANCELLED')).toBe(0);
  });

  test('cancelamento manual confirmado é idempotente e libera somente sua unidade', async () => {
    const r = await fixture('confirmed');
    const other = await fixture('confirmed');
    await service.cancelManual(r.id, { adminUserId: actor.id, adminUserName: actor.name });
    await service.cancelManual(r.id, { adminUserId: actor.id, adminUserName: actor.name });
    expect(await eventCount(r.id, 'MANUAL_RESERVATION_CANCELLED')).toBe(1);
    expect(await itemStatus(r.itemId)).toBe('cancelled');
    expect(await available(r.code)).toBe(1);
    expect(await available(other.code)).toBe(0);
    expect(await calendarContains(other.id)).toBe(true);
  });

  test('cancelamento online é rejeitado', async () => {
    const r = await fixture('confirmed', 'online');
    await expect(service.cancelManual(r.id, {})).rejects.toMatchObject({ status: 409 });
    expect(await itemStatus(r.itemId)).toBe('confirmed');
  });

  test('duas devoluções concorrentes geram um evento e um conflito', async () => {
    const r = await fixture('confirmed');
    const outcomes = await Promise.allSettled([service.advanceOperational(r.id, r.itemId, 'receive', actor), service.advanceOperational(r.id, r.itemId, 'receive', actor)]);
    expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect(await eventCount(r.id, 'RESERVATION_ITEM_RETURNED')).toBe(1);
    expect(await itemStatus(r.itemId)).toBe('returned');
  });

  test('cancelamento e devolução concorrentes nunca liberam recebimento pendente', async () => {
    const r = await fixture('confirmed');
    const outcomes = await Promise.allSettled([service.advanceOperational(r.id, r.itemId, 'receive', actor), service.cancelManual(r.id, {})]);
    expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const row = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } });
    expect(['returned', 'cancelled']).toContain(row.status);
    expect(await available(r.code)).toBe(row.status === 'cancelled' ? 1 : 0);
    expect(await eventCount(r.id, 'RESERVATION_ITEM_RETURNED') + await eventCount(r.id, 'MANUAL_RESERVATION_CANCELLED')).toBe(1);
    const item = await prisma.reservationItem.findUniqueOrThrow({ where: { id: r.itemId } });
    expect(row.status === 'cancelled' && item.returnedAt !== null).toBe(false);
  });
});
