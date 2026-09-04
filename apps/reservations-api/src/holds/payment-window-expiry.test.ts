import { afterAll, beforeAll, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { HoldsService } from './holds.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { type CivilDate, addDays, civilDateToISO, isSunday } from '../rental-rules/civil-date';
import { calculateReturnDate, isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';

/**
 * Item 13/27 da Fase 7 — "antes de criar novo HOLD para a mesma
 * capacidade, reservas pending_payment vencidas precisam poder ser
 * tratadas corretamente" e "nunca delete". Prova real: uma reserva
 * pending_payment com paymentExpiresAt no passado não pode continuar
 * bloqueando a unidade pra sempre — e a linha continua no banco (pra um
 * pagamento tardio ainda achar).
 */
const prisma = new PrismaService();
const rentalRuleConfig = new RentalRuleConfigService(prisma);
const service = new HoldsService(prisma, rentalRuleConfig);

const CFG = DEFAULT_RENTAL_RULE_CONFIG;
const PREFIX = `PWEXP-${Date.now()}`;

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

test('27) pending_payment vencido (payment_expires_at no passado) → unidade liberada, reserva vira expired (nunca deletada)', async () => {
  const variantId = `${PREFIX}-v1`;
  const unit = await prisma.rentalUnit.create({
    data: { code: `${variantId}-u`, name: 'x', shopifyVariantId: variantId, active: true, reservableOnline: true, countsTowardRentalDuration: true },
  });
  const pickup = pickupWithoutSundayReturn(2, 30);

  // Simula uma reserva que já passou por HOLD → checkout → pending_payment,
  // mas cuja janela de pagamento já venceu.
  const [{ id: reservationId }] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservations (id, status, origin_store_id, pickup_date, return_date, expires_at, payment_expires_at, terms_accepted_at, terms_version)
    VALUES (gen_random_uuid(), 'pending_payment', 'dev-store', ${civilDateToISO(pickup)}::date, ${civilDateToISO(calculateReturnDate(pickup, 2))}::date,
      now() - interval '1 hour', now() - interval '1 minute', now(), 'test')
    RETURNING id
  `;
  await prisma.$executeRaw`
    INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
    VALUES (gen_random_uuid(), ${reservationId}::uuid, ${unit.id}::uuid, 'pending_payment',
      daterange(${civilDateToISO(addDays(pickup, -3))}::date, ${civilDateToISO(addDays(calculateReturnDate(pickup, 2), 3))}::date, '[)'))
  `;

  // Novo HOLD pedindo a MESMA unidade só pode funcionar se a reserva
  // pending_payment vencida for tratada como não-ocupante.
  const newHold = await service.createHold({ items: [{ shopifyVariantId: variantId, quantity: 1 }], pickupDate: civilDateToISO(pickup), termsAccepted: true });
  expect(newHold.reservationId).not.toBe(reservationId);

  const old = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
  expect(old.status).toBe('expired'); // nunca deletada — item 13
}, 20_000);
