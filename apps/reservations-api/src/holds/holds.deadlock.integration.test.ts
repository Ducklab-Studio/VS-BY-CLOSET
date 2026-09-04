import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { HoldsService } from './holds.service';
import { type CivilDate, addDays, civilDateToISO, isSunday } from '../rental-rules/civil-date';
import { calculateReturnDate, isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';

/**
 * Preflight da Fase 6, item 0 — prova real, não suposição.
 *
 * Cenário clássico de deadlock AB-BA: Request A pede [Variant X, Variant
 * Y] nessa ordem no payload; Request B pede [Variant Y, Variant X] — a
 * ordem INVERTIDA. Se o lock fosse adquirido na ordem em que o CLIENTE
 * listou os itens, A travaria X depois esperaria Y (que B já tem), e B
 * travaria Y depois esperaria X (que A já tem) — deadlock clássico.
 *
 * holds.service.ts nunca trava na ordem do payload: `normalizeItems()`
 * ordena os itens alfabeticamente por shopifyVariantId ANTES de montar
 * `variantIds`, e o loop de FOR UPDATE (ver o comentário em
 * holds.service.ts, seção "Preflight da Fase 6") trava variante por
 * variante nessa ordem fixa — então A e B, mesmo com payloads em ordem
 * diferente, travam SEMPRE na mesma ordem global (X antes de Y). Rodado
 * muitas vezes em rajada pra não depender de uma coincidência de timing.
 */
const prisma = new PrismaService();
const rentalRuleConfig = new RentalRuleConfigService(prisma);
const service = new HoldsService(prisma, rentalRuleConfig);

const CFG = DEFAULT_RENTAL_RULE_CONFIG;
const SUFFIX = Date.now();
const PREFIX = `HOLD-DEADLOCK-${SUFFIX}`;
const VARIANT_X = `${PREFIX}-x`; // "x" < "y" alfabeticamente
const VARIANT_Y = `${PREFIX}-y`;

function pickupSafe(date: CivilDate): CivilDate {
  let d = date;
  for (let i = 0; i < 400 && (!isOnlineReservationAllowed(d, CFG) || isSunday(d)); i++) d = addDays(d, 1);
  return d;
}
function pickupWithoutSundayReturnFrom(seed: CivilDate, durationDays: number): CivilDate {
  let d = pickupSafe(seed);
  for (let i = 0; i < 400 && isSunday(calculateReturnDate(d, durationDays)); i++) d = pickupSafe(addDays(d, 1));
  return d;
}

/**
 * Avança a PARTIR do resultado real da rodada anterior (não de um offset
 * fixo em relação a "hoje") — `pickupSafe` pode empurrar uma data pra
 * bem longe se ela cair na temporada bloqueada (jun-set), e dois offsets
 * fixos "distantes" (ex.: +280 e +300 dias) podem colapsar quase no
 * MESMO dia depois do ajuste, se os dois caírem dentro do bloqueio e
 * forem empurrados pro mesmo pós-bloqueio. Foi exatamente isso que
 * quebrou a primeira versão deste teste (rodadas 4 e 5 colidindo em
 * 02/10). Partir sempre do fim da rodada anterior +20 dias garante
 * separação real, não só nominal.
 */
function nextRoundPickup(previous: CivilDate | null, durationDays: number): CivilDate {
  const seed = previous ? addDays(previous, 20) : addDays(engineToday(CFG), 200);
  return pickupWithoutSundayReturnFrom(seed, durationDays);
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

beforeAll(async () => {
  await cleanup();
  await prisma.rentalUnit.createMany({
    data: [
      { code: `${PREFIX}-x-1`, name: 'x', shopifyVariantId: VARIANT_X, active: true, reservableOnline: true, countsTowardRentalDuration: true },
      { code: `${PREFIX}-y-1`, name: 'y', shopifyVariantId: VARIANT_Y, active: true, reservableOnline: true, countsTowardRentalDuration: true },
    ],
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('HoldsService — ordem de lock entre variantes (preflight anti-deadlock da Fase 6)', () => {
  test('20 rajadas de A=[X,Y] vs B=[Y,X] simultâneos → nunca um erro de deadlock (40P01), sempre 1 sucesso + 1 conflito de capacidade', async () => {
    const ROUNDS = 20;
    let previousPickup: CivilDate | null = null;
    for (let round = 0; round < ROUNDS; round++) {
      const pickup = nextRoundPickup(previousPickup, 2);
      previousPickup = pickup;
      const dtoAB = {
        items: [
          { shopifyVariantId: VARIANT_X, quantity: 1 },
          { shopifyVariantId: VARIANT_Y, quantity: 1 },
        ],
        pickupDate: civilDateToISO(pickup),
        termsAccepted: true,
      };
      const dtoBA = {
        items: [
          { shopifyVariantId: VARIANT_Y, quantity: 1 },
          { shopifyVariantId: VARIANT_X, quantity: 1 },
        ],
        pickupDate: civilDateToISO(pickup),
        termsAccepted: true,
      };

      const results = await Promise.allSettled([service.createHold(dtoAB), service.createHold(dtoBA)]);

      for (const r of results) {
        if (r.status === 'rejected') {
          const message = String((r.reason as { message?: string })?.message ?? r.reason);
          expect(message).not.toMatch(/deadlock detected/i);
        }
      }

      // As duas pedem a MESMA capacidade (1 unidade de X + 1 de Y, e só
      // existe 1 de cada) — só uma pode vencer; a outra fica sem
      // capacidade (409), nunca deadlock (que apareceria como erro 500
      // vindo do driver, não como ConflictException).
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      if (fulfilled.length !== 1) {
        console.log('raw results:', JSON.stringify(results.map((r) => (r.status === 'fulfilled' ? { status: 'fulfilled', value: r.value } : { status: 'rejected', message: (r.reason as { message?: string })?.message }))));
        const state = await prisma.$queryRaw<{ code: string; status: string; reservationId: string }[]>`
          SELECT ru.code, ri.status, ri.reservation_id AS "reservationId"
          FROM rental_units ru LEFT JOIN reservation_items ri ON ri.rental_unit_id = ru.id
          WHERE ru.code LIKE ${PREFIX + '%'}
        `;
        console.log('db state:', JSON.stringify(state));
        console.log('pickup:', civilDateToISO(pickup));
      }
      expect(fulfilled).toHaveLength(1);
    }
  }, 90_000);
});
