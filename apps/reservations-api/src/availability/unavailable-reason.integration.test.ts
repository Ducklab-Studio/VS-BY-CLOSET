import { ConflictException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { HoldsService } from '../holds/holds.service';
import { addDays, civilDateToISO, isSunday, type CivilDate } from '../rental-rules/civil-date';
import { AvailabilityService } from './availability.service';
import { reasonMessage, type OccupationKind } from './unavailable-reason';

/**
 * Motivo real da indisponibilidade (integração no banco de teste): a API do
 * ClosetAdmin diz POR QUE a peça não pode ser alugada — outra reserva, HOLD,
 * preparação/limpeza ou bloqueio — na disponibilidade e no HOLD do checkout,
 * sem nunca expor dados da outra cliente e sem mexer nas reservas existentes.
 */
const prisma = new PrismaService();
const rules = new RentalRuleConfigService(prisma);
const availability = new AvailabilityService(prisma, rules);
const holds = new HoldsService(prisma, rules);
const PREFIX = `REASON-${Date.now()}`;
const SECRET = { name: `Maria Segredo ${PREFIX}`, phone: '+56 9 8765 4321', email: `segredo-${PREFIX}@example.com` };
let unitCounter = 0;
let orderCounter = 0;
let adminUserId: string | null = null;

const nonSunday = (d: CivilDate): CivilDate => (isSunday(d) ? addDays(d, 1) : d);
const P = nonSunday({ year: 2027, month: 6, day: 16 });
let config: Awaited<ReturnType<RentalRuleConfigService['load']>>;

async function unit(variant: string) {
  const code = `${PREFIX}-u${unitCounter++}`;
  return prisma.rentalUnit.create({ data: { code, name: 'peça de teste', shopifyVariantId: variant, active: true, reservableOnline: true, countsTowardRentalDuration: true } });
}
const variant = (name: string) => `${PREFIX}-${name}`;

/** Reserva de OUTRA cliente ocupando a unidade no período [pickup, ret] (+ folgas da regra). */
async function occupy(unitId: string, status: string, pickup: CivilDate, ret: CivilDate) {
  const blockedFrom = addDays(pickup, -config.prepDays);
  const blockedUntil = addDays(ret, config.cleaningDays + 1);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservations (id, status, source, origin_store_id, pickup_date, return_date, shopify_order_id, customer_name, customer_phone, customer_email, expires_at)
    VALUES (gen_random_uuid(), ${status}::"reservation_status", 'online', 'dev-store', ${civilDateToISO(pickup)}::date, ${civilDateToISO(ret)}::date,
      ${`${PREFIX}-order-${orderCounter++}`}, ${SECRET.name}, ${SECRET.phone}, ${SECRET.email}, now() + interval '1 day')
    RETURNING id`;
  await prisma.$executeRaw`
    INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
    VALUES (gen_random_uuid(), ${rows[0].id}::uuid, ${unitId}::uuid, ${status}::"reservation_status",
      daterange(${civilDateToISO(blockedFrom)}::date, ${civilDateToISO(blockedUntil)}::date, '[)'))`;
  return rows[0].id;
}

async function dayFor(v: string, pickup: CivilDate = P, countedPieces = 1) {
  const res = await availability.getAvailability({ shopifyVariantId: v, countedPieces, from: civilDateToISO(pickup), to: civilDateToISO(pickup) });
  return { res, day: res.days[0] };
}

async function holdConflict(items: { shopifyVariantId: string; quantity: number }[], pickup: CivilDate = P) {
  try {
    await holds.createHold({ items, pickupDate: civilDateToISO(pickup), termsAccepted: true });
  } catch (err) {
    if (err instanceof ConflictException) return err.getResponse() as { message: string; reason: OccupationKind | null; reasons: OccupationKind[]; unavailableVariantIds: string[] };
    throw err;
  }
  throw new Error('o HOLD deveria ter sido recusado');
}

async function cleanup() {
  const units = await prisma.rentalUnit.findMany({ where: { code: { startsWith: PREFIX } }, select: { id: true } });
  const unitIds = units.map((u) => u.id);
  if (unitIds.length) {
    const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT DISTINCT reservation_id AS id FROM reservation_items WHERE rental_unit_id = ANY(${unitIds}::uuid[])`;
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${ids}::uuid[])`;
      await prisma.$executeRaw`DELETE FROM hold_idempotency_keys WHERE reservation_id = ANY(${ids}::uuid[])`;
      await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${ids}::uuid[])`;
      await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${ids}::uuid[])`;
    }
    await prisma.$executeRaw`DELETE FROM operational_blocks WHERE rental_unit_id = ANY(${unitIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM rental_units WHERE id = ANY(${unitIds}::uuid[])`;
  }
  if (adminUserId) {
    await prisma.$executeRaw`DELETE FROM operational_blocks WHERE created_by_admin_user_id = ${adminUserId}::uuid`;
    await prisma.adminUser.delete({ where: { id: adminUserId } }).catch(() => undefined);
  }
}

beforeAll(async () => {
  config = await rules.load();
}, 30_000);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
}, 60_000);

describe('Motivo real de indisponibilidade (API do ClosetAdmin)', () => {
  test('peça ocupada por reserva confirmada → "reserved", com a mensagem certa', async () => {
    const u = await unit(variant('confirmada'));
    await occupy(u.id, 'confirmed', addDays(P, -1), addDays(P, 5));
    const { day } = await dayFor(variant('confirmada'));
    expect([day.bookable, day.reason, day.unavailableReason, day.unavailableReasons]).toEqual([false, 'no_units_available', 'reserved', ['reserved']]);
    expect(reasonMessage(day.unavailableReason)).toBe('Esta peça já está alugada para outra reserva nesse período.');
  });

  test('peça ocupada por HOLD ou por pagamento pendente → "held"', async () => {
    for (const status of ['hold', 'pending_payment']) {
      const u = await unit(variant(`held-${status}`));
      await occupy(u.id, status, addDays(P, -1), addDays(P, 5));
      const { day } = await dayFor(variant(`held-${status}`));
      expect([day.bookable, day.unavailableReason]).toEqual([false, 'held']);
    }
    expect(reasonMessage('held')).toBe('Esta peça está temporariamente reservada. Tente outra data.');
  });

  test('peça bloqueada para limpeza (devolvida/higienizando), por bloqueio operacional ou só pela folga de limpeza de outra reserva → preparação/limpeza', async () => {
    const cleaning = await unit(variant('limpeza'));
    await occupy(cleaning.id, 'cleaning', addDays(P, -30), addDays(P, -27));
    expect((await dayFor(variant('limpeza'))).day.unavailableReason).toBe('preparation');

    const blocked = await unit(variant('bloqueio'));
    const admin = await prisma.adminUser.create({ data: { name: `Admin ${PREFIX}`, phone: `${Date.now()}9`, pinHash: 'synthetic', role: 'ADMIN', moduleAccess: [] } });
    adminUserId = admin.id;
    await prisma.$executeRaw`
      INSERT INTO operational_blocks (scope, rental_unit_id, start_date, end_date, reason, created_by_admin_user_id)
      VALUES ('UNIT', ${blocked.id}::uuid, ${civilDateToISO(addDays(P, -2))}::date, ${civilDateToISO(addDays(P, 2))}::date, 'Costura interna — texto da equipe', ${admin.id}::uuid)`;
    const blockedDay = await dayFor(variant('bloqueio'));
    expect(blockedDay.day.unavailableReason).toBe('operational_block');
    expect(JSON.stringify(blockedDay.res)).not.toContain('Costura interna');
    expect(reasonMessage('operational_block')).toBe('Esta peça está indisponível para esta data devido ao período de preparação/limpeza.');

    // Folga: a outra reserva devolve em R; a nossa retirada fica depois da devolução dela,
    // mas o nosso período encosta na limpeza dela (não no aluguel).
    if (config.cleaningDays >= 1) {
      const buffer = await unit(variant('folga'));
      const R = addDays(P, -config.prepDays - 1);
      await occupy(buffer.id, 'confirmed', addDays(R, -3), R);
      const { day } = await dayFor(variant('folga'));
      expect([day.bookable, day.unavailableReason]).toEqual([false, 'preparation']);
    }
  });

  test('várias unidades: todas ocupadas por motivos diferentes → motivo prioritário + os demais; uma livre → disponível', async () => {
    const a = await unit(variant('duas'));
    const b = await unit(variant('duas'));
    await occupy(a.id, 'hold', addDays(P, -1), addDays(P, 5));
    await occupy(b.id, 'confirmed', addDays(P, -1), addDays(P, 5));
    const { day } = await dayFor(variant('duas'));
    expect([day.bookable, day.unavailableReason, day.unavailableReasons]).toEqual([false, 'reserved', ['reserved', 'held']]);

    const c = await unit(variant('uma-livre'));
    await unit(variant('uma-livre'));
    await occupy(c.id, 'confirmed', addDays(P, -1), addDays(P, 5));
    const free = await dayFor(variant('uma-livre'));
    expect([free.day.bookable, free.day.quantityAvailable, free.day.unavailableReason]).toEqual([true, 1, undefined]);
  });

  test('nenhuma informação da outra cliente sai na disponibilidade nem no HOLD', async () => {
    const { res } = await dayFor(variant('confirmada'));
    const conflict = await holdConflict([{ shopifyVariantId: variant('confirmada'), quantity: 1 }]);
    const reservations = await prisma.reservation.findMany({ where: { customerName: SECRET.name }, select: { id: true } });
    const units = await prisma.rentalUnit.findMany({ where: { code: { startsWith: PREFIX } }, select: { id: true, code: true } });
    for (const payload of [JSON.stringify(res), JSON.stringify(conflict)]) {
      for (const secret of [SECRET.name, 'Maria', SECRET.phone, SECRET.email, ...reservations.map((r) => r.id), ...units.flatMap((u) => [u.id, u.code])]) {
        expect(payload).not.toContain(secret);
      }
    }
  });

  test('HOLD do checkout faz a mesma validação: recusa com o motivo real e diz QUAL peça', async () => {
    const reserved = await holdConflict([{ shopifyVariantId: variant('confirmada'), quantity: 1 }]);
    expect([reserved.reason, reserved.message, reserved.unavailableVariantIds]).toEqual(['reserved', reasonMessage('reserved'), [variant('confirmada')]]);
    expect((await holdConflict([{ shopifyVariantId: variant('held-hold'), quantity: 1 }])).reason).toBe('held');
    expect((await holdConflict([{ shopifyVariantId: variant('bloqueio'), quantity: 1 }])).reason).toBe('operational_block');

    // Várias peças, só uma indisponível: nada é reservado e só ela é apontada.
    const free = await unit(variant('livre-para-par'));
    const before = await prisma.reservation.count();
    const pair = await holdConflict([
      { shopifyVariantId: variant('livre-para-par'), quantity: 1 },
      { shopifyVariantId: variant('held-pending_payment'), quantity: 1 },
    ]);
    expect([pair.reason, pair.unavailableVariantIds]).toEqual(['held', [variant('held-pending_payment')]]);
    expect(await prisma.reservation.count()).toBe(before);
    expect(await prisma.reservationItem.count({ where: { rentalUnitId: free.id } })).toBe(0);
  });

  test('peça que fica indisponível depois de aparecer livre: disponibilidade e HOLD passam a recusar, sem mexer na reserva que ocupou', async () => {
    const u = await unit(variant('depois'));
    expect((await dayFor(variant('depois'))).day.bookable).toBe(true);
    const otherId = await occupy(u.id, 'confirmed', addDays(P, -1), addDays(P, 5));
    const before = await prisma.reservation.findUniqueOrThrow({ where: { id: otherId } });
    const { day } = await dayFor(variant('depois'));
    expect([day.bookable, day.unavailableReason]).toEqual([false, 'reserved']);
    expect((await holdConflict([{ shopifyVariantId: variant('depois'), quantity: 1 }])).reason).toBe('reserved');
    const after = await prisma.reservation.findUniqueOrThrow({ where: { id: otherId } });
    expect(after).toEqual(before);
    expect(await prisma.reservationItem.count({ where: { rentalUnitId: u.id } })).toBe(1);
  });
});
