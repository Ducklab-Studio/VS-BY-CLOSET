import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AdminModule, AdminRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { AdminReservationsService } from './admin-reservations.service';
import { AdminReservationsController } from './admin-reservations.controller';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { hashPin } from '../admin/admin-pin';
import { generateSessionToken, hashSessionToken } from '../admin/admin-session-token';
import { addDays, civilDateToISO } from '../rental-rules/civil-date';
import { today as engineToday } from '../rental-rules/rental-engine';

// Suíte de escrita: nunca roda contra banco hospedado, mesmo se chamada sozinha.
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const rules = new RentalRuleConfigService(prisma);
const service = new AdminReservationsService(prisma, rules);
const roleGuard = new AdminRoleGuard(prisma, new Reflector());

const prefix = `ALR-${Date.now()}`;
const storeId = `${prefix}-store`;
const reservationIds: string[] = [];
const unitIds: string[] = [];
const userIds: string[] = [];
const tokens = new Map<string, string>();
let admin: { id: string; name: string };
let staff: { id: string; name: string };
let todayCivil: ReturnType<typeof engineToday>;

const DAMAGED = { condition: 'damaged' as const, notes: 'Rasgo na barra, necessita reparo.' };
const MAINTENANCE = { condition: 'needs_maintenance' as const, notes: 'Botão solto.' };
const day = (offset: number) => civilDateToISO(addDays(todayCivil, offset));

async function createUser(role: AdminRole, moduleAccess: AdminModule[], active = true) {
  const user = await prisma.adminUser.create({ data: { name: `${prefix} ${role}`, phone: `9${Date.now()}${userIds.length}`, pinHash: await hashPin('1234'), role, active, moduleAccess } });
  userIds.push(user.id);
  const token = generateSessionToken();
  await prisma.adminSession.create({ data: { adminUserId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 600_000) } });
  tokens.set(user.id, token);
  return user;
}

async function newUnit(): Promise<{ id: string; code: string }> {
  const code = `${prefix}-${unitIds.length}`;
  const unit = await prisma.rentalUnit.create({ data: { code, name: `Peça ${code}`, shopifyVariantId: code, active: true, reservableOnline: true, countsTowardRentalDuration: true } });
  unitIds.push(unit.id);
  return { id: unit.id, code };
}

/** Reserva (e peça) devolvida e fotografada com a condição pedida — a que RETÉM a peça. */
async function heldPiece(inspection: { condition: 'good' | 'needs_cleaning' | 'needs_maintenance' | 'damaged'; notes?: string }) {
  const unit = await newUnit();
  const reservation = await prisma.reservation.create({ data: { status: 'confirmed', source: 'manual_admin', originStoreId: storeId, pickupDate: new Date(day(-34)), returnDate: new Date(day(-29)), confirmedAt: new Date(), customerName: 'Cliente da retenção' } });
  reservationIds.push(reservation.id);
  const [item] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservation_items (reservation_id, rental_unit_id, blocked_range, status)
    VALUES (${reservation.id}::uuid, ${unit.id}::uuid, daterange(${day(-40)}::date, ${day(-28)}::date, '[)'), 'confirmed') RETURNING id`;
  await service.advanceOperational(reservation.id, item.id, 'receive', staff, undefined, inspection);
  return { reservationId: reservation.id, itemId: item.id, unitId: unit.id, code: unit.code };
}

/** Reserva futura (ou passada) na MESMA peça, por inserção direta (sem passar pela disponibilidade). */
async function reservationOn(unitId: string, opts: { pickupOffset: number; status?: 'confirmed' | 'pending_payment' | 'preparing' | 'ready_for_pickup' | 'cancelled' | 'expired' | 'hold' | 'picked_up'; archived?: boolean; customerName?: string | null; withContact?: boolean }) {
  const status = opts.status ?? 'confirmed';
  const pickup = day(opts.pickupOffset);
  const reservation = await prisma.reservation.create({ data: {
    status, source: 'manual_admin', originStoreId: storeId, pickupDate: new Date(pickup), returnDate: new Date(day(opts.pickupOffset + 2)),
    confirmedAt: status === 'confirmed' ? new Date() : null, customerName: opts.customerName === undefined ? 'Cliente Futura' : opts.customerName,
    ...(opts.withContact ? { customerPhone: '+5511999990000', customerEmail: 'contato@example.invalid' } : {}),
    ...(opts.archived ? { archivedAt: new Date() } : {}),
  } });
  reservationIds.push(reservation.id);
  const [item] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservation_items (reservation_id, rental_unit_id, blocked_range, status)
    VALUES (${reservation.id}::uuid, ${unitId}::uuid, daterange(${day(opts.pickupOffset - 4)}::date, ${day(opts.pickupOffset + 6)}::date, '[)'), ${status}::reservation_status) RETURNING id`;
  return { id: reservation.id, itemId: item.id, pickup };
}

const alertFor = async (itemId: string) => (await service.listHeldPieceAlerts()).alerts.find((a) => a.reservationItemId === itemId);

/** Tudo o que um alerta jamais pode mexer. */
async function snapshot(): Promise<string> {
  const ids = reservationIds;
  const res = await prisma.$queryRaw`SELECT id::text, status::text, updated_at::text, shopify_order_id, checkout_state::text, confirmed_at::text, archived_at::text FROM reservations WHERE id = ANY(${ids}::uuid[]) ORDER BY id`;
  const items = await prisma.$queryRaw`SELECT id::text, status::text, returned_at::text, cleaning_completed_at::text FROM reservation_items WHERE reservation_id = ANY(${ids}::uuid[]) ORDER BY id`;
  const returns = await prisma.$queryRaw`SELECT reservation_item_id::text, condition::text, hold_released_at::text FROM reservation_item_returns WHERE reservation_id = ANY(${ids}::uuid[]) ORDER BY reservation_item_id`;
  const counts = {
    events: await prisma.reservationEvent.count({ where: { reservationId: { in: ids } } }),
    occurrences: await prisma.reservationItemOccurrence.count({ where: { reservationId: { in: ids } } }),
    audit: await prisma.adminAuditEvent.count({ where: { adminUserId: { in: userIds } } }),
  };
  return JSON.stringify({ res, items, returns, counts });
}

localDescribe('alerta de peça retida com reserva futura (PostgreSQL isolado)', () => {
  beforeAll(async () => {
    if (!localDatabase) throw new Error('Banco local obrigatório');
    todayCivil = engineToday(await rules.load());
    await prisma.store.create({ data: { id: storeId, shopifyDomain: `${prefix.toLowerCase()}.invalid`, currency: 'BRL' } });
    admin = await createUser('ADMIN', ['RESERVATIONS']);
    staff = await createUser('STAFF', ['RESERVATIONS']);
  });

  afterAll(async () => {
    if (!localDatabase) return;
    await prisma.adminAuditEvent.deleteMany({ where: { adminUserId: { in: userIds } } });
    if (reservationIds.length) {
      await prisma.reservationItemOccurrence.deleteMany({ where: { reservationId: { in: reservationIds } } });
      await prisma.reservationItemReturn.deleteMany({ where: { reservationId: { in: reservationIds } } });
      await prisma.reservationEvent.deleteMany({ where: { reservationId: { in: reservationIds } } });
      await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
      await prisma.reservation.deleteMany({ where: { id: { in: reservationIds } } });
    }
    if (unitIds.length) await prisma.rentalUnit.deleteMany({ where: { id: { in: unitIds } } });
    await prisma.adminSession.deleteMany({ where: { adminUserId: { in: userIds } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.store.delete({ where: { id: storeId } });
    await prisma.$disconnect();
  });

  test('peça danificada com reserva futura confirmada: o alerta identifica a peça, a reserva e a retirada', async () => {
    const held = await heldPiece(DAMAGED);
    const future = await reservationOn(held.unitId, { pickupOffset: 12 });
    const alert = await alertFor(held.itemId);
    expect(alert).toBeDefined();
    expect(alert).toMatchObject({
      reservationItemId: held.itemId, heldReservationId: held.reservationId, unitId: held.unitId, code: held.code, condition: 'damaged', affectedCount: 1,
      nextReservation: { id: future.id, status: 'confirmed', pickupDate: future.pickup, daysUntilPickup: 12, customerName: 'Cliente Futura' },
    });
    expect(new Date(alert!.heldSince).getTime()).toBeLessThanOrEqual(Date.now());
  });

  test('manutenção também alerta; com várias reservas a mais próxima é a "próxima" e o total conta todas', async () => {
    const held = await heldPiece(MAINTENANCE);
    await reservationOn(held.unitId, { pickupOffset: 40 });
    const nearest = await reservationOn(held.unitId, { pickupOffset: 9, status: 'ready_for_pickup' });
    await reservationOn(held.unitId, { pickupOffset: 25, status: 'pending_payment' });
    const alert = (await alertFor(held.itemId))!;
    expect(alert.condition).toBe('needs_maintenance');
    expect(alert.affectedCount).toBe(3);
    expect(alert.nextReservation).toMatchObject({ id: nearest.id, status: 'ready_for_pickup', daysUntilPickup: 9 });
  });

  test('o alerta mais urgente (retirada mais próxima) vem primeiro', async () => {
    const far = await heldPiece(DAMAGED);
    await reservationOn(far.unitId, { pickupOffset: 55 });
    const near = await heldPiece(DAMAGED);
    await reservationOn(near.unitId, { pickupOffset: 2 });
    const codes = (await service.listHeldPieceAlerts()).alerts.map((a) => a.code);
    expect(codes.indexOf(near.code)).toBeGreaterThanOrEqual(0);
    expect(codes.indexOf(near.code)).toBeLessThan(codes.indexOf(far.code));
  });

  test('não alerta quando ninguém depende da peça ou a dependência não é válida', async () => {
    const held = await heldPiece(DAMAGED);
    expect(await alertFor(held.itemId)).toBeUndefined(); // retida sem reserva futura
    // cancelada/expirada não ocupam a peça; as demais ficam em períodos separados
    await reservationOn(held.unitId, { pickupOffset: 10, status: 'cancelled' });
    await reservationOn(held.unitId, { pickupOffset: 11, status: 'expired' });
    await reservationOn(held.unitId, { pickupOffset: 22, status: 'hold' }); // carrinho temporário
    await reservationOn(held.unitId, { pickupOffset: 34, archived: true });
    await reservationOn(held.unitId, { pickupOffset: -12 }); // retirada já passou
    await reservationOn(held.unitId, { pickupOffset: 46, status: 'picked_up' }); // já está com a cliente
    expect(await alertFor(held.itemId)).toBeUndefined();
    // outra peça com reserva futura não conta
    const other = await newUnit();
    await reservationOn(other.id, { pickupOffset: 10 });
    expect(await alertFor(held.itemId)).toBeUndefined();
  });

  test('peça em boas condições, higienização especial ou já liberada não gera alerta', async () => {
    const good = await heldPiece({ condition: 'good' });
    const dirty = await heldPiece({ condition: 'needs_cleaning', notes: 'Mancha.' });
    const freed = await heldPiece(DAMAGED);
    for (const p of [good, dirty, freed]) await reservationOn(p.unitId, { pickupOffset: 10 });
    expect(await alertFor(freed.itemId)).toBeDefined();
    await service.releaseHold(freed.reservationId, freed.itemId, admin, 'Reparo concluído e conferido.');
    for (const p of [good, dirty, freed]) expect(await alertFor(p.itemId)).toBeUndefined();
  });

  test('a própria reserva que reteve a peça nunca é a "reserva afetada"', async () => {
    const held = await heldPiece(DAMAGED);
    const future = await reservationOn(held.unitId, { pickupOffset: 8 });
    const alert = (await alertFor(held.itemId))!;
    expect(alert.nextReservation.id).not.toBe(held.reservationId);
    expect(alert.nextReservation.id).toBe(future.id);
  });

  test('SOMENTE LEITURA: consultar o alerta não cancela, não libera, não altera pagamento nem grava nada', async () => {
    const held = await heldPiece(DAMAGED);
    const future = await reservationOn(held.unitId, { pickupOffset: 7 });
    const before = await snapshot();
    for (let i = 0; i < 5; i++) await service.listHeldPieceAlerts();
    await service.getReservationDetail(future.id);
    await service.getReservationDetail(held.reservationId);
    expect(await snapshot()).toBe(before);
    // continua tudo como estava: peça retida, reserva futura confirmada
    expect((await prisma.reservationItemReturn.findUniqueOrThrow({ where: { reservationItemId: held.itemId } })).holdReleasedAt).toBeNull();
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: future.id } })).status).toBe('confirmed');
    expect((await service.getReservationDetail(held.reservationId)).items[0].inspection?.awaitingRelease).toBe(true);
  });

  test('liberar a peça (ação humana) faz o alerta sumir; a reserva futura segue intacta', async () => {
    const held = await heldPiece(MAINTENANCE);
    const future = await reservationOn(held.unitId, { pickupOffset: 6 });
    expect(await alertFor(held.itemId)).toBeDefined();
    await service.releaseHold(held.reservationId, held.itemId, admin, 'Botão recosturado.');
    expect(await alertFor(held.itemId)).toBeUndefined();
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: future.id } })).status).toBe('confirmed');
  });

  test('privacidade: só nome e dados operacionais; nunca telefone, e-mail, pedido ou pagamento', async () => {
    const held = await heldPiece(DAMAGED);
    await reservationOn(held.unitId, { pickupOffset: 5, withContact: true, customerName: null });
    const payload = JSON.stringify(await service.listHeldPieceAlerts());
    expect(payload).toContain(held.code);
    expect(payload).not.toMatch(/phone|email|5511999990000|example\.invalid|shopify|checkout|payment|amount|price/i);
    const alert = (await alertFor(held.itemId))!;
    expect(alert.nextReservation.customerName).toBeNull(); // sem nome: a tela mostra o código da reserva
  });

  test('detalhe da reserva afetada avisa que a peça está retida em outra reserva; some depois da liberação', async () => {
    const held = await heldPiece(DAMAGED);
    const future = await reservationOn(held.unitId, { pickupOffset: 15 });
    const detail = await service.getReservationDetail(future.id);
    expect(detail.items[0].unitHold).toMatchObject({ reservationId: held.reservationId, condition: 'damaged' });
    // a reserva que reteve não "se avisa", e peça já retirada não é "afetada"
    expect((await service.getReservationDetail(held.reservationId)).items[0].unitHold).toBeNull();
    const out = await reservationOn(held.unitId, { pickupOffset: 30, status: 'picked_up' });
    expect((await service.getReservationDetail(out.id)).items[0].unitHold).toBeNull();
    await service.releaseHold(held.reservationId, held.itemId, admin, 'Peça reparada e conferida.');
    expect((await service.getReservationDetail(future.id)).items[0].unitHold).toBeNull();
  });

  test('CONCORRÊNCIA: leituras simultâneas durante liberação e novas retenções nunca falham nem mostram alerta pela metade', async () => {
    const releasing = await heldPiece(DAMAGED);
    const future = await reservationOn(releasing.unitId, { pickupOffset: 10 });
    const before = await snapshot();

    const reads = Array.from({ length: 30 }, () => service.listHeldPieceAlerts());
    const release = service.releaseHold(releasing.reservationId, releasing.itemId, admin, 'Liberação concorrente.');
    const more = Array.from({ length: 30 }, () => service.listHeldPieceAlerts());
    const settled = await Promise.allSettled([...reads, release, ...more]);

    expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);
    for (const s of settled) {
      if (s.status !== 'fulfilled' || !s.value || !('alerts' in s.value)) continue;
      const mine = s.value.alerts.find((a) => a.reservationItemId === releasing.itemId);
      // ou enxerga o estado de antes (alerta COMPLETO) ou o de depois (nenhum alerta): nunca metade
      if (mine) expect(mine.nextReservation).toMatchObject({ id: future.id, daysUntilPickup: 10 });
    }
    expect(await alertFor(releasing.itemId)).toBeUndefined();
    // a única escrita foi a liberação humana (1 evento + 1 auditoria); as leituras não escreveram
    const after = JSON.parse(await snapshot());
    expect(after.counts.events).toBe(JSON.parse(before).counts.events + 1);
    expect(after.counts.audit).toBe(JSON.parse(before).counts.audit + 1);
  });

  test('CONCORRÊNCIA: devolução com avaria feita durante leituras aparece de uma vez, com a reserva afetada', async () => {
    const unit = await newUnit();
    const reservation = await prisma.reservation.create({ data: { status: 'confirmed', source: 'manual_admin', originStoreId: storeId, pickupDate: new Date(day(-34)), returnDate: new Date(day(-29)), confirmedAt: new Date() } });
    reservationIds.push(reservation.id);
    const [item] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO reservation_items (reservation_id, rental_unit_id, blocked_range, status)
      VALUES (${reservation.id}::uuid, ${unit.id}::uuid, daterange(${day(-40)}::date, ${day(-28)}::date, '[)'), 'confirmed') RETURNING id`;
    const future = await reservationOn(unit.id, { pickupOffset: 11 });

    const reads = Array.from({ length: 25 }, () => service.listHeldPieceAlerts());
    const receive = service.advanceOperational(reservation.id, item.id, 'receive', staff, undefined, DAMAGED);
    const settled = await Promise.allSettled([...reads, receive]);
    expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);
    for (const s of settled) {
      if (s.status !== 'fulfilled' || !s.value || !('alerts' in s.value)) continue;
      const mine = s.value.alerts.find((a) => a.reservationItemId === item.id);
      if (mine) expect(mine.nextReservation.id).toBe(future.id);
    }
    expect((await alertFor(item.id))?.nextReservation.id).toBe(future.id);
  });

  test('falha do banco vira 503 claro (nunca uma lista vazia que pareça "tudo certo")', async () => {
    const failing = new AdminReservationsService(new Proxy(prisma, {
      get(target, key, receiver) {
        if (key === '$transaction') return () => Promise.reject(new Error('falha simulada'));
        return Reflect.get(target, key, receiver);
      },
    }) as unknown as PrismaService, rules);
    await expect(failing.listHeldPieceAlerts()).rejects.toMatchObject({ status: 503 });
  });

  describe('permissões (guard real + metadados reais do controller)', () => {
    const proto = AdminReservationsController.prototype;
    function ctx(userId: string, tokenOverride?: string): ExecutionContext {
      const request = { headers: { 'x-admin-session': tokenOverride ?? tokens.get(userId) }, query: {}, body: {} };
      return { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => proto.heldPieceAlerts, getClass: () => AdminReservationsController } as unknown as ExecutionContext;
    }

    test('STAFF e ADMIN com módulo Reservas enxergam o alerta', async () => {
      await expect(roleGuard.canActivate(ctx(staff.id))).resolves.toBe(true);
      await expect(roleGuard.canActivate(ctx(admin.id))).resolves.toBe(true);
    });

    test('sem o módulo Reservas, inativo ou sem sessão válida: recusado', async () => {
      const noModule = await createUser('STAFF', ['PIECES']);
      await expect(roleGuard.canActivate(ctx(noModule.id))).rejects.toBeInstanceOf(ForbiddenException);
      const inactive = await createUser('ADMIN', ['RESERVATIONS'], false);
      await expect(roleGuard.canActivate(ctx(inactive.id))).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(roleGuard.canActivate(ctx(staff.id, 'token-inexistente'))).rejects.toBeInstanceOf(UnauthorizedException);
    });

    test('a rota fixa vem ANTES de ":id" (senão o ParseUUIDPipe a trataria como id) e é só GET', () => {
      const names = Object.getOwnPropertyNames(proto);
      expect(names.indexOf('heldPieceAlerts')).toBeGreaterThan(-1);
      expect(names.indexOf('heldPieceAlerts')).toBeLessThan(names.indexOf('detail'));
      expect(Reflect.getMetadata('path', proto.heldPieceAlerts)).toBe('held-piece-alerts');
      expect(Reflect.getMetadata('method', proto.heldPieceAlerts)).toBe(0); // RequestMethod.GET
    });
  });
});
