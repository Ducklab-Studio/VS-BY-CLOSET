import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { AdminReservationsService } from '../admin-reservations/admin-reservations.service';
import { type CivilDate, addDays, civilDateToISO, isSunday } from '../rental-rules/civil-date';
import { calculateReturnDate, isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';
import type { CreateManualReservationDto } from '../admin-reservations/dto/create-manual-reservation.dto';
import { AdminAuditService } from './audit.service';

const prisma = new PrismaService();
const rentalRuleConfig = new RentalRuleConfigService(prisma);
const reservationsSvc = new AdminReservationsService(prisma, rentalRuleConfig);
const audit = new AdminAuditService(prisma);

const CFG = DEFAULT_RENTAL_RULE_CONFIG;
const PREFIX = `admin-audit-test-${Date.now()}`;
let unitCounter = 0;
let adminUserId: string;

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
  if (adminUserId) {
    await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE admin_user_id = ${adminUserId}::uuid`;
    await prisma.$executeRaw`DELETE FROM admin_users WHERE id = ${adminUserId}::uuid`;
  }
}

beforeAll(async () => {
  const user = await prisma.adminUser.create({
    data: { name: `Auditor ${PREFIX}`, phone: `9${Date.now()}3`, pinHash: 'x:y', role: 'ADMIN', active: true },
  });
  adminUserId = user.id;
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('AdminAuditService — /closetadmin/auditoria (integração real, Neon)', () => {
  test('1) evento de painel (ex.: RULE_MODIFIED) aparece na listagem, fonte PANEL', async () => {
    await writeAdminAuditEvent(prisma, {
      adminUserId,
      adminUserName: `Auditor ${PREFIX}`,
      action: 'RULE_MODIFIED',
      entityType: 'RentalRuleConfig',
      entityId: 'default',
      before: { maxPieces: 6 },
      after: { maxPieces: 6 },
    });
    const entries = await audit.list({});
    const mine = entries.find((e) => e.adminUserId === adminUserId && e.action === 'RULE_MODIFIED');
    expect(mine).toBeDefined();
    expect(mine!.source).toBe('PANEL');
  }, 15_000);

  test('2) reserva manual criada aparece na listagem, fonte RESERVATION, com o adminUserId de quem criou', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 250);
    const res = await reservationsSvc.createManual({
      customerName: 'Cliente Auditoria',
      customerPhone: '+56 9 1234 5678',
      items: [{ rentalUnitId: unitId }],
      pickupDate: civilDateToISO(pickup),
      adminUserId,
      adminUserName: `Auditor ${PREFIX}`,
    } as CreateManualReservationDto);

    const entries = await audit.list({});
    const mine = entries.find((e) => e.entityId === res.reservationId && e.action === 'MANUAL_RESERVATION_CREATED');
    expect(mine).toBeDefined();
    expect(mine!.source).toBe('RESERVATION');
    expect(mine!.adminUserId).toBe(adminUserId);
  });

  test('3) reserva manual cancelada aparece como MANUAL_RESERVATION_CANCELLED', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 260);
    const res = await reservationsSvc.createManual({
      customerName: 'Cliente Auditoria 2',
      customerPhone: '+56 9 1234 5678',
      items: [{ rentalUnitId: unitId }],
      pickupDate: civilDateToISO(pickup),
    } as CreateManualReservationDto);
    await reservationsSvc.cancelManual(res.reservationId, { adminUserId, adminUserName: `Auditor ${PREFIX}` });

    const entries = await audit.list({});
    const mine = entries.find((e) => e.entityId === res.reservationId && e.action === 'MANUAL_RESERVATION_CANCELLED');
    expect(mine).toBeDefined();
    expect(mine!.source).toBe('RESERVATION');
  }, 15_000);

  test('4) nenhum segredo (PIN/hash/token/secret) aparece em nenhuma entrada retornada', async () => {
    const entries = await audit.list({ limit: 500 });
    const serialized = JSON.stringify(entries).toLowerCase();
    for (const forbidden of ['pinhash', 'pin_hash', 'tokenhash', 'token_hash', 'admin_api_token', 'client_secret', 'storefront_token']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('5) limit é respeitado e limitado ao teto (500)', async () => {
    const entries = await audit.list({ limit: 2 });
    expect(entries.length).toBeLessThanOrEqual(2);
    const capped = await audit.list({ limit: 999999 });
    expect(capped.length).toBeLessThanOrEqual(500);
  });

  test('6) limpar auditoria oculta eventos antigos sem apagar o histórico e novos eventos voltam a aparecer', async () => {
    await writeAdminAuditEvent(prisma, {
      adminUserId,
      adminUserName: `Auditor ${PREFIX}`,
      action: 'RULE_MODIFIED',
      entityType: 'RentalRuleConfig',
      entityId: 'before-clear',
    });

    await audit.clear(adminUserId, `Auditor ${PREFIX}`);

    const afterClear = await audit.list({ limit: 500 });
    expect(afterClear.find((e) => e.entityId === 'before-clear')).toBeUndefined();
    expect(afterClear.find((e) => e.action === 'AUDIT_CLEARED')).toBeUndefined();

    await writeAdminAuditEvent(prisma, {
      adminUserId,
      adminUserName: `Auditor ${PREFIX}`,
      action: 'RULE_MODIFIED',
      entityType: 'RentalRuleConfig',
      entityId: 'after-clear',
    });

    const withNewEvent = await audit.list({ limit: 500 });
    expect(withNewEvent.find((e) => e.entityId === 'after-clear')).toBeDefined();
  });
});
