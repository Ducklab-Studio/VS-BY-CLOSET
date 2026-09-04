import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { AvailabilityService } from './availability.service';
import {
  type CivilDate,
  addDays,
  civilDateFromISO,
  civilDateToISO,
  isSunday,
} from '../rental-rules/civil-date';
import {
  type BlockedRange,
  calculateBlockedRange,
  calculateReturnDate,
  isOnlineReservationAllowed,
  today as engineToday,
} from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';

/**
 * Teste de integração contra o Neon real (mesmo banco do resto do
 * projeto) — não é mock. Cria seus próprios fixtures com prefixo
 * `AVAIL-` e limpa tudo no início e no fim, idempotente (roda de novo
 * sem colidir mesmo se uma limpeza anterior falhou no meio).
 */

const prisma = new PrismaService();
const rentalRuleConfig = new RentalRuleConfigService(prisma);
const service = new AvailabilityService(prisma, rentalRuleConfig);

const STORE_ID = 'avail-test-store';
const CFG = DEFAULT_RENTAL_RULE_CONFIG;
const SUFFIX = Date.now();

const VARIANT_FREE = `avail-test-free-${SUFFIX}`;
const VARIANT_PAIR = `avail-test-pair-${SUFFIX}`;
const VARIANT_INACTIVE = `avail-test-inactive-${SUFFIX}`;
const VARIANT_ACCESSORY = `avail-test-accessory-${SUFFIX}`;
const VARIANT_MISSING = `avail-test-missing-${SUFFIX}`;
const VARIANT_OVERLAP = `avail-test-overlap-${SUFFIX}`;

/**
 * Primeiro dia, a partir de hoje + N dias, que NÃO cai na temporada
 * bloqueada (jun-set) — nunca chuta uma data absoluta. Necessário porque
 * a data de "hoje" desta sessão (03/09/2026) está ELA MESMA dentro do
 * bloqueio de temporada; qualquer offset pequeno a partir de hoje
 * também cairia lá dentro sem este ajuste.
 */
/**
 * Empurra a data até ela ser uma retirada normalmente válida: fora da
 * temporada bloqueada E não-domingo. As duas condições, não só uma —
 * foi exatamente esquecer a segunda que gerou um falso-negativo aqui:
 * `pairPickup` caiu num domingo de verdade (22/11/2026) e o motor
 * corretamente rejeitou por `pickup_is_sunday`, mascarando o teste de
 * ocupação que eu queria fazer.
 */
function pickupSafe(date: CivilDate): CivilDate {
  let d = date;
  for (let i = 0; i < 400 && (!isOnlineReservationAllowed(d, CFG) || isSunday(d)); i++) d = addDays(d, 1);
  return d;
}

function futurePickup(daysFromToday: number): CivilDate {
  return pickupSafe(addDays(engineToday(CFG), daysFromToday));
}

let existingPickup: CivilDate;
let existingBlocked: BlockedRange;
let pairPickup: CivilDate;
let pairUnitIds: string[];

beforeAll(async () => {
  await cleanup();

  // ── Fixtures VELHOS da Fase 1 (formato antigo, sku como PK) ──
  // br-test/cl-test e o produto CONCURRENCY-TEST-SKU eram fixtures do
  // concurrency.manual.ts, de antes da Fase 4 reestruturar rental_units
  // — colidiam com qualquer teste novo que tentasse reusar 'br-test'.
  // Confirmado (Fase 2/3) que são só fixtures, nenhum dado real.
  // Removidos aqui, uma vez, de forma idempotente (WHERE explícito, não
  // um DELETE sem filtro).
  await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id IN (SELECT id FROM reservations WHERE origin_store_id IN ('br-test','cl-test'))`;
  await prisma.$executeRaw`DELETE FROM reservations WHERE origin_store_id IN ('br-test','cl-test')`;
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code = 'CONCURRENCY-TEST-SKU'`;
  await prisma.$executeRaw`DELETE FROM stores WHERE id IN ('br-test','cl-test')`;

  await prisma.store.create({ data: { id: STORE_ID, shopifyDomain: 'avail-test.myshopify.com', currency: 'BRL' } });

  await prisma.rentalUnit.createMany({
    data: [
      { code: `AVAIL-FREE-${SUFFIX}`, name: 'Sobretudo livre', shopifyVariantId: VARIANT_FREE, active: true, reservableOnline: true, countsTowardRentalDuration: true },
      { code: `AVAIL-PAIR-1-${SUFFIX}`, name: 'Sobretudo par 1', shopifyVariantId: VARIANT_PAIR, active: true, reservableOnline: true, countsTowardRentalDuration: true },
      { code: `AVAIL-PAIR-2-${SUFFIX}`, name: 'Sobretudo par 2', shopifyVariantId: VARIANT_PAIR, active: true, reservableOnline: true, countsTowardRentalDuration: true },
      { code: `AVAIL-INACTIVE-${SUFFIX}`, name: 'Peça inativa', shopifyVariantId: VARIANT_INACTIVE, active: false, reservableOnline: true, countsTowardRentalDuration: true },
      { code: `AVAIL-ACCESSORY-${SUFFIX}`, name: 'Luva', shopifyVariantId: VARIANT_ACCESSORY, active: true, reservableOnline: false, countsTowardRentalDuration: false },
      { code: `AVAIL-OVERLAP-${SUFFIX}`, name: 'Sobretudo p/ sobreposição', shopifyVariantId: VARIANT_OVERLAP, active: true, reservableOnline: true, countsTowardRentalDuration: true },
    ],
  });

  // Reserva existente na unidade "overlap": pickup bem no futuro (fora de
  // qualquer temporada), 2 peças → 2 dias de duração.
  existingPickup = futurePickup(60);
  const existingReturn = calculateReturnDate(existingPickup, 2);
  existingBlocked = calculateBlockedRange(existingPickup, existingReturn, CFG);

  const overlapUnit = await prisma.rentalUnit.findFirstOrThrow({ where: { shopifyVariantId: VARIANT_OVERLAP } });
  await createConfirmedReservation(overlapUnit.id, existingBlocked);

  // Duas unidades iguais (VARIANT_PAIR), as duas ocupadas — cenário
  // "duas unidades iguais, ambas ocupadas".
  const pairUnits = await prisma.rentalUnit.findMany({ where: { shopifyVariantId: VARIANT_PAIR } });
  pairUnitIds = pairUnits.map((u) => u.id);
  pairPickup = futurePickup(80);
  const pairReturn = calculateReturnDate(pairPickup, 2);
  const pairBlocked = calculateBlockedRange(pairPickup, pairReturn, CFG);
  for (const unit of pairUnits) {
    await createConfirmedReservation(unit.id, pairBlocked);
  }
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function createConfirmedReservation(rentalUnitId: string, range: BlockedRange): Promise<void> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservations (id, status, origin_store_id, pickup_date, return_date)
    VALUES (gen_random_uuid(), 'confirmed', ${STORE_ID}, ${civilDateToISO(range.blockedFrom)}::date, ${civilDateToISO(range.blockedUntilExclusive)}::date)
    RETURNING id
  `;
  await prisma.$executeRaw`
    INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
    VALUES (
      gen_random_uuid(), ${rows[0].id}::uuid, ${rentalUnitId}::uuid, 'confirmed',
      daterange(${civilDateToISO(range.blockedFrom)}::date, ${civilDateToISO(range.blockedUntilExclusive)}::date, '[)')
    )
  `;
}

async function cleanup() {
  await prisma.$executeRaw`DELETE FROM reservation_items WHERE rental_unit_id IN (SELECT id FROM rental_units WHERE code LIKE 'AVAIL-%')`;
  await prisma.$executeRaw`DELETE FROM reservations WHERE origin_store_id = ${STORE_ID}`;
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE 'AVAIL-%'`;
  await prisma.$executeRaw`DELETE FROM stores WHERE id = ${STORE_ID}`;
}

describe('AvailabilityService — integração real (Neon)', () => {
  test('unidade totalmente livre → bookable, quantityAvailable=1', async () => {
    const pickup = futurePickup(10);
    const res = await service.getAvailability({
      shopifyVariantId: VARIANT_FREE,
      countedPieces: 1,
      from: civilDateToISO(pickup),
      to: civilDateToISO(pickup),
    });
    expect(res.unitsTotal).toBe(1);
    expect(res.days).toHaveLength(1);
    expect(res.days[0]).toMatchObject({ bookable: true, quantityAvailable: 1, reason: null });
  });

  test('produto sem RentalUnit → 404', async () => {
    await expect(service.getAvailability({ shopifyVariantId: VARIANT_MISSING, countedPieces: 1 })).rejects.toMatchObject({
      status: 404,
    });
  });

  test('RentalUnit inactive → tratada como sem unidade (404)', async () => {
    await expect(service.getAvailability({ shopifyVariantId: VARIANT_INACTIVE, countedPieces: 1 })).rejects.toMatchObject({
      status: 404,
    });
  });

  test('item não reservável (acessório) → 422, rejeitado no servidor mesmo sem o frontend chamar isto', async () => {
    await expect(service.getAvailability({ shopifyVariantId: VARIANT_ACCESSORY, countedPieces: 1 })).rejects.toMatchObject({
      status: 422,
    });
  });

  test('domingo → bookable=false, reason=pickup_is_sunday', async () => {
    let d = futurePickup(10);
    while (!isSunday(d)) d = addDays(d, 1);
    // Garante que o domingo achado não caiu, por coincidência, dentro do
    // bloqueio de temporada — se caiu, o teste avisa em vez de mascarar.
    expect(isOnlineReservationAllowed(d, CFG)).toBe(true);

    const res = await service.getAvailability({
      shopifyVariantId: VARIANT_FREE,
      countedPieces: 1,
      from: civilDateToISO(d),
      to: civilDateToISO(d),
    });
    expect(res.days[0].bookable).toBe(false);
    expect(res.days[0].reason).toBe('pickup_is_sunday');
  });

  test('temporada bloqueada (15/07 do próximo ano) → reason=pickup_outside_online_season', async () => {
    const t = engineToday(CFG);
    const inBlackout = civilDateFromISO(`${t.year + 1}-07-15`);
    const res = await service.getAvailability({
      shopifyVariantId: VARIANT_FREE,
      countedPieces: 1,
      from: civilDateToISO(inBlackout),
      to: civilDateToISO(inBlackout),
    });
    expect(res.days[0].bookable).toBe(false);
    expect(res.days[0].reason).toBe('pickup_outside_online_season');
  });

  test('antecedência insuficiente (amanhã) → reason=pickup_before_minimum_advance', async () => {
    const tomorrow = addDays(engineToday(CFG), 1);
    const res = await service.getAvailability({
      shopifyVariantId: VARIANT_FREE,
      countedPieces: 1,
      from: civilDateToISO(tomorrow),
      to: civilDateToISO(tomorrow),
    });
    expect(res.days[0].bookable).toBe(false);
    expect(res.days[0].reason).toBe('pickup_before_minimum_advance');
  });

  describe('sobreposição com reserva existente (unidade única)', () => {
    test('mesmo pickup da reserva existente → indisponível', async () => {
      const res = await service.getAvailability({
        shopifyVariantId: VARIANT_OVERLAP,
        countedPieces: 2,
        from: civilDateToISO(existingPickup),
        to: civilDateToISO(existingPickup),
      });
      expect(res.days[0]).toMatchObject({ bookable: false, reason: 'no_units_available', quantityAvailable: 0 });
    });

    test('sobreposição no início — novo bloqueio começa antes e invade o existente', async () => {
      // 1 dia antes do começo do bloqueio existente: com prepDays=3, o
      // novo bloqueio (pickup-3 .. pickup+dias+cleaning+1) alcança o
      // existente por cima.
      const probe = addDays(existingBlocked.blockedFrom, 1);
      const res = await service.getAvailability({
        shopifyVariantId: VARIANT_OVERLAP,
        countedPieces: 1,
        from: civilDateToISO(probe),
        to: civilDateToISO(probe),
      });
      expect(res.days[0].bookable).toBe(false);
    });

    test('sobreposição no fim — novo pickup perto do fim do bloqueio existente, duração maior ultrapassa', async () => {
      const probe = addDays(existingBlocked.blockedUntilExclusive, -2);
      const res = await service.getAvailability({
        shopifyVariantId: VARIANT_OVERLAP,
        countedPieces: 6, // 5-6 peças = 4 dias — janela maior, garante ultrapassar
        from: civilDateToISO(probe),
        to: civilDateToISO(probe),
      });
      expect(res.days[0].bookable).toBe(false);
    });

    test('logo que a janela de preparação da PRÓXIMA reserva não alcança mais o bloqueio existente → disponível de novo', async () => {
      // Não é `blockedUntilExclusive` puro: um pickup exatamente nesse dia
      // teria SEU PRÓPRIO prepDays olhando pra trás e ainda alcançaria o
      // fim do bloqueio existente (blockedFrom do novo = esse dia - 3,
      // que cai DENTRO do bloqueio antigo) — comportamento correto do
      // motor, não bug (a peça literalmente não dá tempo de preparar).
      // O primeiro dia realmente livre de novo é blockedUntilExclusive
      // + prepDays.
      const probe = pickupSafe(addDays(existingBlocked.blockedUntilExclusive, CFG.prepDays));
      const res = await service.getAvailability({
        shopifyVariantId: VARIANT_OVERLAP,
        countedPieces: 1,
        from: civilDateToISO(probe),
        to: civilDateToISO(probe),
      });
      expect(res.days[0]).toMatchObject({ bookable: true, quantityAvailable: 1 });
    });

    test('bem antes do bloqueio (fora da janela de preparação) → disponível', async () => {
      const probe = addDays(existingBlocked.blockedFrom, -10);
      const res = await service.getAvailability({
        shopifyVariantId: VARIANT_OVERLAP,
        countedPieces: 1,
        from: civilDateToISO(probe),
        to: civilDateToISO(probe),
      });
      expect(res.days[0].bookable).toBe(true);
    });
  });

  describe('duas unidades iguais (mesma shopifyVariantId)', () => {
    test('as duas ocupadas → quantityAvailable=0, bookable=false', async () => {
      const res = await service.getAvailability({
        shopifyVariantId: VARIANT_PAIR,
        countedPieces: 2,
        from: civilDateToISO(pairPickup),
        to: civilDateToISO(pairPickup),
      });
      expect(res.unitsTotal).toBe(2);
      expect(res.days[0]).toMatchObject({ quantityAvailable: 0, bookable: false });
    });

    test('libera uma das duas (cancela a reserva dela) → quantityAvailable=1', async () => {
      // 'cancelled' não está entre os status ocupantes — some da conta
      // assim que o status muda, sem precisar recriar fixture nenhum.
      await prisma.$executeRaw`
        UPDATE reservations SET status = 'cancelled'
        WHERE id IN (SELECT reservation_id FROM reservation_items WHERE rental_unit_id = ${pairUnitIds[0]}::uuid)
      `;
      const res = await service.getAvailability({
        shopifyVariantId: VARIANT_PAIR,
        countedPieces: 2,
        from: civilDateToISO(pairPickup),
        to: civilDateToISO(pairPickup),
      });
      expect(res.days[0]).toMatchObject({ quantityAvailable: 1, bookable: true });
    });
  });
});
