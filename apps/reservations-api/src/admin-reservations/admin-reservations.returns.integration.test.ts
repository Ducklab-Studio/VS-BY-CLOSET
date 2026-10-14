import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma, type AdminRole, type AdminModule } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { AdminReservationsService } from './admin-reservations.service';
import { AdminReservationsController } from './admin-reservations.controller';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { hashPin } from '../admin/admin-pin';
import { generateSessionToken, hashSessionToken } from '../admin/admin-session-token';
import { AdminCalendarService } from '../admin-panel/calendar.service';
import { AvailabilityService } from '../availability/availability.service';
import { ReceiveItemDto, RecordOccurrenceDto, ReleaseHoldDto } from './dto/receive-item.dto';
import { addDays, civilDateToISO, isSunday, type CivilDate } from '../rental-rules/civil-date';
import { isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';

// Suíte de escrita: nunca roda contra banco hospedado, mesmo se chamada sozinha.
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const rules = new RentalRuleConfigService(prisma);
const service = new AdminReservationsService(prisma, rules);
const calendar = new AdminCalendarService(prisma);
const availability = new AvailabilityService(prisma, rules);
const reflector = new Reflector();
const roleGuard = new AdminRoleGuard(prisma, reflector);

const prefix = `RET-${Date.now()}`;
const storeId = `${prefix}-store`;
const reservationIds: string[] = [];
const unitIds: string[] = [];
const userIds: string[] = [];
const tokens = new Map<string, string>();
let admin: { id: string; name: string };
let staff: { id: string; name: string };
let pickup: string;
let nextDay: string;
let blockedFrom: string;
let blockedUntil: string;
let todayIso: string;

const GOOD = { condition: 'good' as const };
const DAMAGED = { condition: 'damaged' as const, notes: 'Rasgo na barra, necessita reparo.' };
const MAINTENANCE = { condition: 'needs_maintenance' as const, notes: 'Botão solto.' };

async function createUser(role: AdminRole, moduleAccess: AdminModule[], active = true) {
  const user = await prisma.adminUser.create({
    data: { name: `${prefix} ${role}`, phone: `9${Date.now()}${userIds.length}`, pinHash: await hashPin('1234'), role, active, moduleAccess },
  });
  userIds.push(user.id);
  const token = generateSessionToken();
  await prisma.adminSession.create({ data: { adminUserId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 600_000) } });
  tokens.set(user.id, token);
  return user;
}

interface Made { id: string; items: { itemId: string; unitId: string; code: string }[] }

/** Reserva sintética com N peças, todas no mesmo status; `returnDate` controla o atraso. */
async function make(opts: { status?: 'confirmed' | 'picked_up' | 'cancelled'; items?: number; returnDate?: string; source?: 'manual_admin' | 'online' } = {}): Promise<Made> {
  const status = opts.status ?? 'confirmed';
  const reservation = await prisma.reservation.create({ data: {
    status, source: opts.source ?? 'manual_admin', originStoreId: storeId,
    pickupDate: new Date(pickup), returnDate: new Date(opts.returnDate ?? nextDay),
    confirmedAt: status === 'cancelled' ? null : new Date(),
  } });
  reservationIds.push(reservation.id);
  const items: Made['items'] = [];
  for (let i = 0; i < (opts.items ?? 1); i++) {
    const code = `${prefix}-${unitIds.length}`;
    const unit = await prisma.rentalUnit.create({ data: { code, name: 'Unidade sintética', shopifyVariantId: code, active: true, reservableOnline: true, countsTowardRentalDuration: true } });
    unitIds.push(unit.id);
    const [item] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO reservation_items (reservation_id, rental_unit_id, blocked_range, status)
      VALUES (${reservation.id}::uuid, ${unit.id}::uuid, daterange(${blockedFrom}::date, ${blockedUntil}::date, '[)'), ${status}::reservation_status)
      RETURNING id
    `;
    items.push({ itemId: item.id, unitId: unit.id, code });
  }
  return { id: reservation.id, items };
}

const itemStatus = async (itemId: string) => (await prisma.$queryRaw<{ status: string }[]>`SELECT status FROM reservation_items WHERE id = ${itemId}::uuid`)[0].status;
const reservationStatus = async (id: string) => (await prisma.reservation.findUniqueOrThrow({ where: { id } })).status;
const eventCount = (id: string, type: string) => prisma.reservationEvent.count({ where: { reservationId: id, type } });
const returnRows = (itemId: string) => prisma.reservationItemReturn.count({ where: { reservationItemId: itemId } });
async function available(code: string, date = pickup): Promise<number> {
  return (await availability.getAvailability({ shopifyVariantId: code, countedPieces: 1, from: date, to: date })).days[0].quantityAvailable;
}
async function calendarContains(id: string): Promise<boolean> {
  return (await calendar.getCalendar(blockedFrom, blockedUntil)).some((item) => item.reservationId === id);
}
const receive = (r: Made, index = 0, inspection: { condition: 'good' | 'needs_cleaning' | 'needs_maintenance' | 'damaged'; notes?: string } = GOOD, actor = staff) =>
  service.advanceOperational(r.id, r.items[index].itemId, 'receive', actor, undefined, inspection);
const clean = async (r: Made, index = 0) => {
  await service.advanceOperational(r.id, r.items[index].itemId, 'start-cleaning', staff);
  return service.advanceOperational(r.id, r.items[index].itemId, 'complete-cleaning', staff);
};

localDescribe('módulo de devoluções (PostgreSQL isolado)', () => {
  beforeAll(async () => {
    if (!localDatabase) throw new Error('Banco local obrigatório');
    const isValidPickup = (d: CivilDate) => isOnlineReservationAllowed(d, DEFAULT_RENTAL_RULE_CONFIG) && !isSunday(d);
    let date = addDays(engineToday(DEFAULT_RENTAL_RULE_CONFIG), 60);
    while (!isValidPickup(date) || isSunday(addDays(date, 2)) || !isValidPickup(addDays(date, 6))) date = addDays(date, 1);
    pickup = civilDateToISO(date);
    nextDay = civilDateToISO(addDays(date, 2));
    blockedFrom = civilDateToISO(addDays(date, -3));
    blockedUntil = civilDateToISO(addDays(date, 5));
    todayIso = civilDateToISO(engineToday(await rules.load()));
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

  // 1) Devolução normal
  test('devolução normal: conferência gravada, peça retida até a higienização, depois liberada', async () => {
    const r = await make();
    const { itemId, code } = r.items[0];
    expect(await available(code)).toBe(0);

    const out = await receive(r);
    expect(out).toMatchObject({ itemStatus: 'returned', condition: 'good', daysLate: 0, awaitingRelease: false });
    expect(await itemStatus(itemId)).toBe('returned');
    expect(await available(code)).toBe(0); // devolvida ≠ pronta para alugar
    const row = await prisma.reservationItemReturn.findUniqueOrThrow({ where: { reservationItemId: itemId } });
    expect(row).toMatchObject({ condition: 'good', receivedBy: staff.id, receivedByName: staff.name, daysLate: 0 });
    const event = await prisma.reservationEvent.findFirstOrThrow({ where: { reservationId: r.id, type: 'RESERVATION_ITEM_RETURNED' } });
    expect(event.detail).toMatchObject({ adminUserId: staff.id, condition: 'good', daysLate: 0, reservationItemId: itemId });

    await clean(r);
    expect(await itemStatus(itemId)).toBe('completed');
    expect(await reservationStatus(r.id)).toBe('completed');
    expect(await available(code)).toBe(1);
    // devolução normal não gera auditoria de ocorrência
    expect(await prisma.adminAuditEvent.count({ where: { entityId: itemId } })).toBe(0);
  });

  // sem conferência nada é marcado como devolvido
  test('sem a conferência a peça NÃO é marcada como devolvida', async () => {
    const r = await make();
    await expect(service.advanceOperational(r.id, r.items[0].itemId, 'receive', staff)).rejects.toMatchObject({ status: 400 });
    await expect(receive(r, 0, { condition: 'damaged' })).rejects.toMatchObject({ status: 400 });
    await expect(receive(r, 0, { condition: 'needs_maintenance', notes: '  ' })).rejects.toMatchObject({ status: 400 });
    expect(await itemStatus(r.items[0].itemId)).toBe('confirmed');
    expect(await returnRows(r.items[0].itemId)).toBe(0);
    expect(await eventCount(r.id, 'RESERVATION_ITEM_RETURNED')).toBe(0);
  });

  // 2) Devolução atrasada
  test('devolução atrasada: atraso exibido antes e constatado no recebimento, sem cobrança', async () => {
    const r = await make({ returnDate: civilDateToISO(addDays(engineToday(await rules.load()), -3)) });
    const before = await service.getReservationDetail(r.id);
    expect(before.overdueDays).toBe(3);
    expect(before.items[0]).toMatchObject({ overdueDays: 3, inspection: null });

    const out = await receive(r, 0, { condition: 'needs_cleaning', notes: 'Cheiro de cigarro.' });
    expect(out).toMatchObject({ daysLate: 3, awaitingRelease: false });
    const after = await service.getReservationDetail(r.id);
    expect(after.overdueDays).toBe(0); // recebida: não está mais pendente
    expect(after.items[0].inspection).toMatchObject({ condition: 'needs_cleaning', daysLate: 3, notes: 'Cheiro de cigarro.', receivedByName: staff.name, awaitingRelease: false });
    const audit = await prisma.adminAuditEvent.findFirstOrThrow({ where: { entityId: r.items[0].itemId, action: 'RESERVATION_ITEM_RETURN_FLAGGED' } });
    expect(audit).toMatchObject({ adminUserId: staff.id });
    expect(audit.detail).toMatchObject({ daysLate: 3, condition: 'needs_cleaning' });
    // nada de dinheiro: o registro só guarda fatos (dias e condição)
    expect(Object.keys(await prisma.reservationItemReturn.findUniqueOrThrow({ where: { reservationItemId: r.items[0].itemId } })).filter((k) => /fee|fine|multa|amount|price|charge/i.test(k))).toEqual([]);
  });

  test('devolução dentro do prazo não é marcada como atrasada', async () => {
    const r = await make({ returnDate: todayIso });
    const before = await service.getReservationDetail(r.id);
    expect(before.overdueDays).toBe(0);
    expect(await receive(r)).toMatchObject({ daysLate: 0 });
  });

  // 3) Devolução parcial + 14) múltiplas peças
  test('devolução parcial: só a peça conferida muda; as demais seguem em aberto', async () => {
    const r = await make({ items: 3 });
    await receive(r, 0);
    expect(await itemStatus(r.items[0].itemId)).toBe('returned');
    expect(await itemStatus(r.items[1].itemId)).toBe('confirmed');
    expect(await itemStatus(r.items[2].itemId)).toBe('confirmed');
    expect(await reservationStatus(r.id)).toBe('confirmed');
    expect(await returnRows(r.items[1].itemId)).toBe(0);
    expect(await available(r.items[1].code)).toBe(0);
    const detail = await service.getReservationDetail(r.id);
    expect(detail.items.filter((i) => i.inspection).length).toBe(1);
  });

  test('reserva com múltiplas peças e condições diferentes: só conclui quando todas estão liberadas', async () => {
    const r = await make({ items: 3 });
    await receive(r, 0, GOOD);
    await receive(r, 1, DAMAGED);
    await receive(r, 2, { condition: 'needs_cleaning', notes: 'Manchas leves.' });
    expect(await reservationStatus(r.id)).toBe('returned');

    await clean(r, 0);
    await clean(r, 2);
    await service.advanceOperational(r.id, r.items[1].itemId, 'start-cleaning', staff);
    await expect(service.advanceOperational(r.id, r.items[1].itemId, 'complete-cleaning', staff)).rejects.toMatchObject({ status: 409 });
    expect(await reservationStatus(r.id)).not.toBe('completed');
    expect(await available(r.items[0].code)).toBe(1);
    expect(await available(r.items[2].code)).toBe(1);
    expect(await available(r.items[1].code)).toBe(0); // avariada continua fora

    await service.releaseHold(r.id, r.items[1].itemId, admin, 'Reparo concluído e conferido.');
    await service.advanceOperational(r.id, r.items[1].itemId, 'complete-cleaning', staff);
    expect(await reservationStatus(r.id)).toBe('completed');
    expect(await available(r.items[1].code)).toBe(1);
  });

  // 4) Peça danificada
  test('peça danificada não volta ao estoque sem liberação de ADMIN, com histórico preservado', async () => {
    const r = await make();
    const { itemId, code } = r.items[0];
    expect(await receive(r, 0, DAMAGED)).toMatchObject({ condition: 'damaged', awaitingRelease: true });

    await service.advanceOperational(r.id, itemId, 'start-cleaning', staff);
    await expect(service.advanceOperational(r.id, itemId, 'complete-cleaning', staff)).rejects.toMatchObject({ status: 409 });
    expect(await itemStatus(itemId)).toBe('cleaning');
    expect(await available(code)).toBe(0);
    expect(await calendarContains(r.id)).toBe(true);
    expect((await service.getReservationDetail(r.id)).items[0].inspection).toMatchObject({ condition: 'damaged', awaitingRelease: true });
    expect(await prisma.adminAuditEvent.count({ where: { entityId: itemId, action: 'RESERVATION_ITEM_RETURN_FLAGGED' } })).toBe(1);

    await expect(service.releaseHold(r.id, itemId, admin, 'ok')).rejects.toMatchObject({ status: 400 });
    await expect(service.releaseHold(r.id, itemId, admin, 'Peça reparada pela costureira.')).resolves.toMatchObject({ released: true });
    // liberar NÃO devolve ao estoque sozinho: ainda falta concluir a higienização
    expect(await itemStatus(itemId)).toBe('cleaning');
    expect(await available(code)).toBe(0);
    await expect(service.releaseHold(r.id, itemId, admin, 'Segunda liberação.')).rejects.toMatchObject({ status: 409 });

    await service.advanceOperational(r.id, itemId, 'complete-cleaning', staff);
    expect(await available(code)).toBe(1);
    expect(await calendarContains(r.id)).toBe(false);
    const release = await prisma.adminAuditEvent.findFirstOrThrow({ where: { entityId: itemId, action: 'RETURN_HOLD_RELEASED' } });
    expect(release).toMatchObject({ adminUserId: admin.id, isCritical: true });
    // a conferência original continua lá (nada é apagado)
    expect(await prisma.reservationItemReturn.findUniqueOrThrow({ where: { reservationItemId: itemId } })).toMatchObject({ condition: 'damaged', holdReleasedBy: admin.id });
    expect(await eventCount(r.id, 'RESERVATION_ITEM_HOLD_RELEASED')).toBe(1);
  });

  // 6) Manutenção
  test('peça enviada para manutenção fica retida e mantém o calendário ocupado', async () => {
    const r = await make();
    const { itemId, code } = r.items[0];
    await receive(r, 0, MAINTENANCE);
    expect(await itemStatus(itemId)).toBe('returned');
    expect(await available(code)).toBe(0);
    expect(await calendarContains(r.id)).toBe(true);
    await expect(service.releaseHold(r.id, itemId, admin, 'x')).rejects.toBeDefined();
    // peça boa não tem o que liberar
    const ok = await make();
    await receive(ok);
    await expect(service.releaseHold(ok.id, ok.items[0].itemId, admin, 'Tentativa indevida.')).rejects.toMatchObject({ status: 409 });
    // peça ainda não recebida também não
    const pending = await make();
    await expect(service.releaseHold(pending.id, pending.items[0].itemId, admin, 'Tentativa indevida.')).rejects.toMatchObject({ status: 409 });
  });

  // 5) Peça não devolvida
  test('peça não devolvida: registro sem mudar status, só depois da data prevista, unidade segue ocupada', async () => {
    const future = await make({ returnDate: civilDateToISO(addDays(engineToday(await rules.load()), 5)) });
    await expect(service.recordOccurrence(future.id, future.items[0].itemId, 'not_returned', 'Cliente não apareceu.', staff)).rejects.toMatchObject({ status: 409 });

    const r = await make({ status: 'picked_up', returnDate: civilDateToISO(addDays(engineToday(await rules.load()), -2)) });
    const { itemId, code } = r.items[0];
    expect((await service.getReservationDetail(r.id)).overdueDays).toBe(2);
    await expect(service.recordOccurrence(r.id, itemId, 'not_returned', 'x', staff)).rejects.toMatchObject({ status: 400 });
    const out = await service.recordOccurrence(r.id, itemId, 'not_returned', 'Cliente informou que devolve amanhã.', staff);
    expect(out).toMatchObject({ kind: 'not_returned' });
    await service.recordOccurrence(r.id, itemId, 'not_returned', 'Segundo contato sem resposta.', staff);

    expect(await itemStatus(itemId)).toBe('picked_up'); // NÃO foi marcada como devolvida
    expect(await returnRows(itemId)).toBe(0);
    expect(await available(code)).toBe(0);
    const detail = await service.getReservationDetail(r.id);
    expect(detail.items[0].occurrences.map((o) => o.kind)).toEqual(['not_returned', 'not_returned']);
    expect(detail.items[0].occurrences[0]).toMatchObject({ recordedByName: staff.name });
    expect(await eventCount(r.id, 'RESERVATION_ITEM_NOT_RETURNED')).toBe(2);
    expect(await prisma.adminAuditEvent.count({ where: { entityId: itemId, action: 'RESERVATION_ITEM_NOT_RETURNED' } })).toBe(2);

    // quando enfim volta, o ciclo normal segue e a ocorrência permanece
    await receive(r, 0, GOOD);
    expect(await itemStatus(itemId)).toBe('returned');
    expect((await service.getReservationDetail(r.id)).items[0].occurrences).toHaveLength(2);
    await expect(service.recordOccurrence(r.id, itemId, 'not_returned', 'Já foi devolvida.', staff)).rejects.toMatchObject({ status: 409 });
    // observação livre continua permitida
    await expect(service.recordOccurrence(r.id, itemId, 'note', 'Etiqueta substituída.', staff)).resolves.toMatchObject({ kind: 'note' });
  });

  // 7) Devolução repetida + proteção no banco
  test('devolução repetida é recusada e o banco impede duplicidade mesmo sem a checagem de status', async () => {
    const r = await make();
    const { itemId } = r.items[0];
    await receive(r);
    await expect(receive(r)).rejects.toMatchObject({ status: 409 });
    await expect(receive(r, 0, DAMAGED)).rejects.toMatchObject({ status: 409 });
    expect(await returnRows(itemId)).toBe(1);
    expect(await eventCount(r.id, 'RESERVATION_ITEM_RETURNED')).toBe(1);

    await expect(prisma.reservationItemReturn.create({ data: {
      reservationItemId: itemId, reservationId: r.id, condition: 'good', receivedBy: staff.id, receivedByName: staff.name,
    } })).rejects.toMatchObject({ code: 'P2002' });
  });

  test('o banco recusa avaria sem descrição e liberação sem autor/motivo', async () => {
    const r = await make();
    await expect(prisma.$executeRaw`
      INSERT INTO reservation_item_returns (reservation_item_id, reservation_id, condition, received_by, received_by_name)
      VALUES (${r.items[0].itemId}::uuid, ${r.id}::uuid, 'damaged', ${staff.id}::uuid, 'x')
    `).rejects.toThrow(/reservation_item_returns_notes_check/);
    await receive(r, 0, GOOD);
    await expect(prisma.$executeRaw`
      UPDATE reservation_item_returns SET hold_released_at = now() WHERE reservation_item_id = ${r.items[0].itemId}::uuid
    `).rejects.toThrow(/reservation_item_returns_release_check/);
  });

  // 8) Concorrência
  test('duas devoluções simultâneas: uma vence, uma é recusada, um registro e um evento', async () => {
    const r = await make();
    const outcomes = await Promise.allSettled([receive(r, 0, GOOD, staff), receive(r, 0, DAMAGED, admin)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
    expect(await returnRows(r.items[0].itemId)).toBe(1);
    expect(await eventCount(r.id, 'RESERVATION_ITEM_RETURNED')).toBe(1);
    expect(await itemStatus(r.items[0].itemId)).toBe('returned');
  });

  test('duas liberações simultâneas: apenas uma é aplicada', async () => {
    const r = await make();
    await receive(r, 0, DAMAGED);
    const outcomes = await Promise.allSettled([
      service.releaseHold(r.id, r.items[0].itemId, admin, 'Liberação A concluída.'),
      service.releaseHold(r.id, r.items[0].itemId, admin, 'Liberação B concluída.'),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await eventCount(r.id, 'RESERVATION_ITEM_HOLD_RELEASED')).toBe(1);
  });

  // 9) Reserva cancelada
  test('reserva cancelada não recebe devolução nem ocorrência', async () => {
    const r = await make({ status: 'cancelled' });
    await expect(receive(r)).rejects.toMatchObject({ status: 409 });
    await expect(service.recordOccurrence(r.id, r.items[0].itemId, 'note', 'Tentativa em cancelada.', staff)).rejects.toMatchObject({ status: 409 });
    await expect(service.releaseHold(r.id, r.items[0].itemId, admin, 'Tentativa em cancelada.')).rejects.toMatchObject({ status: 409 });
    expect(await returnRows(r.items[0].itemId)).toBe(0);
    expect(await reservationStatus(r.id)).toBe('cancelled');
    expect(await eventCount(r.id, 'RESERVATION_ITEM_RETURNED')).toBe(0);
  });

  test('reserva online paga pode ser recebida sem alterar pedido ou pagamento', async () => {
    const r = await make({ source: 'online' });
    const before = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } });
    await receive(r);
    const after = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } });
    expect({ o: after.shopifyOrderId, c: after.checkoutState, s: after.source, conf: after.confirmedAt }).toEqual({ o: before.shopifyOrderId, c: before.checkoutState, s: before.source, conf: before.confirmedAt });
  });

  // 10) Operador sem permissão (guard real + metadata real do controller)
  describe('permissões ADMIN/STAFF', () => {
    function ctx(handler: (...args: never[]) => unknown, userId: string, tokenOverride?: string): ExecutionContext {
      const request = { headers: { 'x-admin-session': tokenOverride ?? tokens.get(userId) }, query: {}, body: {} };
      return {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => handler,
        getClass: () => AdminReservationsController,
      } as unknown as ExecutionContext;
    }
    const proto = AdminReservationsController.prototype;

    test('STAFF com módulo Reservas pode conferir e registrar ocorrência, mas não liberar peça retida', async () => {
      await expect(roleGuard.canActivate(ctx(proto.receive, staff.id))).resolves.toBe(true);
      await expect(roleGuard.canActivate(ctx(proto.recordOccurrence, staff.id))).resolves.toBe(true);
      await expect(roleGuard.canActivate(ctx(proto.releaseHold, staff.id))).rejects.toBeInstanceOf(ForbiddenException);
    });

    test('ADMIN com módulo Reservas pode liberar peça retida', async () => {
      await expect(roleGuard.canActivate(ctx(proto.releaseHold, admin.id))).resolves.toBe(true);
    });

    test('sem o módulo Reservas, nem ADMIN opera devolução', async () => {
      const noModule = await createUser('ADMIN', ['CALENDAR']);
      for (const handler of [proto.receive, proto.releaseHold, proto.recordOccurrence]) {
        await expect(roleGuard.canActivate(ctx(handler, noModule.id))).rejects.toBeInstanceOf(ForbiddenException);
      }
      const staffNoModule = await createUser('STAFF', ['PIECES']);
      await expect(roleGuard.canActivate(ctx(proto.receive, staffNoModule.id))).rejects.toBeInstanceOf(ForbiddenException);
    });

    test('usuário inativo e sessão inválida são recusados', async () => {
      const inactive = await createUser('ADMIN', ['RESERVATIONS'], false);
      await expect(roleGuard.canActivate(ctx(proto.receive, inactive.id))).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(roleGuard.canActivate(ctx(proto.receive, staff.id, 'token-que-nao-existe'))).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  // validação do corpo no limite HTTP
  describe('validação dos corpos (DTO)', () => {
    const check = async <T extends object>(cls: new () => T, body: object) => (await validate(plainToInstance(cls, body) as object)).length;
    test('a condição é obrigatória e restrita à lista', async () => {
      expect(await check(ReceiveItemDto, {})).toBeGreaterThan(0);
      expect(await check(ReceiveItemDto, { condition: 'ok' })).toBeGreaterThan(0);
      expect(await check(ReceiveItemDto, { condition: 'good' })).toBe(0);
      expect(await check(ReceiveItemDto, { condition: 'needs_cleaning' })).toBe(0);
    });
    test('avaria e manutenção exigem descrição; observação curta é recusada', async () => {
      expect(await check(ReceiveItemDto, { condition: 'damaged' })).toBeGreaterThan(0);
      expect(await check(ReceiveItemDto, { condition: 'needs_maintenance', notes: 'ab' })).toBeGreaterThan(0);
      expect(await check(ReceiveItemDto, { condition: 'damaged', notes: 'Rasgo na manga.' })).toBe(0);
      expect(await check(ReceiveItemDto, { condition: 'good', notes: 'a' })).toBeGreaterThan(0);
    });
    test('liberação e ocorrência exigem texto e tipo válido', async () => {
      expect(await check(ReleaseHoldDto, {})).toBeGreaterThan(0);
      expect(await check(ReleaseHoldDto, { note: 'Reparo ok.' })).toBe(0);
      expect(await check(RecordOccurrenceDto, { kind: 'multa', notes: 'Cobrança indevida.' })).toBeGreaterThan(0);
      expect(await check(RecordOccurrenceDto, { kind: 'note', notes: 'Observação.' })).toBe(0);
    });
  });

  // 11/12) Calendário e reservas futuras
  test('calendário acompanha a devolução e reservas futuras da mesma peça são preservadas', async () => {
    const r = await make();
    const { itemId, unitId, code } = r.items[0];
    const futureFrom = civilDateToISO(addDays(engineToday(DEFAULT_RENTAL_RULE_CONFIG), 400));
    const futureTo = civilDateToISO(addDays(engineToday(DEFAULT_RENTAL_RULE_CONFIG), 408));
    const future = await prisma.reservation.create({ data: {
      status: 'confirmed', source: 'manual_admin', originStoreId: storeId,
      pickupDate: new Date(futureFrom), returnDate: new Date(futureTo), confirmedAt: new Date(),
    } });
    reservationIds.push(future.id);
    const [futureItem] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO reservation_items (reservation_id, rental_unit_id, blocked_range, status)
      VALUES (${future.id}::uuid, ${unitId}::uuid, daterange(${futureFrom}::date, ${futureTo}::date, '[)'), 'confirmed') RETURNING id
    `;

    expect(await calendarContains(r.id)).toBe(true);
    await receive(r);
    expect(await calendarContains(r.id)).toBe(true); // devolvida ainda ocupa
    await clean(r);
    expect(await calendarContains(r.id)).toBe(false);
    expect(await available(code)).toBe(1);

    // a reserva futura da mesma unidade segue intacta e ainda ocupa o calendário dela
    expect(await itemStatus(futureItem.id)).toBe('confirmed');
    expect(await reservationStatus(future.id)).toBe('confirmed');
    expect((await calendar.getCalendar(futureFrom, futureTo)).some((item) => item.reservationId === future.id)).toBe(true);
    expect(await prisma.reservationItemReturn.count({ where: { reservationItemId: futureItem.id } })).toBe(0);
    expect(itemId).not.toBe(futureItem.id);
  });

  // 13) Falha durante a transação
  test('falha no meio da transação não deixa devolução pela metade', async () => {
    const r = await make({ items: 2 });
    const failingPrisma = new Proxy(prisma, {
      get(target, key, receiver) {
        if (key !== '$transaction') return Reflect.get(target, key, receiver);
        return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) =>
          target.$transaction((tx) => fn(new Proxy(tx, {
            get(t, k, rec) {
              // A conferência, a mudança de status e o agregado já foram gravados quando o evento falha.
              if (k === 'reservationEvent') return { create: async () => { throw new Error('falha simulada'); } };
              return Reflect.get(t, k, rec);
            },
          })), options);
      },
    }) as unknown as PrismaService;
    const failing = new AdminReservationsService(failingPrisma, rules);

    await expect(failing.advanceOperational(r.id, r.items[0].itemId, 'receive', staff, undefined, DAMAGED)).rejects.toMatchObject({ status: 503 });
    expect(await itemStatus(r.items[0].itemId)).toBe('confirmed');
    expect(await returnRows(r.items[0].itemId)).toBe(0);
    expect(await reservationStatus(r.id)).toBe('confirmed');
    expect(await prisma.adminAuditEvent.count({ where: { entityId: r.items[0].itemId } })).toBe(0);
    expect(await available(r.items[0].code)).toBe(0);

    // e o fluxo real continua funcionando depois da falha
    await expect(receive(r, 0, DAMAGED)).resolves.toMatchObject({ itemStatus: 'returned' });
  });

  test('falha ao registrar ocorrência ou liberar também reverte tudo', async () => {
    const r = await make({ status: 'picked_up', returnDate: civilDateToISO(addDays(engineToday(await rules.load()), -1)) });
    const failingPrisma = new Proxy(prisma, {
      get(target, key, receiver) {
        if (key !== '$transaction') return Reflect.get(target, key, receiver);
        return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) =>
          target.$transaction((tx) => fn(new Proxy(tx, {
            get(t, k, rec) {
              if (k === 'reservationEvent') return { create: async () => { throw new Error('falha simulada'); } };
              return Reflect.get(t, k, rec);
            },
          })), options);
      },
    }) as unknown as PrismaService;
    const failing = new AdminReservationsService(failingPrisma, rules);
    await expect(failing.recordOccurrence(r.id, r.items[0].itemId, 'not_returned', 'Cliente sem resposta.', staff)).rejects.toMatchObject({ status: 503 });
    expect(await prisma.reservationItemOccurrence.count({ where: { reservationId: r.id } })).toBe(0);
  });
});
