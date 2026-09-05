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
});
