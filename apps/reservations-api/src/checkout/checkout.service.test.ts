import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { HoldsService, type HoldResponse } from '../holds/holds.service';
import { CheckoutService } from './checkout.service';
import type { ShopifyCartClient } from './shopify-storefront-cart.client';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { type CivilDate, addDays, isSunday } from '../rental-rules/civil-date';
import { calculateReturnDate, isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';
import { civilDateToISO } from '../rental-rules/civil-date';

// Segredo do binding assinado Order<->Reservation (ver
// src/reservation-binding.ts) -- sem fallback de dev em
// resolveReservationBindingSecret(), tem que estar setado antes de
// createCheckout() rodar. Só pra este arquivo, nunca reaproveita
// SHOPIFY_CLIENT_SECRET.
process.env.RESERVATION_BINDING_SECRET ??= 'test-reservation-binding-secret-checkout';

/**
 * Integração real (Neon) pra tudo que é estado de Reservation — só a
 * chamada à Shopify de verdade é mockada aqui (`ShopifyCartClient`
 * injetado como fake, mesmo padrão de `RentalRuleConfigService` em
 * fail-closed tests já existentes no projeto). A integração REAL contra
 * a Storefront de verdade — criando só um cart de teste, sem pagamento —
 * está em checkout.service.real-shopify.test.ts (item 17 da Fase 6).
 *
 * Cada teste (20s de timeout — cada createHold + createCheckout já são
 * 2-3 idas reais ao Neon) roda com o SEU PRÓPRIO cart id fake
 * (`makeOkResult()`), nunca uma constante compartilhada: `shopifyCartId`
 * é UNIQUE em `reservations` (corretamente — ver migration da Fase 6), e
 * dois testes usando o MESMO valor colidem nessa constraint exatamente
 * como duas Reservations reais colidiriam.
 */
const prisma = new PrismaService();
const rentalRuleConfig = new RentalRuleConfigService(prisma);
const holdsService = new HoldsService(prisma, rentalRuleConfig);

const CFG = DEFAULT_RENTAL_RULE_CONFIG;
const SUFFIX = Date.now();
const PREFIX = `CHK-${SUFFIX}`;
const TIMEOUT = 20_000;

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

function fakeCartClient(impl: ShopifyCartClient['cartCreate']): ShopifyCartClient {
  return { cartCreate: vi.fn(impl) } as unknown as ShopifyCartClient;
}

let cartCounter = 0;
function makeOkResult() {
  const n = cartCounter++;
  return { ok: true as const, cartId: `gid://shopify/Cart/test-${SUFFIX}-${n}`, checkoutUrl: `https://dev-store.myshopify.com/cart/c/test-${SUFFIX}-${n}` };
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

let unitCounter = 0;
async function createVariant(unitCount: number, opts: { active?: boolean } = {}): Promise<string> {
  const variantId = `${PREFIX}-v${unitCounter++}`;
  await prisma.rentalUnit.createMany({
    data: Array.from({ length: unitCount }, (_, i) => ({
      code: `${variantId}-u${i}`,
      name: 'peça de teste',
      shopifyVariantId: variantId,
      active: opts.active ?? true,
      reservableOnline: true,
      countsTowardRentalDuration: true,
    })),
  });
  return variantId;
}

async function createHold(items: { shopifyVariantId: string; quantity: number }[], daysFromToday: number): Promise<HoldResponse> {
  const pickup = pickupWithoutSundayReturn(2, daysFromToday);
  return holdsService.createHold({ items, pickupDate: civilDateToISO(pickup), termsAccepted: true });
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('CheckoutService — integração real (Neon) + Shopify mockada', () => {
  test(
    '1,2,7,18,19,21) HOLD válido + holdToken correto → cart criado, linhas corretas, status pending_payment, unidade continua ocupada, atributo reservation_id presente',
    async () => {
      const variant = await createVariant(1);
      const hold = await createHold([{ shopifyVariantId: variant, quantity: 1 }], 30);
      const okResult = makeOkResult();
      const cartClient = fakeCartClient(async () => okResult);
      const service = new CheckoutService(prisma, rentalRuleConfig, cartClient);

      const res = await service.createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! });

      expect(res.status).toBe('pending_payment');
      expect(res.checkoutUrl).toBe(okResult.checkoutUrl);

      expect(cartClient.cartCreate).toHaveBeenCalledTimes(1);
      const [lines, attributes] = vi.mocked(cartClient.cartCreate).mock.calls[0];
      expect(lines).toEqual([{ merchandiseId: `gid://shopify/ProductVariant/${variant}`, quantity: 1 }]);
      expect(attributes).toEqual(expect.arrayContaining([{ key: 'reservation_id', value: hold.reservationId }]));

      const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
      expect(reservation.status).toBe('pending_payment');
      expect(reservation.checkoutState).toBe('ready');
      expect(reservation.shopifyCartId).toBe(okResult.cartId);

      const items = await prisma.$queryRaw<{ status: string }[]>`SELECT status FROM reservation_items WHERE reservation_id = ${hold.reservationId}::uuid`;
      expect(items.every((i) => i.status === 'pending_payment')).toBe(true); // 19: continua ocupando
    },
    TIMEOUT,
  );

  test(
    '3) quantidade 2 da mesma variante → 1 linha com quantity 2',
    async () => {
      const variant = await createVariant(2);
      const hold = await createHold([{ shopifyVariantId: variant, quantity: 2 }], 31);
      const cartClient = fakeCartClient(async () => makeOkResult());
      const service = new CheckoutService(prisma, rentalRuleConfig, cartClient);

      await service.createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! });

      const [lines] = vi.mocked(cartClient.cartCreate).mock.calls[0];
      expect(lines).toEqual([{ merchandiseId: `gid://shopify/ProductVariant/${variant}`, quantity: 2 }]);
    },
    TIMEOUT,
  );

  test(
    '4) múltiplas variantes → múltiplas linhas',
    async () => {
      const variantA = await createVariant(1);
      const variantB = await createVariant(1);
      const hold = await createHold(
        [
          { shopifyVariantId: variantA, quantity: 1 },
          { shopifyVariantId: variantB, quantity: 1 },
        ],
        32,
      );
      const cartClient = fakeCartClient(async () => makeOkResult());
      const service = new CheckoutService(prisma, rentalRuleConfig, cartClient);

      await service.createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! });

      const [lines] = vi.mocked(cartClient.cartCreate).mock.calls[0];
      expect(lines).toEqual(
        expect.arrayContaining([
          { merchandiseId: `gid://shopify/ProductVariant/${variantA}`, quantity: 1 },
          { merchandiseId: `gid://shopify/ProductVariant/${variantB}`, quantity: 1 },
        ]),
      );
    },
    TIMEOUT,
  );

  test(
    '5) HOLD inexistente → 404',
    async () => {
      const cartClient = fakeCartClient(async () => makeOkResult());
      const service = new CheckoutService(prisma, rentalRuleConfig, cartClient);
      await expect(
        service.createCheckout({ reservationId: '00000000-0000-0000-0000-000000000000', holdToken: 'x'.repeat(32) }),
      ).rejects.toMatchObject({ status: 404 });
      expect(cartClient.cartCreate).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  test(
    '6) holdToken incorreto → 403, Shopify nunca é chamada',
    async () => {
      const variant = await createVariant(1);
      const hold = await createHold([{ shopifyVariantId: variant, quantity: 1 }], 33);
      const cartClient = fakeCartClient(async () => makeOkResult());
      const service = new CheckoutService(prisma, rentalRuleConfig, cartClient);

      await expect(service.createCheckout({ reservationId: hold.reservationId, holdToken: 'y'.repeat(32) })).rejects.toMatchObject({ status: 403 });
      expect(cartClient.cartCreate).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  test(
    '8) HOLD expirado → 410, e a reserva é expirada pelo mecanismo oficial',
    async () => {
      const variant = await createVariant(1);
      const hold = await createHold([{ shopifyVariantId: variant, quantity: 1 }], 34);
      await prisma.$executeRaw`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = ${hold.reservationId}::uuid`;

      const cartClient = fakeCartClient(async () => makeOkResult());
      const service = new CheckoutService(prisma, rentalRuleConfig, cartClient);
      await expect(service.createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! })).rejects.toMatchObject({ status: 410 });
      expect(cartClient.cartCreate).not.toHaveBeenCalled();

      const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
      expect(reservation.status).toBe('expired');
    },
    TIMEOUT,
  );

  test(
    '9) Reservation não está em hold (ex.: cancelada manualmente) → 409, Shopify nunca é chamada',
    async () => {
      const variant = await createVariant(1);
      const hold = await createHold([{ shopifyVariantId: variant, quantity: 1 }], 35);
      await prisma.$executeRaw`UPDATE reservations SET status = 'confirmed' WHERE id = ${hold.reservationId}::uuid`;

      const cartClient = fakeCartClient(async () => makeOkResult());
      const service = new CheckoutService(prisma, rentalRuleConfig, cartClient);
      await expect(service.createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! })).rejects.toMatchObject({ status: 409 });
      expect(cartClient.cartCreate).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  test(
    '10) item inativo → 409, Shopify nunca é chamada',
    async () => {
      const variant = await createVariant(1);
      const hold = await createHold([{ shopifyVariantId: variant, quantity: 1 }], 36);
      await prisma.rentalUnit.updateMany({ where: { shopifyVariantId: variant }, data: { active: false } });

      const cartClient = fakeCartClient(async () => makeOkResult());
      const service = new CheckoutService(prisma, rentalRuleConfig, cartClient);
      await expect(service.createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! })).rejects.toMatchObject({ status: 409 });
      expect(cartClient.cartCreate).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  test(
    '11,12) Shopify recusa (userError / variante inválida) → 422, checkoutState vira failed, HOLD não é consumido',
    async () => {
      const variant = await createVariant(1);
      const hold = await createHold([{ shopifyVariantId: variant, quantity: 1 }], 37);
      const cartClient = fakeCartClient(async () => ({ ok: false, userErrors: [{ field: ['lines', '0'], message: 'Variant is not available for sale.' }] }));
      const service = new CheckoutService(prisma, rentalRuleConfig, cartClient);

      await expect(service.createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! })).rejects.toMatchObject({ status: 422 });

      const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
      expect(reservation.checkoutState).toBe('failed');
      expect(reservation.status).toBe('hold'); // não avançou — pode tentar de novo
    },
    TIMEOUT,
  );

  test(
    '13) timeout Shopify → 503, checkoutState vira failed',
    async () => {
      const variant = await createVariant(1);
      const hold = await createHold([{ shopifyVariantId: variant, quantity: 1 }], 38);
      const cartClient = fakeCartClient(async () => {
        throw new Error('Falha de rede ao chamar a Storefront API: AbortError');
      });
      const service = new CheckoutService(prisma, rentalRuleConfig, cartClient);

      await expect(service.createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! })).rejects.toMatchObject({ status: 503 });
      const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
      expect(reservation.checkoutState).toBe('failed');
    },
    TIMEOUT,
  );

  test(
    '14) Storefront API 500 → 503, checkoutState vira failed',
    async () => {
      const variant = await createVariant(1);
      const hold = await createHold([{ shopifyVariantId: variant, quantity: 1 }], 39);
      const cartClient = fakeCartClient(async () => {
        throw new Error('Storefront API respondeu 500');
      });
      const service = new CheckoutService(prisma, rentalRuleConfig, cartClient);

      await expect(service.createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! })).rejects.toMatchObject({ status: 503 });
      const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
      expect(reservation.checkoutState).toBe('failed');
    },
    TIMEOUT,
  );

  test(
    '15) chamada duplicada (sequencial) → devolve o MESMO checkout, Shopify chamada só 1 vez',
    async () => {
      const variant = await createVariant(1);
      const hold = await createHold([{ shopifyVariantId: variant, quantity: 1 }], 40);
      const cartClient = fakeCartClient(async () => makeOkResult());
      const service = new CheckoutService(prisma, rentalRuleConfig, cartClient);

      const first = await service.createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! });
      const second = await service.createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! });

      expect(second.checkoutUrl).toBe(first.checkoutUrl);
      expect(cartClient.cartCreate).toHaveBeenCalledTimes(1);
    },
    TIMEOUT,
  );

  test(
    '16) duas chamadas simultâneas → só uma cria o cart, a outra não gera um segundo checkout controlado',
    async () => {
      const variant = await createVariant(1);
      const hold = await createHold([{ shopifyVariantId: variant, quantity: 1 }], 41);
      const okResult = makeOkResult();
      const cartClient = fakeCartClient(async () => okResult);
      const service = new CheckoutService(prisma, rentalRuleConfig, cartClient);

      const results = await Promise.allSettled([
        service.createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! }),
        service.createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! }),
      ]);

      expect(cartClient.cartCreate).toHaveBeenCalledTimes(1);
      // A vencedora cria; a perdedora ou replica o mesmo checkout (se
      // chegou depois de pronto) ou recebe 409 (se chegou enquanto ainda
      // 'creating') — nunca um SEGUNDO cart real.
      const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ checkoutUrl: string }>[];
      for (const f of fulfilled) expect(f.value.checkoutUrl).toBe(okResult.checkoutUrl);

      const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
      expect(reservation.shopifyCartId).toBe(okResult.cartId);
    },
    TIMEOUT,
  );

  test(
    '17) cartCreate teve sucesso mas a persistência não pôde confirmar a guarda "creating" → 503, sem fabricar sucesso',
    async () => {
      const variant = await createVariant(1);
      const hold = await createHold([{ shopifyVariantId: variant, quantity: 1 }], 42);
      // Efeito colateral dentro do próprio mock: simula outra coisa tendo
      // mexido no checkout_state ENQUANTO a chamada à Shopify estava em
      // voo (ex.: falha catastrófica + retomada por outro processo) — o
      // UPDATE final guardado por checkout_state='creating' não vai
      // encontrar a linha nesse estado.
      const cartClient = fakeCartClient(async () => {
        await prisma.$executeRaw`UPDATE reservations SET checkout_state = 'failed' WHERE id = ${hold.reservationId}::uuid`;
        return makeOkResult();
      });
      const service = new CheckoutService(prisma, rentalRuleConfig, cartClient);

      await expect(service.createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! })).rejects.toMatchObject({ status: 503 });
      // O HOLD continua correto — não vira pending_payment sem o vínculo
      // realmente persistido (item 8 da Fase 6: reserva inconsistente NÃO
      // é aceitável).
      const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
      expect(reservation.status).not.toBe('pending_payment');
    },
    TIMEOUT,
  );

  test(
    '20) segredo (holdToken) nunca aparece na resposta do checkout',
    async () => {
      const variant = await createVariant(1);
      const hold = await createHold([{ shopifyVariantId: variant, quantity: 1 }], 43);
      const cartClient = fakeCartClient(async () => makeOkResult());
      const service = new CheckoutService(prisma, rentalRuleConfig, cartClient);

      const res = await service.createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! });
      expect(JSON.stringify(res)).not.toContain(hold.holdToken);
    },
    TIMEOUT,
  );

  test(
    '22) atributos do cart NÃO incluem holdToken',
    async () => {
      const variant = await createVariant(1);
      const hold = await createHold([{ shopifyVariantId: variant, quantity: 1 }], 44);
      const cartClient = fakeCartClient(async () => makeOkResult());
      const service = new CheckoutService(prisma, rentalRuleConfig, cartClient);

      await service.createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! });
      const [, attributes] = vi.mocked(cartClient.cartCreate).mock.calls[0];
      expect(JSON.stringify(attributes)).not.toContain(hold.holdToken);
    },
    TIMEOUT,
  );
});

describe('CreateCheckoutDto — item 23/24 da Fase 6 (preço/quantidade manipulados nunca chegam ao serviço)', () => {
  test('payload com price/quantity/items extras → rejeitado pelo mesmo ValidationPipe global (whitelist + forbidNonWhitelisted)', async () => {
    const instance = plainToInstance(CreateCheckoutDto, {
      reservationId: '11111111-1111-1111-1111-111111111111',
      holdToken: 'x'.repeat(32),
      // Nenhum destes campos existe no DTO — é isso que garante que
      // preço/quantidade/datas manipulados no navegador nunca chegam a
      // influenciar o checkout: main.ts usa forbidNonWhitelisted: true
      // no ValidationPipe global, reproduzido aqui com as MESMAS opções.
      price: 1,
      quantity: 99,
      items: [{ shopifyVariantId: 'x', quantity: 99 }],
    });
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'price' || e.property === 'quantity' || e.property === 'items')).toBe(true);
  });
});
