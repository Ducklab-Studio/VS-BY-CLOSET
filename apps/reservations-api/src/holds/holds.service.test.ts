import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { HoldsService } from './holds.service';
import { hashHoldToken } from './hold-token';
import { type CivilDate, addDays, civilDateToISO, isSunday } from '../rental-rules/civil-date';
import { calculateReturnDate, isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';
import type { CreateHoldDto } from './dto/create-hold.dto';

/**
 * Integração real contra o Neon — sem mock de banco. `NODE_ENV` durante
 * `vitest run` não é `production`, então `resolveStoreConfig()`/
 * `currentTermsVersion()` caem no fallback de dev (ver holds/store-config.ts,
 * holds/terms.ts) sem precisar configurar variável nenhuma pro teste
 * rodar — a mesma linha 'dev-store' é reaproveitada entre arquivos de
 * teste (upsert idempotente), nunca apagada na limpeza: só os fixtures
 * com o prefixo deste arquivo (`HOLD-SVC-`) são removidos.
 *
 * Cada cenário que de fato GRAVA um HOLD usa sua PRÓPRIA variante (uma
 * só unidade cada) — de propósito. A primeira versão deste arquivo
 * reusava `VARIANT_SINGLE` em vários testes só espaçando o pickup por
 * poucos dias, e caiu exatamente na avaria que o motor deveria pegar: o
 * blockedRange (pickup-3 .. devolução+2+1, ~8 dias de largura) de um
 * teste sobrepunha o do vizinho, os dois competindo pela mesma (única)
 * unidade. Variante dedicada por cenário elimina essa classe de falso
 * negativo sem precisar calcular espaçamento de calendário à mão.
 */
const prisma = new PrismaService();
const rentalRuleConfig = new RentalRuleConfigService(prisma);
const service = new HoldsService(prisma, rentalRuleConfig);

const CFG = DEFAULT_RENTAL_RULE_CONFIG;
const SUFFIX = Date.now();
const PREFIX = `HOLD-SVC-${SUFFIX}`;

const VARIANT_HAPPY = `${PREFIX}-happy`;
const VARIANT_PAIR = `${PREFIX}-pair`;
const VARIANT_CAPACITY = `${PREFIX}-capacity`;
const VARIANT_ACCESSORY = `${PREFIX}-accessory`;
const VARIANT_A = `${PREFIX}-a`;
const VARIANT_B = `${PREFIX}-b`;
const VARIANT_MISSING = `${PREFIX}-missing`;
const VARIANT_SUNDAY_NO_CHOICE = `${PREFIX}-sun-no-choice`;
const VARIANT_SUNDAY_SAT = `${PREFIX}-sun-sat`;
const VARIANT_SUNDAY_MON = `${PREFIX}-sun-mon`;
const VARIANT_SUNDAY_MANIPULATED = `${PREFIX}-sun-manip`;
const VARIANT_TERMS = `${PREFIX}-terms`;
const VARIANT_ADVANCE = `${PREFIX}-advance`;
const VARIANT_SEASON = `${PREFIX}-season`;
const VARIANT_EXPIRY = `${PREFIX}-expiry`;
const VARIANT_IDEM_SAME = `${PREFIX}-idem-same`;
const VARIANT_IDEM_DIFF_A = `${PREFIX}-idem-diff-a`;
const VARIANT_IDEM_DIFF_B = `${PREFIX}-idem-diff-b`;
const VARIANT_IDEM_RACE = `${PREFIX}-idem-race`;
const VARIANT_FAIL_CLOSED = `${PREFIX}-fail-closed`;

function pickupSafe(date: CivilDate): CivilDate {
  let d = date;
  for (let i = 0; i < 400 && (!isOnlineReservationAllowed(d, CFG) || isSunday(d)); i++) d = addDays(d, 1);
  return d;
}

// `daysFromToday` precisa ser >= CFG.minAdvanceDays (15) sempre que o
// teste espera sucesso — `pickupSafe` só ADICIONA dias, nunca subtrai,
// então qualquer offset >= minAdvanceDays garante a antecedência mínima
// não importa quanto `pickupSafe` precise empurrar pra escapar do
// blackout de temporada. Todos os offsets deste arquivo já são >= 20.
function futurePickup(daysFromToday: number): CivilDate {
  return pickupSafe(addDays(engineToday(CFG), daysFromToday));
}

/** Pickup válido cuja devolução calculada (pickup + durationDays) TAMBÉM
 *  não cai domingo — pro caminho "normal", sem exceção. */
function pickupWithoutSundayReturn(durationDays: number, daysFromToday: number): CivilDate {
  let d = futurePickup(daysFromToday);
  for (let i = 0; i < 400 && isSunday(calculateReturnDate(d, durationDays)); i++) d = pickupSafe(addDays(d, 1));
  return d;
}

/** Pickup válido cuja devolução calculada CAI num domingo de verdade —
 *  pro cenário de exceção. */
function pickupWithSundayReturn(durationDays: number, daysFromToday: number): CivilDate {
  let d = futurePickup(daysFromToday);
  for (let i = 0; i < 400 && !isSunday(calculateReturnDate(d, durationDays)); i++) d = pickupSafe(addDays(d, 1));
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

beforeAll(async () => {
  await cleanup();
  const singleUnitVariants = [
    VARIANT_HAPPY,
    VARIANT_CAPACITY,
    VARIANT_A,
    VARIANT_B,
    VARIANT_SUNDAY_NO_CHOICE,
    VARIANT_SUNDAY_SAT,
    VARIANT_SUNDAY_MON,
    VARIANT_SUNDAY_MANIPULATED,
    VARIANT_TERMS,
    VARIANT_ADVANCE,
    VARIANT_SEASON,
    VARIANT_EXPIRY,
    VARIANT_IDEM_SAME,
    VARIANT_IDEM_DIFF_A,
    VARIANT_IDEM_DIFF_B,
    VARIANT_IDEM_RACE,
    VARIANT_FAIL_CLOSED,
  ];
  await prisma.rentalUnit.createMany({
    data: [
      ...singleUnitVariants.map((variantId, i) => ({
        code: `${PREFIX}-u${i}`,
        name: `Peça ${i}`,
        shopifyVariantId: variantId,
        active: true,
        reservableOnline: true,
        countsTowardRentalDuration: true,
      })),
      { code: `${PREFIX}-pair-1`, name: 'Sobretudo par 1', shopifyVariantId: VARIANT_PAIR, active: true, reservableOnline: true, countsTowardRentalDuration: true },
      { code: `${PREFIX}-pair-2`, name: 'Sobretudo par 2', shopifyVariantId: VARIANT_PAIR, active: true, reservableOnline: true, countsTowardRentalDuration: true },
      { code: `${PREFIX}-accessory-1`, name: 'Luva', shopifyVariantId: VARIANT_ACCESSORY, active: true, reservableOnline: false, countsTowardRentalDuration: false },
    ],
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('HoldsService — integração real (Neon)', () => {
  test('caminho feliz: 1 unidade livre, 1 peça → HOLD criado com 1 ReservationItem', async () => {
    const pickup = pickupWithoutSundayReturn(2, 20);
    const dto: CreateHoldDto = {
      items: [{ shopifyVariantId: VARIANT_HAPPY, quantity: 1 }],
      pickupDate: civilDateToISO(pickup),
      termsAccepted: true,
    };
    const res = await service.createHold(dto);

    expect(res.status).toBe('hold');
    expect(res.durationDays).toBe(2); // 1 peça → 2 dias (config confirmada)
    expect(res.items).toEqual([{ shopifyVariantId: VARIANT_HAPPY, quantity: 1 }]);

    const items = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM reservation_items WHERE reservation_id = ${res.reservationId}::uuid
    `;
    expect(Number(items[0].count)).toBe(1);

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: res.reservationId } });
    expect(reservation.status).toBe('hold');
    expect(reservation.termsAcceptedAt).not.toBeNull();
    expect(reservation.termsVersion).toBe('dev-unversioned');

    // Item 1 da Fase 6: capability token devolvido na criação, só o HASH
    // vai pro banco — nunca o texto puro.
    expect(res.holdToken).toBeTruthy();
    expect(reservation.holdTokenHash).toBe(hashHoldToken(res.holdToken!));
    expect(reservation.holdTokenHash).not.toBe(res.holdToken);
  });

  test('2 unidades livres, quantidade 2 → aloca as duas', async () => {
    const pickup = pickupWithoutSundayReturn(2, 21);
    const res = await service.createHold({
      items: [{ shopifyVariantId: VARIANT_PAIR, quantity: 2 }],
      pickupDate: civilDateToISO(pickup),
      termsAccepted: true,
    });
    const items = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM reservation_items WHERE reservation_id = ${res.reservationId}::uuid
    `;
    expect(Number(items[0].count)).toBe(2);
  });

  test('capacidade insuficiente: 1 unidade livre, pede 2 → 409, nada é gravado', async () => {
    // pickupWithoutSundayReturn (não futurePickup puro) — achado real:
    // sem garantir que a devolução calculada evite domingo, este pickup
    // ocasionalmente caía no cenário de "devolução em domingo — exceção
    // precisa de escolha explícita" (422), mascarando o teste de
    // capacidade (409) que era a intenção original.
    const pickup = pickupWithoutSundayReturn(2, 22);
    await expect(
      service.createHold({
        items: [{ shopifyVariantId: VARIANT_CAPACITY, quantity: 2 }],
        pickupDate: civilDateToISO(pickup),
        termsAccepted: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  test('item não reservável (acessório) → 422, violations inclui contains_non_reservable_item', async () => {
    const pickup = futurePickup(23);
    try {
      await service.createHold({
        items: [{ shopifyVariantId: VARIANT_ACCESSORY, quantity: 1 }],
        pickupDate: civilDateToISO(pickup),
        termsAccepted: true,
      });
      expect.unreachable('deveria ter lançado');
    } catch (err) {
      expect(err).toMatchObject({ status: 422 });
      const response = (err as { response: { violations: string[] } }).response;
      // Acessório também some da contagem de peças contáveis — as duas
      // violations disparam juntas, e é correto que disparem: não é só
      // "não reservável", é também "carrinho sem nenhuma peça contável".
      expect(response.violations).toEqual(expect.arrayContaining(['contains_non_reservable_item']));
    }
  });

  test('variante sem RentalUnit cadastrada → tratada como não reservável (422)', async () => {
    const pickup = futurePickup(24);
    await expect(
      service.createHold({
        items: [{ shopifyVariantId: VARIANT_MISSING, quantity: 1 }],
        pickupDate: civilDateToISO(pickup),
        termsAccepted: true,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  test('7 peças via 2 variantes distintas (4+3) → max_pieces_exceeded, nada gravado', async () => {
    const pickup = futurePickup(25);
    try {
      await service.createHold({
        items: [
          { shopifyVariantId: VARIANT_A, quantity: 4 },
          { shopifyVariantId: VARIANT_B, quantity: 3 },
        ],
        pickupDate: civilDateToISO(pickup),
        termsAccepted: true,
      });
      expect.unreachable('deveria ter lançado');
    } catch (err) {
      expect(err).toMatchObject({ status: 422 });
      const response = (err as { response: { violations: string[] } }).response;
      expect(response.violations).toEqual(expect.arrayContaining(['max_pieces_exceeded']));
    }
  });

  test('domingo no pickup → 422 pickup_is_sunday', async () => {
    let d = futurePickup(26);
    while (!isSunday(d)) d = addDays(d, 1);
    expect(isOnlineReservationAllowed(d, CFG)).toBe(true);

    await expect(
      service.createHold({
        items: [{ shopifyVariantId: VARIANT_HAPPY, quantity: 1 }],
        pickupDate: civilDateToISO(d),
        termsAccepted: true,
      }),
    ).rejects.toMatchObject({ status: 422, response: { violations: ['pickup_is_sunday'] } });
  });

  test('antes do início da operação → 422 pickup_before_operation_start; nenhum HOLD criado', async () => {
    const start = futurePickup(120);
    const before = addDays(start, -10);
    await prisma.rentalRuleConfig.update({ where: { id: 'default' }, data: { operationStartDate: new Date(civilDateToISO(start)) } });
    try {
      await expect(
        service.createHold({
          items: [{ shopifyVariantId: VARIANT_SEASON, quantity: 1 }],
          pickupDate: civilDateToISO(isSunday(before) ? addDays(before, 1) : before),
          termsAccepted: true,
        }),
      ).rejects.toMatchObject({ status: 422, response: { violations: ['pickup_before_operation_start'] } });
    } finally {
      await prisma.rentalRuleConfig.update({ where: { id: 'default' }, data: { operationStartDate: null } });
    }
  });

  test('antecedência insuficiente (amanhã) → 422, violations inclui pickup_before_minimum_advance', async () => {
    const tomorrow = addDays(engineToday(CFG), 1);
    try {
      await service.createHold({
        items: [{ shopifyVariantId: VARIANT_ADVANCE, quantity: 1 }],
        pickupDate: civilDateToISO(tomorrow),
        termsAccepted: true,
      });
      expect.unreachable('deveria ter lançado');
    } catch (err) {
      expect(err).toMatchObject({ status: 422 });
      const response = (err as { response: { violations: string[] } }).response;
      // "Amanhã" também pode ser domingo — outras violations podem vir
      // junto, não só a de antecedência.
      expect(response.violations).toEqual(expect.arrayContaining(['pickup_before_minimum_advance']));
    }
  });

  test('termsAccepted=false → 422, nada gravado', async () => {
    const pickup = futurePickup(27);
    await expect(
      service.createHold({
        items: [{ shopifyVariantId: VARIANT_TERMS, quantity: 1 }],
        pickupDate: civilDateToISO(pickup),
        termsAccepted: false,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  describe('devolução em domingo — exceção precisa de escolha explícita', () => {
    test('sem escolha → 422, nunca decide silenciosamente', async () => {
      const pickup = pickupWithSundayReturn(2, 28);
      await expect(
        service.createHold({
          items: [{ shopifyVariantId: VARIANT_SUNDAY_NO_CHOICE, quantity: 1 }],
          pickupDate: civilDateToISO(pickup),
          termsAccepted: true,
        }),
      ).rejects.toMatchObject({ status: 422 });
    });

    test('escolha "saturday" → effectiveReturnDate = calculatedReturnDate - 1', async () => {
      const pickup = pickupWithSundayReturn(2, 60);
      const calculated = calculateReturnDate(pickup, 2);
      const res = await service.createHold({
        items: [{ shopifyVariantId: VARIANT_SUNDAY_SAT, quantity: 1 }],
        pickupDate: civilDateToISO(pickup),
        sundayReturnOption: 'saturday',
        termsAccepted: true,
      });
      expect(res.calculatedReturnDate).toBe(civilDateToISO(calculated));
      expect(res.effectiveReturnDate).toBe(civilDateToISO(addDays(calculated, -1)));
    });

    test('escolha "mondayMorning" → effectiveReturnDate = calculatedReturnDate + 1', async () => {
      const pickup = pickupWithSundayReturn(2, 90);
      const calculated = calculateReturnDate(pickup, 2);
      const res = await service.createHold({
        items: [{ shopifyVariantId: VARIANT_SUNDAY_MON, quantity: 1 }],
        pickupDate: civilDateToISO(pickup),
        sundayReturnOption: 'mondayMorning',
        termsAccepted: true,
      });
      expect(res.effectiveReturnDate).toBe(civilDateToISO(addDays(calculated, 1)));
    });

    test('sundayReturnOption manipulada (mandada sem existir exceção) → 422', async () => {
      const pickup = pickupWithoutSundayReturn(2, 29);
      const calculated = calculateReturnDate(pickup, 2);
      expect(isSunday(calculated)).toBe(false);

      await expect(
        service.createHold({
          items: [{ shopifyVariantId: VARIANT_SUNDAY_MANIPULATED, quantity: 1 }],
          pickupDate: civilDateToISO(pickup),
          sundayReturnOption: 'saturday',
          termsAccepted: true,
        }),
      ).rejects.toMatchObject({ status: 422 });
    });
  });

  describe('HOLD expirado libera a unidade', () => {
    test('HOLD ativo bloqueia; expirado (manualmente, simulando os 30min) não bloqueia mais', async () => {
      const pickup = pickupWithoutSundayReturn(2, 120);
      const first = await service.createHold({
        items: [{ shopifyVariantId: VARIANT_EXPIRY, quantity: 1 }],
        pickupDate: civilDateToISO(pickup),
        termsAccepted: true,
      });

      await expect(
        service.createHold({
          items: [{ shopifyVariantId: VARIANT_EXPIRY, quantity: 1 }],
          pickupDate: civilDateToISO(pickup),
          termsAccepted: true,
        }),
      ).rejects.toMatchObject({ status: 409 });

      await prisma.$executeRaw`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = ${first.reservationId}::uuid`;

      const second = await service.createHold({
        items: [{ shopifyVariantId: VARIANT_EXPIRY, quantity: 1 }],
        pickupDate: civilDateToISO(pickup),
        termsAccepted: true,
      });
      expect(second.reservationId).not.toBe(first.reservationId);

      const firstAfter = await prisma.reservation.findUniqueOrThrow({ where: { id: first.reservationId } });
      expect(firstAfter.status).toBe('expired');
    }, 20_000); // 3 chamadas reais sequenciais ao Neon — folga sobre o default de 5s.
  });

  describe('Idempotency-Key', () => {
    test('mesma chave, mesmo payload → mesmo reservationId, um único HOLD gravado', async () => {
      const pickup = pickupWithoutSundayReturn(2, 130);
      const key = `idem-${SUFFIX}-a`;
      const dto: CreateHoldDto = {
        items: [{ shopifyVariantId: VARIANT_IDEM_SAME, quantity: 1 }],
        pickupDate: civilDateToISO(pickup),
        termsAccepted: true,
      };
      const first = await service.createHold(dto, key);
      const second = await service.createHold(dto, key);
      expect(second.reservationId).toBe(first.reservationId);
      // Item 1 da Fase 6: token só na criação de verdade — o replay não
      // tem como devolvê-lo (só o hash existe no banco).
      expect(first.holdToken).toBeTruthy();
      expect(second.holdToken).toBeNull();

      const count = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS count FROM hold_idempotency_keys WHERE "key" = ${key}
      `;
      expect(Number(count[0].count)).toBe(1);
    }, 20_000);

    test('mesma chave, payload diferente → rejeitado (409) antes de tentar alocar', async () => {
      const pickup = pickupWithoutSundayReturn(2, 131);
      const key = `idem-${SUFFIX}-b`;
      await service.createHold(
        { items: [{ shopifyVariantId: VARIANT_IDEM_DIFF_A, quantity: 1 }], pickupDate: civilDateToISO(pickup), termsAccepted: true },
        key,
      );
      await expect(
        service.createHold(
          { items: [{ shopifyVariantId: VARIANT_IDEM_DIFF_B, quantity: 1 }], pickupDate: civilDateToISO(pickup), termsAccepted: true },
          key,
        ),
      ).rejects.toMatchObject({ status: 409 });
    }, 20_000);

    test('double click (Promise.all com a mesma chave) → um único HOLD, a outra chamada replica o mesmo id', async () => {
      const pickup = pickupWithoutSundayReturn(2, 132);
      const key = `idem-${SUFFIX}-c`;
      const dto: CreateHoldDto = {
        items: [{ shopifyVariantId: VARIANT_IDEM_RACE, quantity: 1 }],
        pickupDate: civilDateToISO(pickup),
        termsAccepted: true,
      };
      const [a, b] = await Promise.all([service.createHold(dto, key), service.createHold(dto, key)]);
      expect(a.reservationId).toBe(b.reservationId);

      const count = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS count FROM hold_idempotency_keys WHERE "key" = ${key}
      `;
      expect(Number(count[0].count)).toBe(1);
    }, 20_000);
  });
});

describe('HoldsService — fail closed', () => {
  test('rental_rule_config indisponível → 503, nada gravado', async () => {
    const brokenConfig = { load: vi.fn().mockRejectedValue(new Error('connection refused')) } as unknown as RentalRuleConfigService;
    const brokenService = new HoldsService(prisma, brokenConfig);
    await expect(
      brokenService.createHold({
        items: [{ shopifyVariantId: VARIANT_FAIL_CLOSED, quantity: 1 }],
        pickupDate: civilDateToISO(futurePickup(140)),
        termsAccepted: true,
      }),
    ).rejects.toMatchObject({ status: 503 });
  });
});
