import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminPiecesService } from './pieces.service';
import { ensureStoreConfig, resolveStoreConfig } from '../holds/store-config';

/**
 * Fase 9, item 11 — /closetadmin/pecas. Confirma que só os campos
 * OPERACIONAIS são editáveis (nome/preço/foto/descrição continuam do
 * Shopify, nunca tocados aqui) e que a auditoria distingue
 * ativação/desativação de uma atualização genérica.
 */
const prisma = new PrismaService();
const pieces = new AdminPiecesService(prisma);

const PREFIX = `admin-pieces-test-${Date.now()}`;
let unitCounter = 0;
let adminUserId: string;

async function createUnit(opts: { active?: boolean; reservableOnline?: boolean; countsTowardRentalDuration?: boolean } = {}) {
  const code = `${PREFIX}-u${unitCounter++}`;
  return prisma.rentalUnit.create({
    data: {
      code,
      name: 'peça de teste',
      shopifyProductId: `${code}-product`,
      shopifyVariantId: `${code}-variant`,
      shopifySku: `${code}-sku`,
      active: opts.active ?? true,
      reservableOnline: opts.reservableOnline ?? true,
      countsTowardRentalDuration: opts.countsTowardRentalDuration ?? true,
    },
  });
}

async function cleanup() {
  const units = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
  const unitIds = units.map((u) => u.id);
  if (unitIds.length) {
    const reservations = await prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT reservation_id AS id FROM reservation_items WHERE rental_unit_id = ANY(${unitIds}::uuid[])
    `;
    const reservationIds = reservations.map((r) => r.id);
    if (reservationIds.length) {
      await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
      await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
      await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${reservationIds}::uuid[])`;
    }
  }
  await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE entity_id IN (SELECT id::text FROM rental_units WHERE code LIKE ${PREFIX + '%'})`;
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
  if (adminUserId) await prisma.$executeRaw`DELETE FROM admin_users WHERE id = ${adminUserId}::uuid`;
}

beforeAll(async () => {
  await cleanup();
  await ensureStoreConfig(prisma, resolveStoreConfig());
  const user = await prisma.adminUser.create({
    data: { name: 'Admin Pecas Teste', phone: `9${Date.now()}0`, pinHash: 'x:y', role: 'ADMIN', active: true },
  });
  adminUserId = user.id;
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('AdminPiecesService — /closetadmin/pecas (integração real, Neon)', () => {
  test('1) list() traz a peça com os campos operacionais e comerciais corretos', async () => {
    const unit = await createUnit();
    const all = await pieces.list();
    const mine = all.find((p) => p.id === unit.id);
    expect(mine).toMatchObject({
      code: unit.code,
      shopifyProductId: `${unit.code}-product`,
      shopifySku: `${unit.code}-sku`,
      active: true,
      reservableOnline: true,
      countsTowardRentalDuration: true,
      currentlyOccupied: false,
      upcomingReservations: 0,
    });
  }, 15_000);

  test('2) update() desativa peça (active=false) → auditado como UNIT_DEACTIVATED', async () => {
    const unit = await createUnit();
    const updated = await pieces.update(unit.id, { active: false }, adminUserId, 'Admin Pecas Teste');
    expect(updated.active).toBe(false);

    const event = await prisma.adminAuditEvent.findFirst({ where: { entityId: unit.id, action: 'UNIT_DEACTIVATED' } });
    expect(event).not.toBeNull();
    expect(event!.before).toMatchObject({ active: true });
    expect(event!.after).toMatchObject({ active: false });
  });

  test('3) update() reativa peça (active=true) → auditado como UNIT_ACTIVATED', async () => {
    const unit = await createUnit({ active: false });
    await pieces.update(unit.id, { active: true }, adminUserId, 'Admin Pecas Teste');
    const event = await prisma.adminAuditEvent.findFirst({ where: { entityId: unit.id, action: 'UNIT_ACTIVATED' } });
    expect(event).not.toBeNull();
  });

  test('4) update() de reservableOnline sem mudar active → auditado como UNIT_UPDATED (não ACTIVATED/DEACTIVATED)', async () => {
    const unit = await createUnit({ reservableOnline: false });
    const updated = await pieces.update(unit.id, { reservableOnline: true }, adminUserId, 'Admin Pecas Teste');
    expect(updated.reservableOnline).toBe(true);
    const event = await prisma.adminAuditEvent.findFirst({ where: { entityId: unit.id, action: 'UNIT_UPDATED' } });
    expect(event).not.toBeNull();
  });

  test('5) acessório (reservableOnline=false) continua não-reservável online — update de outro campo não altera isso', async () => {
    const unit = await createUnit({ reservableOnline: false });
    const updated = await pieces.update(unit.id, { active: true }, adminUserId, 'Admin Pecas Teste');
    expect(updated.reservableOnline).toBe(false);
  });

  test('6) countsTowardRentalDuration é preservado quando não incluído no update', async () => {
    const unit = await createUnit({ countsTowardRentalDuration: false });
    const updated = await pieces.update(unit.id, { active: false }, adminUserId, 'Admin Pecas Teste');
    expect(updated.countsTowardRentalDuration).toBe(false);
  });

  test('7) peça inexistente → NotFoundException', async () => {
    await expect(pieces.update('00000000-0000-0000-0000-000000000000', { active: false }, adminUserId, 'Admin Pecas Teste')).rejects.toThrow(
      NotFoundException,
    );
  });

  test('8) update() sem nenhum campo → BadRequestException', async () => {
    const unit = await createUnit();
    await expect(pieces.update(unit.id, {}, adminUserId, 'Admin Pecas Teste')).rejects.toThrow(BadRequestException);
  });

  test('9) reativação manual (active=true) limpa shopifyVariantMissingAt — a sincronização não re-tocará sozinha', async () => {
    const unit = await createUnit({ active: false });
    await prisma.rentalUnit.update({ where: { id: unit.id }, data: { shopifyVariantMissingAt: new Date() } });
    const updated = await pieces.update(unit.id, { active: true }, adminUserId, 'Admin Pecas Teste');
    expect(updated.shopifyVariantMissingAt).toBeNull();
  });

  test('10) atualizar outro campo (sem mexer em active) NÃO limpa shopifyVariantMissingAt', async () => {
    const unit = await createUnit({ active: false });
    await prisma.rentalUnit.update({ where: { id: unit.id }, data: { shopifyVariantMissingAt: new Date() } });
    const updated = await pieces.update(unit.id, { reservableOnline: false }, adminUserId, 'Admin Pecas Teste');
    expect(updated.shopifyVariantMissingAt).not.toBeNull();
  });

  test('11) desativar peça com reserva existente não cria, cancela nem altera a reserva', async () => {
    const unit = await createUnit();
    const [reservation] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO reservations (id, status, source, origin_store_id, pickup_date, return_date, terms_accepted_at, terms_version)
      VALUES (gen_random_uuid(), 'confirmed', 'manual_admin', ${resolveStoreConfig().id}, '2029-01-10'::date, '2029-01-12'::date, now(), 'test')
      RETURNING id
    `;
    await prisma.$executeRaw`
      INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
      VALUES (gen_random_uuid(), ${reservation.id}::uuid, ${unit.id}::uuid, 'confirmed', daterange('2029-01-07'::date, '2029-01-15'::date, '[)'))
    `;
    const reservationsBefore = await prisma.reservation.count();
    const eventsBefore = await prisma.reservationEvent.count({ where: { reservationId: reservation.id } });

    await pieces.update(unit.id, { active: false }, adminUserId, 'Admin Pecas Teste');

    const after = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(after.status).toBe('confirmed');
    const [itemAfter] = await prisma.$queryRaw<{ status: string }[]>`SELECT status FROM reservation_items WHERE reservation_id = ${reservation.id}::uuid`;
    expect(itemAfter.status).toBe('confirmed');
    expect(await prisma.reservation.count()).toBe(reservationsBefore); // nenhuma criada, nenhuma apagada
    expect(await prisma.reservationEvent.count({ where: { reservationId: reservation.id } })).toBe(eventsBefore);
  });
});
