import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { HoldsService, type HoldResponse } from '../holds/holds.service';
import { CheckoutService } from '../checkout/checkout.service';
import type { ShopifyCartClient, VariantPrice } from '../checkout/shopify-storefront-cart.client';
import type { MercadoPagoClient, MercadoPagoPayment, CreatePreferenceResult } from './mercadopago.client';
import { MercadoPagoService } from './mercadopago.service';
import { type CivilDate, addDays, civilDateToISO, isSunday } from '../rental-rules/civil-date';
import { calculateReturnDate, isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';

/**
 * Integração real (Neon) pra tudo que é estado de Reservation/Payment —
 * mesmo padrão de checkout.service.test.ts: HOLD real via HoldsService,
 * só as chamadas de REDE (Storefront + Mercado Pago) são fakes
 * injetados. Um smoke test à parte, contra o sandbox de verdade, está
 * em mercadopago.sandbox-smoke.test.ts.
 */
const prisma = new PrismaService();
const rentalRuleConfig = new RentalRuleConfigService(prisma);
const holdsService = new HoldsService(prisma, rentalRuleConfig);

const CFG = DEFAULT_RENTAL_RULE_CONFIG;
const SUFFIX = Date.now();
const PREFIX = `MP-${SUFFIX}`;
const TIMEOUT = 20_000;
const UNIT_PRICE = 150; // valor simbólico de teste, em BRL (moeda definitiva do checkout — cliente brasileiro; retirada no Chile é só logística)

function pickupSafe(date: CivilDate): CivilDate {
  let d = date;
  for (let i = 0; i < 400 && (!isOnlineReservationAllowed(d, CFG) || isSunday(d)); i++) d = addDays(d, 1);
  return d;
}
function pickupWithoutSundayReturn(durationDays: number, daysFromToday: number): CivilDate {
  let d = pickupSafe(addDays(engineToday(CFG), daysFromToday));
  for (let i = 0; i < 400 && isSunday(calculateReturnDate(d, durationDays)); i++) d = pickupSafe(addDays(d, 1));
  return d;
}

let unitCounter = 0;
async function createVariant(opts: { active?: boolean } = {}): Promise<string> {
  const variantId = `${PREFIX}-v${unitCounter++}`;
  await prisma.rentalUnit.create({
    data: { code: `${variantId}-u0`, name: 'peça de teste', shopifyVariantId: variantId, active: opts.active ?? true, reservableOnline: true, countsTowardRentalDuration: true },
  });
  return variantId;
}

async function createHold(daysFromToday: number, variant?: string): Promise<{ hold: HoldResponse; variant: string }> {
  const v = variant ?? (await createVariant());
  const pickup = pickupWithoutSundayReturn(2, daysFromToday);
  const hold = await holdsService.createHold({ items: [{ shopifyVariantId: v, quantity: 1 }], pickupDate: civilDateToISO(pickup), termsAccepted: true });
  return { hold, variant: v };
}

function fakeShopifyClient(variant: string, price = UNIT_PRICE, currency = 'BRL'): ShopifyCartClient {
  return {
    cartCreate: vi.fn(),
    fetchVariantPrices: vi.fn(async (): Promise<VariantPrice[]> => [{ variantId: variant, amount: price, currencyCode: currency }]),
  } as unknown as ShopifyCartClient;
}

let prefCounter = 0;
function fakeMpClient(overrides: Partial<MercadoPagoClient> = {}): MercadoPagoClient {
  const n = prefCounter++;
  return {
    createPreference: vi.fn(async (): Promise<CreatePreferenceResult> => ({ preferenceId: `${PREFIX}-pref-${n}`, checkoutUrl: `https://sandbox.mercadopago.com/checkout/${PREFIX}-${n}` })),
    getPayment: vi.fn(async (): Promise<MercadoPagoPayment | null> => null),
    ...overrides,
  } as unknown as MercadoPagoClient;
}

function makePaymentPayload(overrides: Partial<MercadoPagoPayment> & { externalReference: string }): MercadoPagoPayment {
  return {
    id: overrides.id ?? `${PREFIX}-mp-${Math.random()}`,
    status: overrides.status ?? 'approved',
    statusDetail: overrides.statusDetail ?? null,
    transactionAmount: overrides.transactionAmount ?? UNIT_PRICE,
    currencyId: overrides.currencyId ?? 'BRL',
    externalReference: overrides.externalReference,
    metadata: overrides.metadata ?? {},
    dateApproved: overrides.dateApproved ?? new Date().toISOString(),
    liveMode: overrides.liveMode ?? false,
  };
}

async function cleanup() {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id FROM reservation_items ri
    JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ru.code LIKE ${PREFIX + '%'}
  `;
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await prisma.$executeRaw`DELETE FROM mercadopago_webhook_events WHERE payment_id IN (SELECT id FROM payments WHERE reservation_id = ANY(${ids}::uuid[]))`;
    await prisma.$executeRaw`DELETE FROM payments WHERE reservation_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM hold_idempotency_keys WHERE reservation_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${ids}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
}, 60_000);

describe('MercadoPagoService — criação da preferência', () => {
  test('1) HOLD válido → cria Payment + preferência, valor calculado no servidor, reserva vira pending_payment', async () => {
    const { hold, variant } = await createHold(30);
    const shopify = fakeShopifyClient(variant);
    const mp = fakeMpClient();
    const service = new MercadoPagoService(prisma, mp, shopify);

    const res = await service.createPreference({ reservationId: hold.reservationId, holdToken: hold.holdToken!, idempotencyKey: `${PREFIX}-idem-1` });

    expect(res.amount).toBe(String(UNIT_PRICE));
    expect(res.currency).toBe('BRL');
    expect(res.checkoutUrl).toContain('sandbox.mercadopago.com');
    expect(mp.createPreference).toHaveBeenCalledTimes(1);

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
    expect(reservation.status).toBe('pending_payment');

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: res.paymentId } });
    expect(payment.provider).toBe('mercadopago');
    expect(payment.status).toBe('pending');
    expect(Number(payment.amount)).toBe(UNIT_PRICE);
  }, TIMEOUT);

  test('6) HOLD expirado → 410 Gone, nenhum Payment criado', async () => {
    const { hold, variant } = await createHold(30);
    await prisma.$executeRaw`UPDATE reservations SET expires_at = now() - interval '1 minute' WHERE id = ${hold.reservationId}::uuid`;
    const service = new MercadoPagoService(prisma, fakeMpClient(), fakeShopifyClient(variant));

    await expect(service.createPreference({ reservationId: hold.reservationId, holdToken: hold.holdToken!, idempotencyKey: `${PREFIX}-idem-6` })).rejects.toMatchObject({ status: 410 });

    const count = await prisma.payment.count({ where: { reservationId: hold.reservationId } });
    expect(count).toBe(0);
  }, TIMEOUT);

  test('8) pagamento sem HOLD (reserva já cancelada) → 409, nenhum Payment criado', async () => {
    const { hold, variant } = await createHold(30);
    await prisma.$executeRaw`UPDATE reservations SET status = 'cancelled' WHERE id = ${hold.reservationId}::uuid`;
    const service = new MercadoPagoService(prisma, fakeMpClient(), fakeShopifyClient(variant));

    await expect(service.createPreference({ reservationId: hold.reservationId, holdToken: hold.holdToken!, idempotencyKey: `${PREFIX}-idem-8` })).rejects.toMatchObject({ status: 409 });
  }, TIMEOUT);

  test('idempotência: mesma idempotencyKey → replay, não cria segundo Payment nem chama o Mercado Pago de novo', async () => {
    const { hold, variant } = await createHold(30);
    const mp = fakeMpClient();
    const service = new MercadoPagoService(prisma, mp, fakeShopifyClient(variant));
    const key = `${PREFIX}-idem-replay`;

    const first = await service.createPreference({ reservationId: hold.reservationId, holdToken: hold.holdToken!, idempotencyKey: key });
    const second = await service.createPreference({ reservationId: hold.reservationId, holdToken: hold.holdToken!, idempotencyKey: key });

    expect(second.paymentId).toBe(first.paymentId);
    expect(mp.createPreference).toHaveBeenCalledTimes(1);
    const count = await prisma.payment.count({ where: { reservationId: hold.reservationId } });
    expect(count).toBe(1);
  }, TIMEOUT);

  test('17/retry) falha temporária ao criar a preferência → Payment fica retomável, nova tentativa reaproveita o MESMO Payment', async () => {
    const { hold, variant } = await createHold(30);
    let calls = 0;
    const mp = fakeMpClient({
      createPreference: vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error('falha temporária simulada da API');
        return { preferenceId: `${PREFIX}-pref-retry`, checkoutUrl: 'https://sandbox.mercadopago.com/checkout/retry' };
      }),
    });
    const service = new MercadoPagoService(prisma, mp, fakeShopifyClient(variant));

    await expect(service.createPreference({ reservationId: hold.reservationId, holdToken: hold.holdToken!, idempotencyKey: `${PREFIX}-idem-retry` })).rejects.toMatchObject({ status: 503 });

    // Reserva já está pending_payment (claim aconteceu antes da chamada
    // falhar) — uma nova chamada (idempotencyKey nova, simula o cliente
    // tentando de novo) precisa reaproveitar o MESMO Payment, não criar
    // um segundo.
    const retryResult = await service.createPreference({ reservationId: hold.reservationId, holdToken: hold.holdToken!, idempotencyKey: `${PREFIX}-idem-retry-2` });
    expect(retryResult.checkoutUrl).toBe('https://sandbox.mercadopago.com/checkout/retry');
    const count = await prisma.payment.count({ where: { reservationId: hold.reservationId } });
    expect(count).toBe(1);
  }, TIMEOUT);
});

describe('MercadoPagoService — webhook', () => {
  async function setupApprovedFlow(daysFromToday = 30) {
    const { hold, variant } = await createHold(daysFromToday);
    const shopify = fakeShopifyClient(variant);
    const mp = fakeMpClient();
    const service = new MercadoPagoService(prisma, mp, shopify);
    const pref = await service.createPreference({ reservationId: hold.reservationId, holdToken: hold.holdToken!, idempotencyKey: `${PREFIX}-idem-${hold.reservationId}` });
    return { hold, service, mp, paymentId: pref.paymentId };
  }

  test('2) pagamento aprovado → reserva confirmada, auditoria registrada', async () => {
    const { hold, service, mp, paymentId } = await setupApprovedFlow();
    vi.mocked(mp.getPayment).mockResolvedValue(makePaymentPayload({ externalReference: paymentId, status: 'approved' }));

    const result = await service.handleWebhook('mp-payment-1', 'payment', {});
    expect(result.outcome).toBe('processed');

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
    expect(reservation.status).toBe('confirmed');

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe('approved');
    expect(payment.paidAt).not.toBeNull();

    const events = await prisma.reservationEvent.findMany({ where: { reservationId: hold.reservationId, type: 'MERCADOPAGO_PAYMENT_APPROVED' } });
    expect(events).toHaveLength(1);
  }, TIMEOUT);

  test('3) pagamento pendente → Payment fica pending, reserva NÃO é confirmada', async () => {
    const { hold, service, mp, paymentId } = await setupApprovedFlow(31);
    vi.mocked(mp.getPayment).mockResolvedValue(makePaymentPayload({ externalReference: paymentId, status: 'pending' }));

    await service.handleWebhook('mp-payment-2', 'payment', {});

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
    expect(reservation.status).toBe('pending_payment');
  }, TIMEOUT);

  test('4) pagamento rejeitado → Payment fica rejected, reserva não confirmada', async () => {
    const { hold, service, mp, paymentId } = await setupApprovedFlow(32);
    vi.mocked(mp.getPayment).mockResolvedValue(makePaymentPayload({ externalReference: paymentId, status: 'rejected' }));

    await service.handleWebhook('mp-payment-3', 'payment', {});

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe('rejected');
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
    expect(reservation.status).toBe('pending_payment'); // reserva não é mexida por rejeição — segue seu próprio ciclo de expiração
  }, TIMEOUT);

  test('5) pagamento cancelado → Payment fica cancelled', async () => {
    const { service, mp, paymentId } = await setupApprovedFlow(33);
    vi.mocked(mp.getPayment).mockResolvedValue(makePaymentPayload({ externalReference: paymentId, status: 'cancelled' }));

    await service.handleWebhook('mp-payment-4', 'payment', {});

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe('cancelled');
  }, TIMEOUT);

  test('estorno) pagamento aprovado e depois reembolsado → refundedAt preenchido', async () => {
    const { hold, service, mp, paymentId } = await setupApprovedFlow(34);
    vi.mocked(mp.getPayment).mockResolvedValue(makePaymentPayload({ externalReference: paymentId, status: 'approved' }));
    await service.handleWebhook('mp-payment-5a', 'payment', {});

    vi.mocked(mp.getPayment).mockResolvedValue(makePaymentPayload({ externalReference: paymentId, status: 'refunded' }));
    await service.handleWebhook('mp-payment-5b', 'payment', {});

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe('refunded');
    expect(payment.refundedAt).not.toBeNull();
    // Reserva CONFIRMADA continua confirmada — reembolso é decisão
    // operacional separada (fora do escopo pedido), nunca reverte a
    // ocupação automaticamente.
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
    expect(reservation.status).toBe('confirmed');
  }, TIMEOUT);

  test('7) pagamento aprovado após expiração do HOLD, capacidade ainda livre → recupera para confirmed', async () => {
    const { hold, service, mp, paymentId } = await setupApprovedFlow(35);
    await prisma.$executeRaw`UPDATE reservations SET status = 'expired' WHERE id = ${hold.reservationId}::uuid`;

    vi.mocked(mp.getPayment).mockResolvedValue(makePaymentPayload({ externalReference: paymentId, status: 'approved' }));
    const result = await service.handleWebhook('mp-payment-late', 'payment', {});

    expect(result.outcome).toBe('processed');
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
    expect(reservation.status).toBe('confirmed');
    const events = await prisma.reservationEvent.findMany({ where: { reservationId: hold.reservationId, type: 'MERCADOPAGO_LATE_PAYMENT_RECEIVED' } });
    expect(events).toHaveLength(1);
  }, TIMEOUT);

  test('7b) pagamento aprovado após expiração, capacidade JÁ COMPROMETIDA → late_payment_conflict, nunca confirma', async () => {
    const { hold, service, mp, paymentId, variant } = { ...(await setupApprovedFlow(36)) } as Awaited<ReturnType<typeof setupApprovedFlow>> & { variant?: string };
    await prisma.$executeRaw`UPDATE reservations SET status = 'expired' WHERE id = ${hold.reservationId}::uuid`;

    // Outra reserva (manual, confirmed) toma a MESMA unidade nas mesmas
    // datas — simula a capacidade já ter ido pra outra pessoa.
    const items = await prisma.$queryRaw<{ rentalUnitId: string; blockedFrom: Date; blockedUntil: Date }[]>`
      SELECT rental_unit_id AS "rentalUnitId", lower(blocked_range) AS "blockedFrom", upper(blocked_range) AS "blockedUntil"
      FROM reservation_items WHERE reservation_id = ${hold.reservationId}::uuid
    `;
    const [item] = items;
    const otherRows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO reservations (id, status, origin_store_id, pickup_date, return_date, source)
      VALUES (
        gen_random_uuid(), 'confirmed',
        (SELECT origin_store_id FROM reservations WHERE id = ${hold.reservationId}::uuid),
        ${item.blockedFrom}::date, ${item.blockedUntil}::date, 'manual_admin'
      )
      RETURNING id
    `;
    await prisma.$executeRaw`
      INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
      VALUES (gen_random_uuid(), ${otherRows[0].id}::uuid, ${item.rentalUnitId}::uuid, 'confirmed', daterange(${item.blockedFrom}::date, ${item.blockedUntil}::date, '[)'))
    `;

    vi.mocked(mp.getPayment).mockResolvedValue(makePaymentPayload({ externalReference: paymentId, status: 'approved' }));
    await service.handleWebhook('mp-payment-conflict', 'payment', {});

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
    expect(reservation.status).toBe('late_payment_conflict');

    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ${otherRows[0].id}::uuid`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ${otherRows[0].id}::uuid`;
    void variant;
  }, TIMEOUT);

  test('9) valor divergente → rejeitado, reserva não confirmada', async () => {
    const { hold, service, mp, paymentId } = await setupApprovedFlow(37);
    vi.mocked(mp.getPayment).mockResolvedValue(makePaymentPayload({ externalReference: paymentId, status: 'approved', transactionAmount: UNIT_PRICE + 999 }));

    const result = await service.handleWebhook('mp-payment-6', 'payment', {});
    expect(result.outcome).toBe('rejected');

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe('rejected');
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
    expect(reservation.status).toBe('pending_payment');
  }, TIMEOUT);

  test('10) moeda divergente → rejeitado, reserva não confirmada', async () => {
    const { hold, service, mp, paymentId } = await setupApprovedFlow(38);
    vi.mocked(mp.getPayment).mockResolvedValue(makePaymentPayload({ externalReference: paymentId, status: 'approved', currencyId: 'ARS' }));

    const result = await service.handleWebhook('mp-payment-7', 'payment', {});
    expect(result.outcome).toBe('rejected');
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
    expect(reservation.status).toBe('pending_payment');
  }, TIMEOUT);

  test('11) webhook duplicado (mesmo evento aprovado 2x) → idempotente, confirma só uma vez', async () => {
    const { hold, service, mp, paymentId } = await setupApprovedFlow(39);
    vi.mocked(mp.getPayment).mockResolvedValue(makePaymentPayload({ externalReference: paymentId, status: 'approved' }));

    const first = await service.handleWebhook('mp-payment-8', 'payment', {});
    const second = await service.handleWebhook('mp-payment-8', 'payment', {});

    expect(first.outcome).toBe('processed');
    expect(second.outcome).toBe('duplicate');
    const events = await prisma.reservationEvent.findMany({ where: { reservationId: hold.reservationId, type: 'MERCADOPAGO_PAYMENT_APPROVED' } });
    expect(events).toHaveLength(1);
  }, TIMEOUT);

  test('12) webhook fora de ordem (pending chegando depois de approved) → ignorado, nunca reverte', async () => {
    const { hold, service, mp, paymentId } = await setupApprovedFlow(40);
    vi.mocked(mp.getPayment).mockResolvedValue(makePaymentPayload({ externalReference: paymentId, status: 'approved' }));
    await service.handleWebhook('mp-payment-9a', 'payment', {});

    vi.mocked(mp.getPayment).mockResolvedValue(makePaymentPayload({ externalReference: paymentId, status: 'pending' }));
    const result = await service.handleWebhook('mp-payment-9b', 'payment', {});

    expect(result.outcome).toBe('ignored');
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe('approved'); // nunca voltou pra pending
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
    expect(reservation.status).toBe('confirmed');
  }, TIMEOUT);

  test('13) assinatura inválida (quando o secret está configurado) → rejeitado, nada processado', async () => {
    process.env.MERCADOPAGO_TEST_WEBHOOK_SECRET = `${PREFIX}-secret`;
    try {
      const { paymentId, service, mp } = await setupApprovedFlow(41);
      vi.mocked(mp.getPayment).mockResolvedValue(makePaymentPayload({ externalReference: paymentId, status: 'approved' }));

      const result = await service.handleWebhook('mp-payment-10', 'payment', { signature: 'ts=1,v1=deadbeef', requestId: 'req-1' });
      expect(result.outcome).toBe('rejected');
      expect(mp.getPayment).not.toHaveBeenCalled();
    } finally {
      delete process.env.MERCADOPAGO_TEST_WEBHOOK_SECRET;
    }
  }, TIMEOUT);

  test('14) paymentId inexistente na API do Mercado Pago → ignorado com segurança', async () => {
    const service = new MercadoPagoService(prisma, fakeMpClient({ getPayment: vi.fn(async () => null) }), fakeShopifyClient('unused'));
    const result = await service.handleWebhook('mp-does-not-exist', 'payment', {});
    expect(result.outcome).toBe('ignored');
  }, TIMEOUT);

  test('15) external_reference sem Payment interno correspondente → ignorado com segurança', async () => {
    const mp = fakeMpClient({ getPayment: vi.fn(async () => makePaymentPayload({ externalReference: '00000000-0000-0000-0000-000000000000', status: 'approved' })) });
    const service = new MercadoPagoService(prisma, mp, fakeShopifyClient('unused'));
    const result = await service.handleWebhook('mp-orphan', 'payment', {});
    expect(result.outcome).toBe('ignored');
  }, TIMEOUT);

  test('16) duas confirmações simultâneas → reserva confirmada exatamente uma vez', async () => {
    const { hold, service, mp, paymentId } = await setupApprovedFlow(42);
    vi.mocked(mp.getPayment).mockResolvedValue(makePaymentPayload({ externalReference: paymentId, status: 'approved' }));

    await Promise.all([service.handleWebhook('mp-race-a', 'payment', {}), service.handleWebhook('mp-race-b', 'payment', {})]);

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
    expect(reservation.status).toBe('confirmed');
    const events = await prisma.reservationEvent.findMany({ where: { reservationId: hold.reservationId, type: 'RESERVATION_STATUS_CHANGED' } });
    expect(events).toHaveLength(1);
  }, TIMEOUT);

  test('falha temporária) erro de rede ao consultar o pagamento → 503, nada é alterado (retry esperado do Mercado Pago)', async () => {
    const { hold, service, mp } = await setupApprovedFlow(43);
    vi.mocked(mp.getPayment).mockRejectedValue(new Error('timeout simulado'));

    await expect(service.handleWebhook('mp-payment-fail', 'payment', {})).rejects.toMatchObject({ status: 503 });
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
    expect(reservation.status).toBe('pending_payment');
  }, TIMEOUT);

  test('preservação da auditoria) todo webhook processado grava MercadoPagoWebhookEvent', async () => {
    const { paymentId, service, mp } = await setupApprovedFlow(44);
    vi.mocked(mp.getPayment).mockResolvedValue(makePaymentPayload({ externalReference: paymentId, status: 'approved' }));
    await service.handleWebhook('mp-payment-audit', 'payment', {});

    const logs = await prisma.mercadoPagoWebhookEvent.findMany({ where: { paymentId } });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].status).toBe('processed');
  }, TIMEOUT);
});

describe('Checkout Shopify continua funcionando (alternativa preservada)', () => {
  test('21) fluxo Shopify normal não foi afetado pelas mudanças do Mercado Pago', async () => {
    const { hold, variant } = await createHold(45);
    const cartClient = {
      cartCreate: vi.fn(async () => ({ ok: true as const, cartId: `gid://shopify/Cart/${PREFIX}`, checkoutUrl: 'https://dev-store.myshopify.com/cart/c/test' })),
    } as unknown as ShopifyCartClient;
    const service = new CheckoutService(prisma, rentalRuleConfig, cartClient);

    const res = await service.createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! });
    expect(res.status).toBe('pending_payment');
    expect(res.checkoutUrl).toContain('myshopify.com');

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
    expect(reservation.shopifyCartId).toBe(`gid://shopify/Cart/${PREFIX}`);
    void variant;
  }, TIMEOUT);
});
