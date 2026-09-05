import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { AdminReservationsService } from '../admin-reservations/admin-reservations.service';
import { type CivilDate, addDays, civilDateToISO, isSunday } from '../rental-rules/civil-date';
import { calculateReturnDate, isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';
import type { CreateManualReservationDto } from '../admin-reservations/dto/create-manual-reservation.dto';
import { AdminCalendarService } from './calendar.service';

/**
 * Fase 9, item 5 — /closetadmin/calendario. "ZERO MOCKS": os fixtures
 * são reservas MANUAIS reais criadas pelo mesmo `AdminReservationsService`
 * já testado na Fase 8 (não uma linha inserida à mão pulando o motor de
 * regras/trigger de `blocked_range`) — mesmo padrão de
 * admin-reservations.service.test.ts.
 */
const prisma = new PrismaService();
const rentalRuleConfig = new RentalRuleConfigService(prisma);
const reservations = new AdminReservationsService(prisma, rentalRuleConfig);
const calendar = new AdminCalendarService(prisma);

const CFG = DEFAULT_RENTAL_RULE_CONFIG;
const PREFIX = `admin-calendar-test-${Date.now()}`;
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

function baseDto(overrides: Partial<CreateManualReservationDto> & { items: { rentalUnitId: string }[]; pickupDate: string }): CreateManualReservationDto {
  return { customerName: 'Cliente Calendário', customerPhone: '+56 9 1234 5678', ...overrides } as CreateManualReservationDto;
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

describe('AdminCalendarService — /closetadmin/calendario (integração real, Neon, zero mocks)', () => {
  test('1) reserva confirmada aparece no calendário dentro do intervalo pedido, com código físico e datas corretas', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 20);
    const returnDate = addDays(pickup, 2);
    const res = await reservations.createManual(baseDto({ items: [{ rentalUnitId: unitId }], pickupDate: civilDateToISO(pickup) }));

    const from = civilDateToISO(addDays(pickup, -5));
    const to = civilDateToISO(addDays(returnDate, 5));
    const items = await calendar.getCalendar(from, to);
    const mine = items.filter((i) => i.reservationId === res.reservationId);

    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      status: 'confirmed',
      source: 'manual_admin',
      customerName: 'Cliente Calendário',
      rentalUnitId: unitId,
      pickupDate: civilDateToISO(pickup),
      effectiveReturnDate: civilDateToISO(returnDate),
    });
  }, 20_000);

  test('2) reserva fora do intervalo pedido NÃO aparece (consulta escopada, nunca a tabela inteira)', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 40);
    const res = await reservations.createManual(baseDto({ items: [{ rentalUnitId: unitId }], pickupDate: civilDateToISO(pickup) }));

    const farFrom = civilDateToISO(addDays(pickup, -400));
    const farTo = civilDateToISO(addDays(pickup, -390));
    const items = await calendar.getCalendar(farFrom, farTo);
    expect(items.some((i) => i.reservationId === res.reservationId)).toBe(false);
  });

  test('3) reserva cancelada não ocupa mais o calendário', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 60);
    const returnDate = addDays(pickup, 2);
    const res = await reservations.createManual(baseDto({ items: [{ rentalUnitId: unitId }], pickupDate: civilDateToISO(pickup) }));
    await reservations.cancelManual(res.reservationId, {});

    const items = await calendar.getCalendar(civilDateToISO(addDays(pickup, -5)), civilDateToISO(addDays(returnDate, 5)));
    expect(items.some((i) => i.reservationId === res.reservationId)).toBe(false);
  });

  test('4) "to" anterior a "from" → BadRequestException', async () => {
    await expect(calendar.getCalendar('2026-06-10', '2026-06-01')).rejects.toThrow(BadRequestException);
  });

  test('5) intervalo maior que o máximo permitido → BadRequestException', async () => {
    await expect(calendar.getCalendar('2026-01-01', '2026-12-31')).rejects.toThrow('excede o máximo');
  });
});
