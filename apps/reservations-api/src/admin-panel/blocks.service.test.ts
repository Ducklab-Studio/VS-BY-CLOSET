import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { AdminReservationsService } from '../admin-reservations/admin-reservations.service';
import { type CivilDate, addDays, civilDateToISO, isSunday } from '../rental-rules/civil-date';
import { calculateReturnDate, isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';
import type { CreateManualReservationDto } from '../admin-reservations/dto/create-manual-reservation.dto';
import { AdminBlocksService } from './blocks.service';

/**
 * Fase 9, item 13 — bloqueios operacionais. Além de CRUD, cobre a
 * exigência central do item: "Bloqueio deve afetar o BACKEND... Nunca
 * fazer bloqueio somente visual" — provado aqui recriando o caminho real
 * (`AdminReservationsService.createManual`), não inspecionando código.
 */
const prisma = new PrismaService();
const rentalRuleConfig = new RentalRuleConfigService(prisma);
const reservations = new AdminReservationsService(prisma, rentalRuleConfig);
const blocks = new AdminBlocksService(prisma);

const CFG = DEFAULT_RENTAL_RULE_CONFIG;
const PREFIX = `admin-blocks-test-${Date.now()}`;
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

function baseDto(overrides: Partial<CreateManualReservationDto> & { items: { rentalUnitId: string }[]; pickupDate: string }): CreateManualReservationDto {
  return { customerName: 'Cliente Bloqueio', customerPhone: '+56 9 1234 5678', ...overrides } as CreateManualReservationDto;
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
  await prisma.$executeRaw`DELETE FROM operational_blocks WHERE created_by_admin_user_id = ${adminUserId}::uuid`;
  await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE admin_user_id = ${adminUserId}::uuid`;
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
}

beforeAll(async () => {
  const user = await prisma.adminUser.create({
    data: { name: 'Admin Bloqueios Teste', phone: `9${Date.now()}2`, pinHash: 'x:y', role: 'ADMIN', active: true },
  });
  adminUserId = user.id;
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  await prisma.$executeRaw`DELETE FROM admin_users WHERE id = ${adminUserId}::uuid`;
  await prisma.$disconnect();
});

describe('AdminBlocksService — CRUD (integração real, Neon)', () => {
  test('1) cria bloqueio STORE_WIDE e aparece em list()', async () => {
    const pickup = pickupWithoutSundayReturn(2, 100);
    const block = await blocks.create(
      { scope: 'STORE_WIDE', startDate: civilDateToISO(pickup), endDate: civilDateToISO(addDays(pickup, 2)), reason: 'Evento especial' } as never,
      adminUserId,
      'Admin Bloqueios Teste',
    );
    const all = await blocks.list(true);
    expect(all.some((b) => b.id === block.id)).toBe(true);

    const event = await prisma.adminAuditEvent.findFirst({ where: { entityId: block.id, action: 'BLOCK_CREATED' } });
    expect(event).not.toBeNull();
  }, 15_000);

  test('2) UNIT sem rentalUnitId → BadRequestException', async () => {
    await expect(
      blocks.create({ scope: 'UNIT', startDate: '2026-11-01', endDate: '2026-11-02', reason: 'x' } as never, adminUserId, 'Admin'),
    ).rejects.toThrow(BadRequestException);
  });

  test('3) STORE_WIDE com rentalUnitId → BadRequestException', async () => {
    const unitId = await createUnit();
    await expect(
      blocks.create({ scope: 'STORE_WIDE', rentalUnitId: unitId, startDate: '2026-11-01', endDate: '2026-11-02', reason: 'x' } as never, adminUserId, 'Admin'),
    ).rejects.toThrow(BadRequestException);
  });

  test('4) endDate antes de startDate → BadRequestException', async () => {
    await expect(
      blocks.create({ scope: 'STORE_WIDE', startDate: '2026-11-10', endDate: '2026-11-01', reason: 'x' } as never, adminUserId, 'Admin'),
    ).rejects.toThrow(BadRequestException);
  });

  test('5) UNIT com rentalUnitId inexistente → NotFoundException', async () => {
    await expect(
      blocks.create(
        { scope: 'UNIT', rentalUnitId: '00000000-0000-0000-0000-000000000000', startDate: '2026-11-01', endDate: '2026-11-02', reason: 'x' } as never,
        adminUserId,
        'Admin',
      ),
    ).rejects.toThrow(NotFoundException);
  });

  test('6) remove() levanta o bloqueio, some de list(activeOnly=true) mas continua em list(false)', async () => {
    const block = await blocks.create({ scope: 'STORE_WIDE', startDate: '2026-11-05', endDate: '2026-11-06', reason: 'temp' } as never, adminUserId, 'Admin');
    const removed = await blocks.remove(block.id, adminUserId, 'Admin Bloqueios Teste');
    expect(removed.removedAt).not.toBeNull();

    const activeOnly = await blocks.list(true);
    expect(activeOnly.some((b) => b.id === block.id)).toBe(false);
    const all = await blocks.list(false);
    expect(all.some((b) => b.id === block.id)).toBe(true);

    const event = await prisma.adminAuditEvent.findFirst({ where: { entityId: block.id, action: 'BLOCK_REMOVED' } });
    expect(event).not.toBeNull();
  });

  test('7) remove() de bloqueio já removido → ConflictException', async () => {
    const block = await blocks.create({ scope: 'STORE_WIDE', startDate: '2026-11-07', endDate: '2026-11-08', reason: 'temp2' } as never, adminUserId, 'Admin');
    await blocks.remove(block.id, adminUserId, 'Admin');
    await expect(blocks.remove(block.id, adminUserId, 'Admin')).rejects.toThrow(ConflictException);
  });

  test('8) remove() de bloqueio inexistente → NotFoundException', async () => {
    await expect(blocks.remove('00000000-0000-0000-0000-000000000000', adminUserId, 'Admin')).rejects.toThrow(NotFoundException);
  });
});

describe('AdminBlocksService — efeito real no backend (item 13: nunca só visual)', () => {
  test('9) bloqueio STORE_WIDE ativo → reserva manual nesse período é REJEITADA (nunca aplicável override)', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 120);
    const block = await blocks.create(
      { scope: 'STORE_WIDE', startDate: civilDateToISO(pickup), endDate: civilDateToISO(addDays(pickup, 3)), reason: 'Loja fechada (manutenção)' } as never,
      adminUserId,
      'Admin',
    );
    try {
      await expect(reservations.createManual(baseDto({ items: [{ rentalUnitId: unitId }], pickupDate: civilDateToISO(pickup) }))).rejects.toMatchObject({
        status: 409,
      });
    } finally {
      await blocks.remove(block.id, adminUserId, 'Admin');
    }
  }, 15_000);

  test('10) bloqueio de UNIT específica não afeta outras peças no mesmo período', async () => {
    const blockedUnitId = await createUnit();
    const freeUnitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 140);
    const block = await blocks.create(
      {
        scope: 'UNIT',
        rentalUnitId: blockedUnitId,
        startDate: civilDateToISO(pickup),
        endDate: civilDateToISO(addDays(pickup, 3)),
        reason: 'Peça fora de operação (manutenção)',
      } as never,
      adminUserId,
      'Admin',
    );
    try {
      await expect(
        reservations.createManual(baseDto({ items: [{ rentalUnitId: blockedUnitId }], pickupDate: civilDateToISO(pickup) })),
      ).rejects.toMatchObject({ status: 409 });

      const ok = await reservations.createManual(baseDto({ items: [{ rentalUnitId: freeUnitId }], pickupDate: civilDateToISO(pickup) }));
      expect(ok.status).toBe('confirmed');
    } finally {
      await blocks.remove(block.id, adminUserId, 'Admin');
    }
  }, 15_000);

  test('11) fora do período bloqueado, a mesma peça volta a ser reservável normalmente', async () => {
    const unitId = await createUnit();
    const blockedPickup = pickupWithoutSundayReturn(2, 160);
    const block = await blocks.create(
      {
        scope: 'UNIT',
        rentalUnitId: unitId,
        startDate: civilDateToISO(blockedPickup),
        endDate: civilDateToISO(addDays(blockedPickup, 3)),
        reason: 'Manutenção pontual',
      } as never,
      adminUserId,
      'Admin',
    );
    try {
      const laterPickup = pickupWithoutSundayReturn(2, 200);
      const ok = await reservations.createManual(baseDto({ items: [{ rentalUnitId: unitId }], pickupDate: civilDateToISO(laterPickup) }));
      expect(ok.status).toBe('confirmed');
    } finally {
      await blocks.remove(block.id, adminUserId, 'Admin');
    }
  }, 15_000);
});
