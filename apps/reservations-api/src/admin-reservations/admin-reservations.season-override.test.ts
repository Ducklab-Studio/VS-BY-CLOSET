import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { AdminReservationsService } from './admin-reservations.service';
import { addDays, civilDateToISO, isSunday, type CivilDate } from '../rental-rules/civil-date';
import { calculateReturnDate, isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';

const prisma = new PrismaService();
const rentalRuleConfig = new RentalRuleConfigService(prisma);
const service = new AdminReservationsService(prisma, rentalRuleConfig);
const PREFIX = `SEASON-OVERRIDE-${Date.now()}`;

let unitId: string;
let adminId: string;
let staffId: string;
let blockedPickup: CivilDate;

beforeAll(async () => {
  // Início da operação no futuro, definido por este teste (a linha de base da
  // suíte é "sem data"); restaurado no afterAll.
  const base = await rentalRuleConfig.load();
  let start = addDays(engineToday(base), base.minAdvanceDays + 60);
  while (isSunday(start)) start = addDays(start, 1);
  await prisma.rentalRuleConfig.update({ where: { id: 'default' }, data: { operationStartDate: new Date(civilDateToISO(start)) } });
  blockedPickup = findBlockedPickup(await rentalRuleConfig.load());

  const unit = await prisma.rentalUnit.create({
    data: {
      code: `${PREFIX}-UNIT`,
      name: 'Peça teste override início da operação',
      shopifyVariantId: `${PREFIX}-VARIANT`,
      active: true,
      reservableOnline: true,
      countsTowardRentalDuration: true,
    },
  });
  unitId = unit.id;

  const admin = await prisma.adminUser.create({
    data: {
      name: `${PREFIX}-ADMIN`,
      phone: `season-admin-${Date.now()}`,
      pinHash: 'test-only-hash',
      role: 'ADMIN',
      active: true,
    },
  });
  adminId = admin.id;

  const staff = await prisma.adminUser.create({
    data: {
      name: `${PREFIX}-STAFF`,
      phone: `season-staff-${Date.now()}`,
      pinHash: 'test-only-hash',
      role: 'STAFF',
      active: true,
    },
  });
  staffId = staff.id;
});

afterAll(async () => {
  await prisma.rentalRuleConfig.update({ where: { id: 'default' }, data: { operationStartDate: null } });
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id
    FROM reservation_items ri
    JOIN rental_units ru ON ru.id = ri.rental_unit_id
    WHERE ru.code LIKE ${PREFIX + '%'}
  `;
  const reservationIds = rows.map((row) => row.id);
  if (reservationIds.length > 0) {
    await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM manual_reservation_idempotency_keys WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${reservationIds}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
  await prisma.$executeRaw`DELETE FROM admin_users WHERE name LIKE ${PREFIX + '%'}`;
  await prisma.$disconnect();
});

describe('AdminReservationsService — exceção manual antes do início da operação', () => {
  test('sem override continua bloqueado antes do início da operação', async () => {
    await expect(
      service.createManual({
        adminUserId: adminId,
        adminUserName: `${PREFIX}-ADMIN`,
        customerName: 'Cliente Teste',
        customerPhone: '+56 9 1111 1111',
        pickupDate: civilDateToISO(blockedPickup),
        items: [{ rentalUnitId: unitId }],
      }),
    ).rejects.toMatchObject({
      status: 422,
      response: { violations: expect.arrayContaining(['pickup_before_operation_start']) },
    });
  });

  test('STAFF não pode usar outsideOnlineSeason mesmo enviando motivo', async () => {
    await expect(
      service.createManual({
        adminUserId: staffId,
        adminUserName: `${PREFIX}-STAFF`,
        customerName: 'Cliente Teste',
        customerPhone: '+56 9 2222 2222',
        pickupDate: civilDateToISO(blockedPickup),
        items: [{ rentalUnitId: unitId }],
        overrides: { outsideOnlineSeason: true },
        overrideReason: 'Atendimento presencial autorizado pela gerência.',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  test('ADMIN ativo pode criar reserva manual antes do início com motivo obrigatório', async () => {
    const result = await service.createManual({
      adminUserId: adminId,
      adminUserName: `${PREFIX}-ADMIN`,
      customerName: 'Cliente Teste',
      customerPhone: '+56 9 3333 3333',
      pickupDate: civilDateToISO(blockedPickup),
      items: [{ rentalUnitId: unitId }],
      overrides: { outsideOnlineSeason: true },
      overrideReason: 'Atendimento presencial autorizado pela gerência.',
    });

    expect(result.status).toBe('confirmed');
    expect(result.source).toBe('manual_admin');
    expect(result.overridesApplied).toContain('outsideOnlineSeason');

    const event = await prisma.reservationEvent.findFirstOrThrow({
      where: { reservationId: result.reservationId, type: 'MANUAL_RESERVATION_CREATED' },
    });
    expect(event.detail).toMatchObject({
      overridesApplied: expect.arrayContaining(['outsideOnlineSeason']),
      overrideReason: 'Atendimento presencial autorizado pela gerência.',
      adminUserId: adminId,
    });
  });
});

function findBlockedPickup(config: Awaited<ReturnType<RentalRuleConfigService['load']>>): CivilDate {
  let candidate = addDays(engineToday(config), config.minAdvanceDays + 2);
  for (let i = 0; i < 500; i++) {
    const calculatedReturn = calculateReturnDate(candidate, 2);
    if (!isOnlineReservationAllowed(candidate, config) && !isSunday(candidate) && !isSunday(calculatedReturn)) {
      return candidate;
    }
    candidate = addDays(candidate, 1);
  }
  throw new Error('Não foi encontrada uma data anterior ao início da operação adequada para o teste.');
}
