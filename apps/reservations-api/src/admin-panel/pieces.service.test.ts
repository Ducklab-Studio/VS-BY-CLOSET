import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminPiecesService } from './pieces.service';

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
  await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE entity_id IN (SELECT id::text FROM rental_units WHERE code LIKE ${PREFIX + '%'})`;
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
  if (adminUserId) await prisma.$executeRaw`DELETE FROM admin_users WHERE id = ${adminUserId}::uuid`;
}

beforeAll(async () => {
  await cleanup();
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
});
