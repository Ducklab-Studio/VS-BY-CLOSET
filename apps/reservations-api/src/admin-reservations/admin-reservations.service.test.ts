import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { AdminReservationsService } from './admin-reservations.service';
import { type CivilDate, addDays, civilDateToISO, isSunday } from '../rental-rules/civil-date';
import { calculateReturnDate, isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';
import type { CreateManualReservationDto } from './dto/create-manual-reservation.dto';

/**
 * Integração real (Neon) — mesmo padrão de holds.service.test.ts, que
 * este arquivo reaproveita quase literalmente (`pickupSafe`/`futurePickup`
 * / `pickupWithoutSundayReturn`) porque testa o MESMO motor de regras,
 * só chamado por um serviço diferente.
 *
 * Para o teste de ACEITAÇÃO com override de antecedência (item
 * obrigatório desta fase), "aceitar com override" exige isolar a
 * antecedência de qualquer outra regra de data — o teste 3 abaixo garante
 * `operationStartDate = null` TEMPORARIAMENTE (restaurado em `finally`),
 * seguro porque a suíte roda sequencial (`fileParallelism: false`, ver
 * vitest.config.ts) — nada mais compete pela mesma linha
 * `rental_rule_config` enquanto isso.
 */
const prisma = new PrismaService();
const rentalRuleConfig = new RentalRuleConfigService(prisma);
const service = new AdminReservationsService(prisma, rentalRuleConfig);

const CFG = DEFAULT_RENTAL_RULE_CONFIG;
const PREFIX = `ADMIN-RES-${Date.now()}`;
let unitCounter = 0;

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
/** Só evita domingo (pickup e devolução) — usado exclusivamente no teste
 *  3, com a data de início da operação desligada de propósito. */
function pickupNearAvoidingSunday(durationDays: number, daysFromToday: number): CivilDate {
  let d = addDays(engineToday(CFG), daysFromToday);
  for (let i = 0; i < 30 && (isSunday(d) || isSunday(calculateReturnDate(d, durationDays))); i++) d = addDays(d, 1);
  return d;
}

async function createUnit(opts: { active?: boolean; reservableOnline?: boolean; countsTowardRentalDuration?: boolean } = {}): Promise<string> {
  const code = `${PREFIX}-u${unitCounter++}`;
  const unit = await prisma.rentalUnit.create({
    data: {
      code,
      name: 'peça de teste',
      shopifyVariantId: `${code}-variant`,
      active: opts.active ?? true,
      reservableOnline: opts.reservableOnline ?? true,
      countsTowardRentalDuration: opts.countsTowardRentalDuration ?? true,
    },
  });
  return unit.id;
}

function baseDto(overrides: Partial<CreateManualReservationDto> & { items: { rentalUnitId: string }[]; pickupDate: string }): CreateManualReservationDto {
  return {
    customerName: 'Cliente Teste',
    customerPhone: '+56 9 1234 5678',
    ...overrides,
  } as CreateManualReservationDto;
}

async function cleanup() {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id
    FROM reservation_items ri
    JOIN rental_units ru ON ru.id = ri.rental_unit_id
    WHERE ru.code LIKE ${PREFIX + '%'}
  `;
  const reservationIds = rows.map((r) => r.id);
  if (reservationIds.length) {
    await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM manual_reservation_idempotency_keys WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${reservationIds}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('AdminReservationsService — criação manual (integração real, Neon)', () => {
  test('1) criação manual normal → confirmed, source manual_admin, item ocupando, confirmedAt gravado', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 20);
    const res = await service.createManual(baseDto({ items: [{ rentalUnitId: unitId }], pickupDate: civilDateToISO(pickup) }));

    expect(res.status).toBe('confirmed');
    expect(res.source).toBe('manual_admin');
    expect(res.items).toEqual([{ rentalUnitId: unitId, code: expect.any(String) }]);
    expect(res.returnDate).toBe(civilDateToISO(addDays(pickup, 2))); // 1 peça contável → 2 dias, config real

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: res.reservationId } });
    expect(reservation.status).toBe('confirmed');
    expect(reservation.source).toBe('manual_admin');
    expect(reservation.customerName).toBe('Cliente Teste');
    expect(reservation.customerPhone).toBe('+56 9 1234 5678');
    expect(reservation.confirmedAt).not.toBeNull();

    const items = await prisma.$queryRaw<{ status: string }[]>`SELECT status FROM reservation_items WHERE reservation_id = ${res.reservationId}::uuid`;
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('confirmed');
  }, 15_000); // primeira query real do arquivo — conexão fria com o Neon fica perto do timeout padrão de 5s

  test('2) pickup <15 dias SEM override → 422, violations inclui pickup_before_minimum_advance', async () => {
    const unitId = await createUnit();
    const nearPickup = addDays(engineToday(CFG), 3);
    await expect(
      service.createManual(baseDto({ items: [{ rentalUnitId: unitId }], pickupDate: civilDateToISO(nearPickup), durationDays: 2 })),
    ).rejects.toMatchObject({ status: 422, response: { violations: expect.arrayContaining(['pickup_before_minimum_advance']) } });
  });

  test('3) pickup <15 dias COM override minLeadTime + motivo → aceita', async () => {
    const unitId = await createUnit();
    const original = await prisma.rentalRuleConfig.findUniqueOrThrow({ where: { id: 'default' } });
    // Isola a checagem de antecedência da data de início da operação (ver
    // comentário no topo do arquivo) — restaurado sempre, mesmo se o
    // teste falhar no meio.
    await prisma.rentalRuleConfig.update({ where: { id: 'default' }, data: { operationStartDate: null } });
    try {
      const pickup = pickupNearAvoidingSunday(2, 3);
      const res = await service.createManual(
        baseDto({
          items: [{ rentalUnitId: unitId }],
          pickupDate: civilDateToISO(pickup),
          durationDays: 2, // bate com o motor (1 peça → 2 dias) — isola só o override de antecedência
          overrides: { minLeadTime: true },
          overrideReason: 'Cliente VIP — reserva de última hora autorizada pela gerência.',
        }),
      );
      expect(res.status).toBe('confirmed');
      expect(res.overridesApplied).toContain('minLeadTime');
    } finally {
      await prisma.rentalRuleConfig.update({ where: { id: 'default' }, data: { operationStartDate: original.operationStartDate } });
    }
  });

  test('4) durationDays divergente do motor, SEM override → 422 (duration_mismatch_with_engine)', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 40);
    await expect(
      service.createManual(baseDto({ items: [{ rentalUnitId: unitId }], pickupDate: civilDateToISO(pickup), durationDays: 5 })), // motor calcularia 2
    ).rejects.toMatchObject({ status: 422, response: { violations: ['duration_mismatch_with_engine'] } });
  });

  test('5) durationDays divergente COM override customDuration + motivo → aceita, usa a data informada', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 41);
    const res = await service.createManual(
      baseDto({
        items: [{ rentalUnitId: unitId }],
        pickupDate: civilDateToISO(pickup),
        durationDays: 5,
        overrides: { customDuration: true },
        overrideReason: 'Cliente estendeu o período por acordo verbal com a loja.',
      }),
    );
    expect(res.status).toBe('confirmed');
    expect(res.returnDate).toBe(civilDateToISO(addDays(pickup, 5)));
    expect(res.overridesApplied).toContain('customDuration');
  });

  test('6) override presente SEM overrideReason → 400, rejeitado antes de qualquer checagem de regra', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 42);
    await expect(
      service.createManual(baseDto({ items: [{ rentalUnitId: unitId }], pickupDate: civilDateToISO(pickup), durationDays: 5, overrides: { customDuration: true } })),
    ).rejects.toMatchObject({ status: 400 });
  });

  test('7) double booking — mesma peça, mesmo período → 409, EXCLUDE constraint como backstop', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 43);
    const first = await service.createManual(baseDto({ items: [{ rentalUnitId: unitId }], pickupDate: civilDateToISO(pickup) }));
    expect(first.status).toBe('confirmed');

    await expect(service.createManual(baseDto({ items: [{ rentalUnitId: unitId }], pickupDate: civilDateToISO(pickup) }))).rejects.toMatchObject({ status: 409 });
  });

  test('8) concorrência real — duas requisições simultâneas pela MESMA peça → exatamente 1 sucesso', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 44);
    const makeDto = () => baseDto({ items: [{ rentalUnitId: unitId }], pickupDate: civilDateToISO(pickup) });
    const results = await Promise.allSettled([service.createManual(makeDto()), service.createManual(makeDto())]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  }, 20_000);

  test('9) RentalUnit inativa → 422, nada é inserido', async () => {
    const unitId = await createUnit({ active: false });
    const pickup = pickupWithoutSundayReturn(2, 45);
    await expect(
      service.createManual(baseDto({ items: [{ rentalUnitId: unitId }], pickupDate: civilDateToISO(pickup) })),
    ).rejects.toMatchObject({ status: 422, response: { invalidUnitIds: [unitId] } });

    const count = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM reservation_items WHERE rental_unit_id = ${unitId}::uuid`;
    expect(Number(count[0].count)).toBe(0);
  });

  test('10) datas inválidas — pickupDate >= returnDate → 422', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 46);
    await expect(
      service.createManual(baseDto({ items: [{ rentalUnitId: unitId }], pickupDate: civilDateToISO(pickup), returnDate: civilDateToISO(pickup) })),
    ).rejects.toMatchObject({ status: 422, response: { violations: ['pickup_not_before_return'] } });
  });

  test('14) rollback transacional — uma peça inválida entre várias → NADA é inserido, nem pra peça válida', async () => {
    const validUnit = await createUnit();
    const invalidUnit = await createUnit({ active: false });
    const pickup = pickupWithoutSundayReturn(2, 51);
    await expect(
      service.createManual(baseDto({ items: [{ rentalUnitId: validUnit }, { rentalUnitId: invalidUnit }], pickupDate: civilDateToISO(pickup) })),
    ).rejects.toMatchObject({ status: 422 });

    const count = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM reservation_items WHERE rental_unit_id = ${validUnit}::uuid`;
    expect(Number(count[0].count)).toBe(0);
  });

  test('15) acessório (reservableOnline=false) reservado manualmente → funciona, reservableOnline nunca é alterado no banco', async () => {
    const accessoryUnit = await createUnit({ reservableOnline: false, countsTowardRentalDuration: false });
    const normalUnit = await createUnit(); // >=1 peça contável, senão o motor não calcula duração
    const pickup = pickupWithoutSundayReturn(2, 52);
    const res = await service.createManual(baseDto({ items: [{ rentalUnitId: accessoryUnit }, { rentalUnitId: normalUnit }], pickupDate: civilDateToISO(pickup) }));

    expect(res.status).toBe('confirmed');
    expect(res.items.map((i) => i.rentalUnitId).sort()).toEqual([accessoryUnit, normalUnit].sort());

    const unit = await prisma.rentalUnit.findUniqueOrThrow({ where: { id: accessoryUnit } });
    expect(unit.reservableOnline).toBe(false); // nunca tocado — item 8 da Fase 8
  });

  test('16) peça com countsTowardRentalDuration=false não altera a duração calculada', async () => {
    const countable = await createUnit();
    const nonCountable = await createUnit({ countsTowardRentalDuration: false });
    const pickup = pickupWithoutSundayReturn(2, 53); // 1 peça contável → 2 dias
    const res = await service.createManual(baseDto({ items: [{ rentalUnitId: countable }, { rentalUnitId: nonCountable }], pickupDate: civilDateToISO(pickup) }));
    expect(res.returnDate).toBe(civilDateToISO(addDays(pickup, 2))); // como se só a peça contável existisse
  });

  test('17) reserva manual nunca cria cart/order Shopify — nenhum campo de checkout é preenchido', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 54);
    const res = await service.createManual(baseDto({ items: [{ rentalUnitId: unitId }], pickupDate: civilDateToISO(pickup) }));
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: res.reservationId } });
    expect(reservation.shopifyCartId).toBeNull();
    expect(reservation.shopifyOrderId).toBeNull();
    expect(reservation.shopifyOrderGid).toBeNull();
    expect(reservation.checkoutState).toBe('none');
    expect(reservation.holdTokenHash).toBeNull();
    expect(reservation.reservationBindingId).toBeNull();
  });

  test('13) Idempotency-Key repetida com o MESMO payload → devolve a MESMA reserva, não duplica', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 55);
    const key = `${PREFIX}-idem-1`;
    const dto = baseDto({ items: [{ rentalUnitId: unitId }], pickupDate: civilDateToISO(pickup) });

    const first = await service.createManual(dto, key);
    const second = await service.createManual(dto, key);
    expect(second.reservationId).toBe(first.reservationId);

    const keyCount = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM manual_reservation_idempotency_keys WHERE key = ${key}`;
    expect(Number(keyCount[0].count)).toBe(1);
    const reservationCount = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM reservations WHERE id = ${first.reservationId}::uuid`;
    expect(Number(reservationCount[0].count)).toBe(1);
  }, 15_000);

  test('Idempotency-Key repetida com payload DIFERENTE → 409', async () => {
    const unitA = await createUnit();
    const unitB = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 56);
    const key = `${PREFIX}-idem-2`;
    await service.createManual(baseDto({ items: [{ rentalUnitId: unitA }], pickupDate: civilDateToISO(pickup) }), key);
    await expect(service.createManual(baseDto({ items: [{ rentalUnitId: unitB }], pickupDate: civilDateToISO(pickup) }), key)).rejects.toMatchObject({ status: 409 });
  });
});

describe('AdminReservationsService — cancelamento manual (integração real, Neon)', () => {
  test('11) cancelamento manual — libera a unidade, ReservationEvent registrado, peça reservável de novo', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 60);
    const created = await service.createManual(baseDto({ items: [{ rentalUnitId: unitId }], pickupDate: civilDateToISO(pickup) }));

    const res = await service.cancelManual(created.reservationId, { reason: 'Cliente desistiu.' });
    expect(res.status).toBe('cancelled');

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: created.reservationId } });
    expect(reservation.status).toBe('cancelled');

    const items = await prisma.$queryRaw<{ status: string }[]>`SELECT status FROM reservation_items WHERE reservation_id = ${created.reservationId}::uuid`;
    expect(items.every((i) => i.status === 'cancelled')).toBe(true); // trigger propaga, nunca escrito direto

    const events = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM reservation_events WHERE reservation_id = ${created.reservationId}::uuid AND type = 'MANUAL_RESERVATION_CANCELLED'
    `;
    expect(Number(events[0].count)).toBe(1);

    // A mesma peça, mesmo período, volta a ser reservável.
    const second = await service.createManual(baseDto({ items: [{ rentalUnitId: unitId }], pickupDate: civilDateToISO(pickup) }));
    expect(second.status).toBe('confirmed');
  }, 20_000); // primeira query real deste describe (conexão fria) + várias idas ao Neon em sequência

  test('cancelar reserva já cancelada → idempotente, não é erro', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 61);
    const created = await service.createManual(baseDto({ items: [{ rentalUnitId: unitId }], pickupDate: civilDateToISO(pickup) }));
    await service.cancelManual(created.reservationId, {});
    const res = await service.cancelManual(created.reservationId, {});
    expect(res.status).toBe('cancelled');
  });

  test('12) reserva ONLINE (source=online) → 409, este endpoint não cancela pedido online', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 62);
    const [{ id: reservationId }] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO reservations (id, status, source, origin_store_id, pickup_date, return_date)
      VALUES (gen_random_uuid(), 'confirmed', 'online', 'dev-store', ${civilDateToISO(pickup)}::date, ${civilDateToISO(addDays(pickup, 2))}::date)
      RETURNING id
    `;
    await prisma.$executeRaw`
      INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
      VALUES (gen_random_uuid(), ${reservationId}::uuid, ${unitId}::uuid, 'confirmed', daterange(${civilDateToISO(addDays(pickup, -3))}::date, ${civilDateToISO(addDays(pickup, 5))}::date, '[)'))
    `;

    await expect(service.cancelManual(reservationId, {})).rejects.toMatchObject({ status: 409 });

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    expect(reservation.status).toBe('confirmed'); // não mudou
  });

  test('reserva inexistente → 404', async () => {
    await expect(service.cancelManual('00000000-0000-0000-0000-000000000000', {})).rejects.toMatchObject({ status: 404 });
  });

  test('id malformado → 400, nunca chega a consultar o banco', async () => {
    await expect(service.cancelManual('not-a-uuid', {})).rejects.toMatchObject({ status: 400 });
  });
});
