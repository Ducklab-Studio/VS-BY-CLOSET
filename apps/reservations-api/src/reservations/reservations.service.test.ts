import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { ReservationsService } from './reservations.service';
import { HoldsService } from '../holds/holds.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { type CivilDate, addDays, civilDateToISO, isSunday } from '../rental-rules/civil-date';
import { calculateReturnDate, isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';

/**
 * Item 18/19 da Fase 7 — GET /reservations/:id/status. Prova de posse
 * igual a Fase 6 (reservationId + holdToken), nunca reservationId
 * sozinho (item 23-25).
 */
const prisma = new PrismaService();
const rentalRuleConfig = new RentalRuleConfigService(prisma);
const holdsService = new HoldsService(prisma, rentalRuleConfig);
const service = new ReservationsService(prisma);

const CFG = DEFAULT_RENTAL_RULE_CONFIG;
const PREFIX = `RSTATUS-${Date.now()}`;

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

async function cleanup() {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id FROM reservation_items ri
    JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ru.code LIKE ${PREFIX + '%'}
  `;
  const reservationIds = rows.map((r) => r.id);
  if (reservationIds.length) {
    await prisma.$executeRaw`DELETE FROM hold_idempotency_keys WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
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

describe('ReservationsService.getStatus', () => {
  test('23) token correto → devolve status real', async () => {
    const variantId = `${PREFIX}-v1`;
    await prisma.rentalUnit.create({ data: { code: `${variantId}-u`, name: 'x', shopifyVariantId: variantId, active: true, reservableOnline: true, countsTowardRentalDuration: true } });
    const pickup = pickupWithoutSundayReturn(2, 20);
    const hold = await holdsService.createHold({ items: [{ shopifyVariantId: variantId, quantity: 1 }], pickupDate: civilDateToISO(pickup), termsAccepted: true });

    const status = await service.getStatus(hold.reservationId, hold.holdToken!);
    expect(status.status).toBe('hold');
    expect(status.pickupDate).toBe(civilDateToISO(pickup));
    expect(status.effectiveReturnDate).not.toBeNull();
  });

  test('24) token errado → 403', async () => {
    const variantId = `${PREFIX}-v2`;
    await prisma.rentalUnit.create({ data: { code: `${variantId}-u`, name: 'x', shopifyVariantId: variantId, active: true, reservableOnline: true, countsTowardRentalDuration: true } });
    const pickup = pickupWithoutSundayReturn(2, 21);
    const hold = await holdsService.createHold({ items: [{ shopifyVariantId: variantId, quantity: 1 }], pickupDate: civilDateToISO(pickup), termsAccepted: true });

    await expect(service.getStatus(hold.reservationId, 'x'.repeat(40))).rejects.toMatchObject({ status: 403 });
  });

  test('25) sem token → 403 (nunca aceita reservationId sozinho como prova de posse)', async () => {
    const variantId = `${PREFIX}-v3`;
    await prisma.rentalUnit.create({ data: { code: `${variantId}-u`, name: 'x', shopifyVariantId: variantId, active: true, reservableOnline: true, countsTowardRentalDuration: true } });
    const pickup = pickupWithoutSundayReturn(2, 22);
    const hold = await holdsService.createHold({ items: [{ shopifyVariantId: variantId, quantity: 1 }], pickupDate: civilDateToISO(pickup), termsAccepted: true });

    await expect(service.getStatus(hold.reservationId, undefined)).rejects.toMatchObject({ status: 403 });
  });

  test('reservation inexistente → 404', async () => {
    await expect(service.getStatus('00000000-0000-0000-0000-000000000000', 'x'.repeat(40))).rejects.toMatchObject({ status: 404 });
  });

  test('id malformado (não-UUID) → 404, não erro de banco', async () => {
    await expect(service.getStatus('not-a-uuid', 'x'.repeat(40))).rejects.toMatchObject({ status: 404 });
  });
});
