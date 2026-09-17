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

let technicalUserId: string;

beforeAll(async () => {
  const user = await prisma.adminUser.create({
    data: { name: `Auditor ${PREFIX}`, phone: `9${Date.now()}3`, pinHash: 'x:y', role: 'ADMIN', active: true },
  });
  adminUserId = user.id;

  const technical = await prisma.adminUser.create({
    data: { name: `Tecnico ${PREFIX}`, phone: `9${Date.now()}4`, pinHash: 'x:y', role: 'ADMIN', active: true, isTechnical: true },
  });
  technicalUserId = technical.id;
});
afterAll(async () => {
  await cleanup();
  await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE admin_user_id = ${technicalUserId}::uuid`;
  await prisma.$executeRaw`DELETE FROM admin_users WHERE id = ${technicalUserId}::uuid`;
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
    const entries = await audit.list({}, 'SUPER_ADMIN');
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

    const entries = await audit.list({}, 'SUPER_ADMIN');
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

    const entries = await audit.list({}, 'SUPER_ADMIN');
    const mine = entries.find((e) => e.entityId === res.reservationId && e.action === 'MANUAL_RESERVATION_CANCELLED');
    expect(mine).toBeDefined();
    expect(mine!.source).toBe('RESERVATION');
  }, 15_000);

  test('4) nenhum segredo (PIN/hash/token/secret) aparece em nenhuma entrada retornada', async () => {
    const entries = await audit.list({ limit: 500 }, 'SUPER_ADMIN');
    const serialized = JSON.stringify(entries).toLowerCase();
    for (const forbidden of ['pinhash', 'pin_hash', 'tokenhash', 'token_hash', 'admin_api_token', 'client_secret', 'storefront_token']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('5) limit é respeitado e limitado ao teto (500)', async () => {
    const entries = await audit.list({ limit: 2 }, 'SUPER_ADMIN');
    expect(entries.length).toBeLessThanOrEqual(2);
    const capped = await audit.list({ limit: 999999 }, 'SUPER_ADMIN');
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

    const afterClear = await audit.list({ limit: 500 }, 'SUPER_ADMIN');
    expect(afterClear.find((e) => e.entityId === 'before-clear')).toBeUndefined();
    expect(afterClear.find((e) => e.action === 'AUDIT_CLEARED')).toBeUndefined();

    await writeAdminAuditEvent(prisma, {
      adminUserId,
      adminUserName: `Auditor ${PREFIX}`,
      action: 'RULE_MODIFIED',
      entityType: 'RentalRuleConfig',
      entityId: 'after-clear',
    });

    const withNewEvent = await audit.list({ limit: 500 }, 'SUPER_ADMIN');
    expect(withNewEvent.find((e) => e.entityId === 'after-clear')).toBeDefined();
  });
});

/**
 * Sistema de autorização de funcionários — "Funcionários não podem
 * visualizar ações do proprietário/técnico" + "Ações críticas ...
 * devem continuar registradas em auditoria privada ... acessível
 * somente ao Anderson/proprietário". Nada é apagado: os mesmos eventos
 * continuam existindo no banco e aparecem pra SUPER_ADMIN — só saem da
 * resposta pra quem não pode ver.
 */
describe('AdminAuditService — visibilidade por papel (integração real, Neon)', () => {
  test('7) evento crítico (ex.: RULE_MODIFIED) some para STAFF/ADMIN, mas continua visível para SUPER_ADMIN', async () => {
    await writeAdminAuditEvent(prisma, {
      adminUserId,
      adminUserName: `Auditor ${PREFIX}`,
      action: 'RULE_MODIFIED',
      entityType: 'RentalRuleConfig',
      entityId: 'critical-visibility',
    });

    const asSuperAdmin = await audit.list({ limit: 500 }, 'SUPER_ADMIN');
    expect(asSuperAdmin.find((e) => e.entityId === 'critical-visibility')).toBeDefined();

    const asAdmin = await audit.list({ limit: 500 }, 'ADMIN');
    expect(asAdmin.find((e) => e.entityId === 'critical-visibility')).toBeUndefined();

    const asStaff = await audit.list({ limit: 500 }, 'STAFF');
    expect(asStaff.find((e) => e.entityId === 'critical-visibility')).toBeUndefined();
  }, 15_000);

  test('8) evento não-crítico (ex.: PICKUP_REMINDER_48H_SENT) continua visível para STAFF/ADMIN', async () => {
    await writeAdminAuditEvent(prisma, {
      adminUserId,
      adminUserName: `Auditor ${PREFIX}`,
      action: 'PICKUP_REMINDER_48H_SENT',
      entityType: 'Reservation',
      entityId: 'non-critical-visibility',
    });

    const asStaff = await audit.list({ limit: 500 }, 'STAFF');
    expect(asStaff.find((e) => e.entityId === 'non-critical-visibility')).toBeDefined();
  });

  test('9) cancelamento manual de reserva (MANUAL_RESERVATION_CANCELLED) é sempre "crítico" — nunca visível a STAFF/ADMIN', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 270);
    const res = await reservationsSvc.createManual({
      customerName: 'Cliente Visibilidade',
      customerPhone: '+56 9 1234 5678',
      items: [{ rentalUnitId: unitId }],
      pickupDate: civilDateToISO(pickup),
    } as CreateManualReservationDto);
    await reservationsSvc.cancelManual(res.reservationId, { adminUserId, adminUserName: `Auditor ${PREFIX}` });

    const asSuperAdmin = await audit.list({ limit: 500 }, 'SUPER_ADMIN');
    expect(asSuperAdmin.find((e) => e.entityId === res.reservationId && e.action === 'MANUAL_RESERVATION_CANCELLED')).toBeDefined();

    const asStaff = await audit.list({ limit: 500 }, 'STAFF');
    expect(asStaff.find((e) => e.entityId === res.reservationId && e.action === 'MANUAL_RESERVATION_CANCELLED')).toBeUndefined();
    // A criação da mesma reserva não é crítica — continua visível.
    expect(asStaff.find((e) => e.entityId === res.reservationId && e.action === 'MANUAL_RESERVATION_CREATED')).toBeDefined();
  }, 15_000);

  test('10) reserva manual criada por perfil técnico some para STAFF/ADMIN, mas continua visível para SUPER_ADMIN', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 280);
    const res = await reservationsSvc.createManual({
      customerName: 'Cliente Tecnico',
      customerPhone: '+56 9 1234 5678',
      items: [{ rentalUnitId: unitId }],
      pickupDate: civilDateToISO(pickup),
      adminUserId: technicalUserId,
      adminUserName: `Tecnico ${PREFIX}`,
    } as CreateManualReservationDto);

    const asSuperAdmin = await audit.list({ limit: 500 }, 'SUPER_ADMIN');
    expect(asSuperAdmin.find((e) => e.entityId === res.reservationId && e.action === 'MANUAL_RESERVATION_CREATED')).toBeDefined();

    const asStaff = await audit.list({ limit: 500 }, 'STAFF');
    expect(asStaff.find((e) => e.entityId === res.reservationId)).toBeUndefined();
  }, 15_000);

  test('11) evento de painel escrito pelo perfil técnico (ex.: EMPLOYEE_CREATED) some para STAFF/ADMIN mesmo sendo o único autor', async () => {
    await writeAdminAuditEvent(prisma, {
      adminUserId: technicalUserId,
      adminUserName: `Tecnico ${PREFIX}`,
      action: 'EMPLOYEE_CREATED',
      entityType: 'AdminUser',
      entityId: 'technical-authored-critical',
    });

    const asSuperAdmin = await audit.list({ limit: 500 }, 'SUPER_ADMIN');
    expect(asSuperAdmin.find((e) => e.entityId === 'technical-authored-critical')).toBeDefined();

    const asAdmin = await audit.list({ limit: 500 }, 'ADMIN');
    expect(asAdmin.find((e) => e.entityId === 'technical-authored-critical')).toBeUndefined();
  });
});
