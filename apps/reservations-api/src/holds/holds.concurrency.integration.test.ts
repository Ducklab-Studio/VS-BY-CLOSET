import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { HoldsService } from './holds.service';
import { type CivilDate, addDays, civilDateToISO, isSunday } from '../rental-rules/civil-date';
import { calculateReturnDate, isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';
import type { CreateHoldDto } from './dto/create-hold.dto';

/**
 * Prova real de concorrência — item 17/18 da Fase 5. Sem mock de banco,
 * sem lock de aplicação: `Promise.all` dispara as chamadas de verdade em
 * paralelo contra o MESMO Neon que produção usa, e o teste verifica o que
 * o Postgres de fato decidiu (via `HoldsService.createHold`, não SQL
 * cru — é o caminho real que a API expõe).
 *
 * Os cenários 7, 8, 12, 13, 14, 15, 16, 17, 18, 19, 20 da lista de 22 já
 * são provados em holds.service.test.ts (não precisam de concorrência
 * real pra serem válidos — são sobre UM request, não dois). Os 10, 11,
 * 21, 22 exigem fault injection numa transação PARCIALMENTE aplicada
 * (uma corrida que o FOR UPDATE deste desenho justamente torna quase
 * impossível de reproduzir por timing real) — ver holds.retry.test.ts.
 * Este arquivo cobre só o que GENUINAMENTE precisa de paralelismo de
 * verdade pra provar algo: 1, 2, 3, 4, 5, 6, 9.
 */
const prisma = new PrismaService();
const rentalRuleConfig = new RentalRuleConfigService(prisma);
const service = new HoldsService(prisma, rentalRuleConfig);

const CFG = DEFAULT_RENTAL_RULE_CONFIG;
const SUFFIX = Date.now();
const PREFIX = `HOLD-CONC-${SUFFIX}`;

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

async function cleanup() {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id
    FROM reservation_items ri
    JOIN rental_units ru ON ru.id = ri.rental_unit_id
    WHERE ru.code LIKE ${PREFIX + '%'}
  `;
  const reservationIds = rows.map((r) => r.id);
  if (reservationIds.length) {
    await prisma.$executeRaw`DELETE FROM hold_idempotency_keys WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${reservationIds}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
}

/** Conta quantas reservation_items ativas (ocupando) existem pra uma
 *  variante — usado pra confirmar "nunca excedeu a capacidade física". */
async function occupiedCount(variantId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count
    FROM reservation_items ri
    JOIN rental_units ru ON ru.id = ri.rental_unit_id
    WHERE ru.shopify_variant_id = ${variantId}
      AND ri.status IN ('hold','pending_payment','confirmed','preparing','ready_for_pickup','picked_up','returned','cleaning','problem')
  `;
  return Number(rows[0].count);
}

function outcome<T>(settled: PromiseSettledResult<T>): 'fulfilled' | number {
  if (settled.status === 'fulfilled') return 'fulfilled';
  const err = settled.reason as { status?: number };
  return err.status ?? -1;
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('HoldsService — concorrência real (Neon, Promise.all)', () => {
  test('1) 1 unidade / 2 requests simultâneas → exatamente 1 sucesso', async () => {
    const variant = `${PREFIX}-1unit`;
    await prisma.rentalUnit.create({ data: { code: `${variant}-u1`, name: 'x', shopifyVariantId: variant, active: true, reservableOnline: true, countsTowardRentalDuration: true } });
    const pickup = pickupWithoutSundayReturn(2, 20);
    const dto: CreateHoldDto = { items: [{ shopifyVariantId: variant, quantity: 1 }], pickupDate: civilDateToISO(pickup), termsAccepted: true };

    const results = await Promise.allSettled([service.createHold(dto), service.createHold(dto)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(outcome(rejected[0])).toBe(409);
    expect(await occupiedCount(variant)).toBe(1);
  }, 20_000);

  test('2) 2 unidades / 2 requests pedindo 2 cada → exatamente 1 sucesso (a outra fica sem capacidade)', async () => {
    const variant = `${PREFIX}-2units-both2`;
    await prisma.rentalUnit.createMany({
      data: [
        { code: `${variant}-u1`, name: 'x', shopifyVariantId: variant, active: true, reservableOnline: true, countsTowardRentalDuration: true },
        { code: `${variant}-u2`, name: 'x', shopifyVariantId: variant, active: true, reservableOnline: true, countsTowardRentalDuration: true },
      ],
    });
    const pickup = pickupWithoutSundayReturn(2, 21);
    const dto: CreateHoldDto = { items: [{ shopifyVariantId: variant, quantity: 2 }], pickupDate: civilDateToISO(pickup), termsAccepted: true };

    const results = await Promise.allSettled([service.createHold(dto), service.createHold(dto)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(await occupiedCount(variant)).toBe(2); // nunca 3, nunca 4 — só as 2 que existem
  }, 20_000);

  test('3) 2 unidades / requests pedindo 1 cada → as duas têm sucesso, com unidades diferentes', async () => {
    const variant = `${PREFIX}-2units-both1`;
    await prisma.rentalUnit.createMany({
      data: [
        { code: `${variant}-u1`, name: 'x', shopifyVariantId: variant, active: true, reservableOnline: true, countsTowardRentalDuration: true },
        { code: `${variant}-u2`, name: 'x', shopifyVariantId: variant, active: true, reservableOnline: true, countsTowardRentalDuration: true },
      ],
    });
    const pickup = pickupWithoutSundayReturn(2, 22);
    const dto: CreateHoldDto = { items: [{ shopifyVariantId: variant, quantity: 1 }], pickupDate: civilDateToISO(pickup), termsAccepted: true };

    const [a, b] = await Promise.all([service.createHold(dto), service.createHold(dto)]);
    expect(a.reservationId).not.toBe(b.reservationId);
    expect(await occupiedCount(variant)).toBe(2);

    const units = await prisma.$queryRaw<{ rentalUnitId: string }[]>`
      SELECT DISTINCT rental_unit_id AS "rentalUnitId" FROM reservation_items
      WHERE reservation_id = ANY(${[a.reservationId, b.reservationId]}::uuid[])
    `;
    expect(units).toHaveLength(2); // unidades distintas, não a mesma duas vezes
  }, 20_000);

  test('4) 3 unidades / A pede 2, B pede 2 simultâneas → nunca excede capacidade 3 (uma das duas falha)', async () => {
    const variant = `${PREFIX}-3units`;
    await prisma.rentalUnit.createMany({
      data: [1, 2, 3].map((n) => ({ code: `${variant}-u${n}`, name: 'x', shopifyVariantId: variant, active: true, reservableOnline: true, countsTowardRentalDuration: true })),
    });
    const pickup = pickupWithoutSundayReturn(2, 23);
    const dto: CreateHoldDto = { items: [{ shopifyVariantId: variant, quantity: 2 }], pickupDate: civilDateToISO(pickup), termsAccepted: true };

    const results = await Promise.allSettled([service.createHold(dto), service.createHold(dto)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    // Com 3 unidades e 2 pedidos de 2, no MÁXIMO um pode ser satisfeito
    // por completo (2+2=4 > 3) — nunca os dois, e a alocação real nunca
    // ultrapassa 3 unidades ocupadas.
    expect(fulfilled.length).toBeLessThanOrEqual(1);
    const occupied = await occupiedCount(variant);
    expect(occupied).toBeLessThanOrEqual(3);
    expect(occupied).toBe(fulfilled.length * 2);
  }, 20_000);

  test('5) múltiplas variantes na mesma reserva, capacidade OK nas duas → tudo adquirido', async () => {
    const variantX = `${PREFIX}-multi-x`;
    const variantY = `${PREFIX}-multi-y`;
    await prisma.rentalUnit.createMany({
      data: [
        { code: `${variantX}-u1`, name: 'x', shopifyVariantId: variantX, active: true, reservableOnline: true, countsTowardRentalDuration: true },
        { code: `${variantY}-u1`, name: 'y', shopifyVariantId: variantY, active: true, reservableOnline: true, countsTowardRentalDuration: true },
      ],
    });
    const pickup = pickupWithoutSundayReturn(2, 24);
    const res = await service.createHold({
      items: [
        { shopifyVariantId: variantX, quantity: 1 },
        { shopifyVariantId: variantY, quantity: 1 },
      ],
      pickupDate: civilDateToISO(pickup),
      termsAccepted: true,
    });
    expect(res.items).toEqual(
      expect.arrayContaining([
        { shopifyVariantId: variantX, quantity: 1 },
        { shopifyVariantId: variantY, quantity: 1 },
      ]),
    );
    expect(await occupiedCount(variantX)).toBe(1);
    expect(await occupiedCount(variantY)).toBe(1);
  }, 20_000);

  test('6) conflito em uma das duas variantes → rollback da reserva INTEIRA (a outra variante, livre, continua livre)', async () => {
    const variantOk = `${PREFIX}-multi-ok`;
    const variantBusy = `${PREFIX}-multi-busy`;
    await prisma.rentalUnit.createMany({
      data: [
        { code: `${variantOk}-u1`, name: 'ok', shopifyVariantId: variantOk, active: true, reservableOnline: true, countsTowardRentalDuration: true },
        { code: `${variantBusy}-u1`, name: 'busy', shopifyVariantId: variantBusy, active: true, reservableOnline: true, countsTowardRentalDuration: true },
      ],
    });
    const pickup = pickupWithoutSundayReturn(2, 25);

    // Pré-ocupa a única unidade de variantBusy pro MESMO período — fixture
    // direto via SQL (não via HoldsService), simulando "já tinha outra
    // reserva ali".
    const busyUnit = await prisma.rentalUnit.findFirstOrThrow({ where: { shopifyVariantId: variantBusy } });
    const range = { blockedFrom: addDays(pickup, -CFG.prepDays), blockedUntilExclusive: addDays(calculateReturnDate(pickup, 2), CFG.cleaningDays + 1) };
    const [{ id: fixtureReservationId }] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO reservations (id, status, origin_store_id, pickup_date, return_date)
      VALUES (gen_random_uuid(), 'confirmed', 'dev-store', ${civilDateToISO(pickup)}::date, ${civilDateToISO(calculateReturnDate(pickup, 2))}::date)
      RETURNING id
    `;
    await prisma.$executeRaw`
      INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
      VALUES (gen_random_uuid(), ${fixtureReservationId}::uuid, ${busyUnit.id}::uuid, 'confirmed',
        daterange(${civilDateToISO(range.blockedFrom)}::date, ${civilDateToISO(range.blockedUntilExclusive)}::date, '[)'))
    `;

    await expect(
      service.createHold({
        items: [
          { shopifyVariantId: variantOk, quantity: 1 },
          { shopifyVariantId: variantBusy, quantity: 1 },
        ],
        pickupDate: civilDateToISO(pickup),
        termsAccepted: true,
      }),
    ).rejects.toMatchObject({ status: 409 });

    // A variante QUE ESTAVA livre continua livre — nada foi gravado pra
    // ela mesmo tendo capacidade de sobra. ALL OR NOTHING de verdade.
    expect(await occupiedCount(variantOk)).toBe(0);
  }, 20_000);

  test('9) duas requests tentando expirar o mesmo HOLD ao mesmo tempo → sem erro, e a unidade libera pra uma nova reserva', async () => {
    const variant = `${PREFIX}-expire-race`;
    await prisma.rentalUnit.create({ data: { code: `${variant}-u1`, name: 'x', shopifyVariantId: variant, active: true, reservableOnline: true, countsTowardRentalDuration: true } });
    const pickup = pickupWithoutSundayReturn(2, 26);

    const first = await service.createHold({ items: [{ shopifyVariantId: variant, quantity: 1 }], pickupDate: civilDateToISO(pickup), termsAccepted: true });
    await prisma.$executeRaw`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = ${first.reservationId}::uuid`;

    // Duas chamadas concorrentes, cada uma rodando a MESMA UPDATE de
    // expiração dentro da sua própria transação antes de alocar — nenhuma
    // das duas pode travar ou lançar um erro de SQL só por competirem
    // pela mesma linha.
    const dto: CreateHoldDto = { items: [{ shopifyVariantId: variant, quantity: 1 }], pickupDate: civilDateToISO(pickup), termsAccepted: true };
    const results = await Promise.allSettled([service.createHold(dto), service.createHold(dto)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1); // só existe 1 unidade — a expirada libera, mas continua sendo 1 só

    const firstAfter = await prisma.reservation.findUniqueOrThrow({ where: { id: first.reservationId } });
    expect(firstAfter.status).toBe('expired');
  }, 20_000);
});
