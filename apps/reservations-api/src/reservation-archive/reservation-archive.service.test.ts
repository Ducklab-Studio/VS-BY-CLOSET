import 'reflect-metadata'; // necessário pro teste 12 (Reflect.getMetadata do @RequireRole)
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { AdminReservationsService } from '../admin-reservations/admin-reservations.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { ReservationArchiveService } from './reservation-archive.service';
import { civilDateToISO, addDays, type CivilDate } from '../rental-rules/civil-date';

/**
 * Integração real (Neon/Postgres) — mesmo padrão de
 * webhooks.service.test.ts: fixtures criadas direto via SQL (mais
 * rápido, e este módulo não depende de HoldsService/CheckoutService),
 * nunca mockado. `archived_at`/`archived_by`/`archive_reason` são os
 * ÚNICOS campos que o arquivamento escreve — todo teste abaixo que
 * verifica "não alterou X" está checando isso na prática, não em tese.
 */
const prisma = new PrismaService();
const archiveService = new ReservationArchiveService(prisma);
const adminReservations = new AdminReservationsService(prisma, new RentalRuleConfigService(prisma));

const PREFIX = `ARQ-${Date.now()}`;
let unitCounter = 0;
const ADMIN_USER_ID = '00000000-0000-0000-0000-000000000001';

async function createUnit() {
  const code = `${PREFIX}-u${unitCounter++}`;
  const unit = await prisma.rentalUnit.create({
    data: { code, name: 'peça de teste', shopifyVariantId: `${code}-v`, active: true, reservableOnline: true, countsTowardRentalDuration: true },
  });
  return unit.id;
}

/**
 * Cria uma Reservation com `updated_at` FORÇADO para uma data no
 * passado (via UPDATE depois do INSERT — `updated_at` tem
 * `@updatedAt`, então só um UPDATE direto no banco consegue simular
 * "encerrada há N dias", já que o Prisma sempre sobrescreveria com
 * `now()` na criação).
 */
function todayCivil(): CivilDate {
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
}

async function createReservation(opts: {
  status: string;
  daysAgoClosed: number; // há quantos dias esta reserva foi "encerrada" (return_date, o que o serviço usa como data de fechamento)
  pickupDaysFromToday?: number; // padrão: 2 dias antes de returnDate, coerente com status terminal
  unitId?: string;
}): Promise<string> {
  const today = todayCivil();
  const returnDate = addDays(today, -opts.daysAgoClosed);
  const pickup: CivilDate = opts.pickupDaysFromToday !== undefined ? addDays(today, opts.pickupDaysFromToday) : addDays(returnDate, -2);

  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservations (id, status, origin_store_id, pickup_date, return_date, source, internal_note)
    VALUES (gen_random_uuid(), ${opts.status}::"reservation_status", 'dev-store', ${civilDateToISO(pickup)}::date, ${civilDateToISO(returnDate)}::date, 'manual_admin', ${PREFIX})
    RETURNING id
  `;
  const id = rows[0].id;

  if (opts.unitId) {
    await prisma.$executeRaw`
      INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
      VALUES (gen_random_uuid(), ${id}::uuid, ${opts.unitId}::uuid, ${opts.status}::"reservation_status",
        daterange(${civilDateToISO(pickup)}::date, ${civilDateToISO(returnDate)}::date, '[)'))
    `;
  }

  // Simula "encerrada há N dias" retroagindo updated_at — a única forma
  // de testar o período mínimo de segurança sem esperar dias de verdade.
  await prisma.$executeRaw`
    UPDATE reservations SET updated_at = now() - (${opts.daysAgoClosed}::text || ' days')::interval WHERE id = ${id}::uuid
  `;

  return id;
}

async function cleanup() {
  const idRows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM reservations WHERE internal_note = ${PREFIX}
  `;
  const ids = idRows.map((r) => r.id);
  if (ids.length) {
    await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${ids}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE detail::text LIKE ${'%' + PREFIX + '%'}`;
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
}, 60_000);

describe('ReservationArchiveService — elegibilidade e proteção', () => {
  test('1) arquiva reserva cancelada antiga (encerrada há mais que o período mínimo)', async () => {
    const id = await createReservation({ status: 'cancelled', daysAgoClosed: 40 });
    const result = await archiveService.execute({ minSafetyDays: 30 }, 'LIMPAR HISTÓRICOS', `${PREFIX} teste 1`, ADMIN_USER_ID, 'Teste');
    expect(result.archivedIds).toContain(id);

    const row = await prisma.reservation.findUnique({ where: { id } });
    expect(row?.archivedAt).not.toBeNull();
    expect(row?.archivedBy).toBe(ADMIN_USER_ID);
    expect(row?.status).toBe('cancelled'); // arquivar nunca muda o status
  });

  test('2) arquiva reserva concluída/devolvida antiga (status "returned")', async () => {
    const id = await createReservation({ status: 'returned', daysAgoClosed: 45 });
    const result = await archiveService.execute({ onlyReturned: true, minSafetyDays: 30 }, 'LIMPAR HISTÓRICOS', `${PREFIX} teste 2`, ADMIN_USER_ID, 'Teste');
    expect(result.archivedIds).toContain(id);
  });

  test('3) NUNCA arquiva reserva futura (pickupDate ainda não chegou)', async () => {
    const id = await createReservation({ status: 'cancelled', daysAgoClosed: 40, pickupDaysFromToday: 60 });
    const preview = await archiveService.preview({ minSafetyDays: 30 });
    const sampleIds = preview.sample.map((s) => s.id);
    expect(sampleIds).not.toContain(id);

    await archiveService.execute({ minSafetyDays: 30 }, 'LIMPAR HISTÓRICOS', `${PREFIX} teste 3`, ADMIN_USER_ID, 'Teste');
    const row = await prisma.reservation.findUnique({ where: { id } });
    expect(row?.archivedAt).toBeNull();
  });

  test('4) NUNCA arquiva reserva ativa (status "confirmed")', async () => {
    const id = await createReservation({ status: 'confirmed', daysAgoClosed: 100 });
    await archiveService.execute({}, 'LIMPAR HISTÓRICOS', `${PREFIX} teste 4`, ADMIN_USER_ID, 'Teste');
    const row = await prisma.reservation.findUnique({ where: { id } });
    expect(row?.archivedAt).toBeNull();
  });

  test('5) NUNCA arquiva HOLD válido (status "hold")', async () => {
    const id = await createReservation({ status: 'hold', daysAgoClosed: 100 });
    await archiveService.execute({}, 'LIMPAR HISTÓRICOS', `${PREFIX} teste 5`, ADMIN_USER_ID, 'Teste');
    const row = await prisma.reservation.findUnique({ where: { id } });
    expect(row?.archivedAt).toBeNull();
  });

  test('6) NUNCA arquiva pagamento pendente (status "pending_payment")', async () => {
    const id = await createReservation({ status: 'pending_payment', daysAgoClosed: 100 });
    await archiveService.execute({}, 'LIMPAR HISTÓRICOS', `${PREFIX} teste 6`, ADMIN_USER_ID, 'Teste');
    const row = await prisma.reservation.findUnique({ where: { id } });
    expect(row?.archivedAt).toBeNull();
  });

  test('6b) NUNCA arquiva ocorrência operacional aberta (status "problem")', async () => {
    const id = await createReservation({ status: 'problem', daysAgoClosed: 100 });
    await archiveService.execute({}, 'LIMPAR HISTÓRICOS', `${PREFIX} teste 6b`, ADMIN_USER_ID, 'Teste');
    const row = await prisma.reservation.findUnique({ where: { id } });
    expect(row?.archivedAt).toBeNull();
  });

  test('7) respeita o período mínimo de segurança — encerrada há pouco NÃO é arquivada', async () => {
    const id = await createReservation({ status: 'cancelled', daysAgoClosed: 5 });
    await archiveService.execute({ minSafetyDays: 30 }, 'LIMPAR HISTÓRICOS', `${PREFIX} teste 7`, ADMIN_USER_ID, 'Teste');
    const row = await prisma.reservation.findUnique({ where: { id } });
    expect(row?.archivedAt).toBeNull();
  });

  test('8) preserva auditoria (ReservationEvent + AdminAuditEvent), itens e demais dados', async () => {
    const unitId = await createUnit();
    const id = await createReservation({ status: 'cancelled', daysAgoClosed: 40, unitId });

    const before = await prisma.reservation.findUnique({ where: { id } });
    await archiveService.execute({ minSafetyDays: 30 }, 'LIMPAR HISTÓRICOS', `${PREFIX} motivo-8`, ADMIN_USER_ID, 'Teste');

    const events = await prisma.reservationEvent.findMany({ where: { reservationId: id, type: 'RESERVATION_ARCHIVED' } });
    expect(events).toHaveLength(1);

    const item = await prisma.reservationItem.findFirst({ where: { reservationId: id } });
    expect(item?.status).toBe('cancelled'); // item nunca é tocado

    const after = await prisma.reservation.findUnique({ where: { id } });
    expect(after?.status).toBe(before?.status);
    expect(after?.pickupDate).toEqual(before?.pickupDate);
    expect(after?.returnDate).toEqual(before?.returnDate);
  });

  test('9) oculta arquivadas da listagem padrão', async () => {
    const id = await createReservation({ status: 'cancelled', daysAgoClosed: 40 });
    await archiveService.execute({ minSafetyDays: 30 }, 'LIMPAR HISTÓRICOS', `${PREFIX} teste 9`, ADMIN_USER_ID, 'Teste');

    const defaultList = await adminReservations.listReservations({ code: shortCode(id) });
    expect(defaultList.find((r) => r.id === id)).toBeUndefined();

    const withArchived = await adminReservations.listReservations({ code: shortCode(id), includeArchived: true });
    expect(withArchived.find((r) => r.id === id)).toBeDefined();
  });

  test('10) filtra e consulta arquivadas (archivedOnly + busca por código)', async () => {
    const id = await createReservation({ status: 'cancelled', daysAgoClosed: 40 });
    await archiveService.execute({ minSafetyDays: 30 }, 'LIMPAR HISTÓRICOS', `${PREFIX} teste 10`, ADMIN_USER_ID, 'Teste');

    const archivedOnly = await adminReservations.listReservations({ archivedOnly: true, code: shortCode(id) });
    expect(archivedOnly.map((r) => r.id)).toEqual([id]);
  });

  test('11) restaura reserva arquivada', async () => {
    const id = await createReservation({ status: 'cancelled', daysAgoClosed: 40 });
    await archiveService.execute({ minSafetyDays: 30 }, 'LIMPAR HISTÓRICOS', `${PREFIX} teste 11`, ADMIN_USER_ID, 'Teste');

    const restored = await archiveService.restore(id, ADMIN_USER_ID, 'Teste');
    expect(restored.status).toBe('cancelled');

    const row = await prisma.reservation.findUnique({ where: { id } });
    expect(row?.archivedAt).toBeNull();
    expect(row?.archivedBy).toBeNull();
    expect(row?.archiveReason).toBeNull();

    const events = await prisma.reservationEvent.findMany({ where: { reservationId: id, type: 'RESERVATION_RESTORED' } });
    expect(events).toHaveLength(1);
  });

  test('11b) restaurar reserva que não está arquivada falha (409)', async () => {
    const id = await createReservation({ status: 'cancelled', daysAgoClosed: 5 });
    await expect(archiveService.restore(id, ADMIN_USER_ID, 'Teste')).rejects.toMatchObject({ status: 409 });
  });

  test('12) RBAC — controller exige o papel ADMIN (SUPER_ADMIN não existe neste sistema)', async () => {
    const { REQUIRE_ROLE_KEY } = await import('../admin/require-role.decorator');
    const { ReservationArchiveController } = await import('./reservation-archive.controller');
    const role = Reflect.getMetadata(REQUIRE_ROLE_KEY, ReservationArchiveController);
    expect(role).toBe('ADMIN');
  });

  test('13) confirmação inválida não arquiva nada (rejeita antes de tocar o banco)', async () => {
    const id = await createReservation({ status: 'cancelled', daysAgoClosed: 40 });
    await expect(
      archiveService.execute({ minSafetyDays: 30 }, 'texto errado', `${PREFIX} teste 13`, ADMIN_USER_ID, 'Teste'),
    ).rejects.toMatchObject({ status: 400 });
    const row = await prisma.reservation.findUnique({ where: { id } });
    expect(row?.archivedAt).toBeNull();
  });

  test('14) operação duplicada é idempotente — rodar duas vezes não arquiva de novo nem duplica evento', async () => {
    const id = await createReservation({ status: 'cancelled', daysAgoClosed: 40 });
    const first = await archiveService.execute({ minSafetyDays: 30 }, 'LIMPAR HISTÓRICOS', `${PREFIX} teste 14a`, ADMIN_USER_ID, 'Teste');
    expect(first.archivedIds).toContain(id);

    const second = await archiveService.execute({ minSafetyDays: 30 }, 'LIMPAR HISTÓRICOS', `${PREFIX} teste 14b`, ADMIN_USER_ID, 'Teste');
    expect(second.archivedIds).not.toContain(id);

    const events = await prisma.reservationEvent.findMany({ where: { reservationId: id, type: 'RESERVATION_ARCHIVED' } });
    expect(events).toHaveLength(1);
  });

  test('15) concorrência — duas execuções simultâneas nunca arquivam a mesma reserva duas vezes', async () => {
    const id = await createReservation({ status: 'cancelled', daysAgoClosed: 40 });
    const [a, b] = await Promise.all([
      archiveService.execute({ minSafetyDays: 30 }, 'LIMPAR HISTÓRICOS', `${PREFIX} concorrencia-a`, ADMIN_USER_ID, 'Teste'),
      archiveService.execute({ minSafetyDays: 30 }, 'LIMPAR HISTÓRICOS', `${PREFIX} concorrencia-b`, ADMIN_USER_ID, 'Teste'),
    ]);
    const totalHits = (a.archivedIds.includes(id) ? 1 : 0) + (b.archivedIds.includes(id) ? 1 : 0);
    expect(totalHits).toBe(1);

    const events = await prisma.reservationEvent.findMany({ where: { reservationId: id, type: 'RESERVATION_ARCHIVED' } });
    expect(events).toHaveLength(1);
  });

  test('16) relatórios continuam funcionando e também ocultam arquivadas por padrão', async () => {
    const id = await createReservation({ status: 'cancelled', daysAgoClosed: 40 });
    await archiveService.execute({ minSafetyDays: 30 }, 'LIMPAR HISTÓRICOS', `${PREFIX} teste 16`, ADMIN_USER_ID, 'Teste');

    const report = await adminReservations.listReservationsForReport({ code: shortCode(id) }, 300);
    expect(report.find((r) => r.id === id)).toBeUndefined();

    const reportWithArchived = await adminReservations.listReservationsForReport({ code: shortCode(id), includeArchived: true }, 300);
    expect(reportWithArchived.find((r) => r.id === id)).toBeDefined();
  });

  test('17) disponibilidade não é alterada — item continua com o mesmo status após arquivar', async () => {
    const unitId = await createUnit();
    const id = await createReservation({ status: 'returned', daysAgoClosed: 40, unitId });
    await archiveService.execute({ onlyReturned: true, minSafetyDays: 30 }, 'LIMPAR HISTÓRICOS', `${PREFIX} teste 17`, ADMIN_USER_ID, 'Teste');

    const item = await prisma.reservationItem.findFirst({ where: { reservationId: id } });
    expect(item?.status).toBe('returned'); // OCCUPYING_RESERVATION_STATUSES nunca lê archivedAt
  });
});

describe('ReservationArchiveService — filtro "statuses" (ClosetAdmin: botão "Limpar lista")', () => {
  test('18) statuses: [expired, cancelled] arquiva as duas em uma única chamada, sem tocar "returned"', async () => {
    const expiredId = await createReservation({ status: 'expired', daysAgoClosed: 40 });
    const cancelledId = await createReservation({ status: 'cancelled', daysAgoClosed: 40 });
    const returnedId = await createReservation({ status: 'returned', daysAgoClosed: 40 });

    const result = await archiveService.execute(
      { statuses: ['expired', 'cancelled'], minSafetyDays: 30 },
      'LIMPAR HISTÓRICOS',
      `${PREFIX} teste 18`,
      ADMIN_USER_ID,
      'Teste',
    );
    expect(result.archivedIds).toContain(expiredId);
    expect(result.archivedIds).toContain(cancelledId);
    expect(result.archivedIds).not.toContain(returnedId);

    const expiredRow = await prisma.reservation.findUnique({ where: { id: expiredId } });
    const cancelledRow = await prisma.reservation.findUnique({ where: { id: cancelledId } });
    const returnedRow = await prisma.reservation.findUnique({ where: { id: returnedId } });
    expect(expiredRow?.archivedAt).not.toBeNull();
    expect(expiredRow?.status).toBe('expired'); // arquivar nunca muda o status
    expect(cancelledRow?.archivedAt).not.toBeNull();
    expect(cancelledRow?.status).toBe('cancelled');
    expect(returnedRow?.archivedAt).toBeNull(); // fora do conjunto pedido — não arquivada

    // Nenhuma linha foi excluída — as três reservas continuam existindo.
    expect(expiredRow).not.toBeNull();
    expect(cancelledRow).not.toBeNull();
    expect(returnedRow).not.toBeNull();
  });

  test('19) statuses: [expired, cancelled] continua protegendo ativas/pagamento pendente/ocorrência aberta', async () => {
    const pendingId = await createReservation({ status: 'pending_payment', daysAgoClosed: 100 });
    const problemId = await createReservation({ status: 'problem', daysAgoClosed: 100 });
    const confirmedId = await createReservation({ status: 'confirmed', daysAgoClosed: 100 });

    await archiveService.execute({ statuses: ['expired', 'cancelled'] }, 'LIMPAR HISTÓRICOS', `${PREFIX} teste 19`, ADMIN_USER_ID, 'Teste');

    const pendingRow = await prisma.reservation.findUnique({ where: { id: pendingId } });
    const problemRow = await prisma.reservation.findUnique({ where: { id: problemId } });
    const confirmedRow = await prisma.reservation.findUnique({ where: { id: confirmedId } });
    expect(pendingRow?.archivedAt).toBeNull();
    expect(pendingRow?.status).toBe('pending_payment');
    expect(problemRow?.archivedAt).toBeNull();
    expect(problemRow?.status).toBe('problem');
    expect(confirmedRow?.archivedAt).toBeNull();
    expect(confirmedRow?.status).toBe('confirmed');
  });

  test('20) restaurar depois de "Limpar lista" devolve a reserva à listagem sem alterar status/itens', async () => {
    const unitId = await createUnit();
    const id = await createReservation({ status: 'expired', daysAgoClosed: 40, unitId });
    const execResult = await archiveService.execute(
      { statuses: ['expired', 'cancelled'], minSafetyDays: 30 },
      'LIMPAR HISTÓRICOS',
      `${PREFIX} teste 20`,
      ADMIN_USER_ID,
      'Teste',
    );
    expect(execResult.archivedIds).toContain(id);

    const restored = await archiveService.restore(id, ADMIN_USER_ID, 'Teste');
    expect(restored.status).toBe('expired');

    const row = await prisma.reservation.findUnique({ where: { id } });
    expect(row?.archivedAt).toBeNull();
    expect(row?.status).toBe('expired');
    const item = await prisma.reservationItem.findFirst({ where: { reservationId: id } });
    expect(item?.status).toBe('expired');
  });
});

function shortCode(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}
