import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from './webhooks.service';
import { resolveReservationBindingSecret } from '../checkout/checkout.config';
import { canonicalItemsFingerprint, computeReservationSignature, generateReservationBindingId } from '../reservation-binding';
import { civilDateToISO, addDays, type CivilDate } from '../rental-rules/civil-date';
import type { ShopifyOrderPayload, ShopifyRefundPayload } from './shopify-order-payload';

// Segredo só pra este arquivo — nunca reaproveita SHOPIFY_CLIENT_SECRET
// (são segredos de propósitos diferentes). Sem fallback de dev em
// resolveReservationBindingSecret(), então tem que estar setado antes de
// qualquer teste que gere/verifique uma assinatura.
process.env.RESERVATION_BINDING_SECRET ??= 'test-reservation-binding-secret-webhooks';

/**
 * Integração real (Neon) — webhooks são de ENTRADA (a Shopify chama a
 * gente), então dá pra testar o fluxo inteiro sem mock nenhum: construo
 * um payload real, chamo `WebhooksService.handleIncoming` diretamente
 * (a verificação HMAC/corpo cru é testada separadamente em
 * webhooks.controller.e2e.test.ts — é uma preocupação de camada HTTP,
 * não de negócio) e confirmo o estado real no Postgres depois.
 *
 * Endurecimento da correlação Order↔Reservation (pedido antes de
 * continuar a Fase 7): a maioria dos pedidos de teste agora precisa
 * trafegar `reservation_binding_id`/`reservation_signature` além de
 * `reservation_id` — `signedOrderPayload()` monta isso a partir do
 * estado REAL da fixture (mesmo cálculo que WebhooksService recomputa no
 * servidor), e um describe dedicado no fim testa cada jeito de a
 * correlação NÃO bater.
 */
const prisma = new PrismaService();
const service = new WebhooksService(prisma);
const PREFIX = `WH-${Date.now()}`;
let unitCounter = 0;
let orderCounter = 1_000_000;
let webhookIdCounter = 0;
let cartIdCounter = 0;

function nextWebhookId(): string {
  return `${PREFIX}-webhook-${webhookIdCounter++}`;
}
function nextOrderId(): number {
  return orderCounter++;
}

interface UnitFixture {
  id: string;
  variantId: string;
}

async function createUnit(): Promise<UnitFixture> {
  const code = `${PREFIX}-u${unitCounter++}`;
  const variantId = `${code}-variant`;
  const unit = await prisma.rentalUnit.create({
    data: { code, name: 'peça de teste', shopifyVariantId: variantId, active: true, reservableOnline: true, countsTowardRentalDuration: true },
  });
  return { id: unit.id, variantId };
}

interface ReservationFixture {
  reservationId: string;
  pickup: CivilDate;
  effectiveReturn: CivilDate;
  /** Binding realmente persistido nesta reservation (null = nunca
   *  completou nosso checkout, então nenhum binding existe pra provar). */
  bindingId: string | null;
  /** Fingerprint das peças REAIS desta reservation — o que o servidor
   *  recalcula a partir do banco, nunca o que o pedido diz. */
  itemsFingerprint: string;
  unitVariantIds: string[];
}

/** Cria uma Reservation direto via SQL (não passa por HoldsService/
 *  CheckoutService — mais rápido, e webhooks não dependem de holdToken)
 *  já no estado que os testes precisam: checkoutState='ready',
 *  shopifyCartId preenchido, e — desde o endurecimento — um
 *  reservation_binding_id persistido por padrão (é o que um checkout
 *  concluído normalmente teria feito; passe `bindingId: null`
 *  explicitamente pra simular uma reservation que nunca completou
 *  checkout). */
async function createReservation(
  units: UnitFixture[],
  status: string,
  daysFromToday: number,
  opts: {
    shopifyOrderId?: string;
    checkoutState?: string;
    shopifyCartId?: string | null;
    paymentExpiresAt?: Date;
    bindingId?: string | null;
  } = {},
): Promise<ReservationFixture> {
  const pickup = addDays({ year: 2027, month: 1, day: 1 }, daysFromToday);
  const effectiveReturn = addDays(pickup, 2);
  const blockedFrom = addDays(pickup, -3);
  const blockedUntil = addDays(effectiveReturn, 3);

  const checkoutState = opts.checkoutState ?? 'ready';
  // Sempre único por padrão (contador global do arquivo) —
  // shopifyCartId é UNIQUE em reservations; dois fixtures da mesma
  // unidade/data (ex.: teste de conflito de late payment, que cria DUAS
  // reservations de propósito) não podem colidir nesse valor. Mesma
  // lógica pra reservation_binding_id, também UNIQUE.
  const shopifyCartId = opts.shopifyCartId === undefined ? `${PREFIX}-cart-${cartIdCounter++}` : opts.shopifyCartId;
  const bindingId = opts.bindingId === undefined ? generateReservationBindingId() : opts.bindingId;

  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservations (id, status, origin_store_id, pickup_date, return_date, checkout_state, shopify_cart_id, shopify_order_id, payment_expires_at, terms_accepted_at, terms_version, reservation_binding_id)
    VALUES (
      gen_random_uuid(), ${status}::"reservation_status", 'dev-store',
      ${civilDateToISO(pickup)}::date, ${civilDateToISO(effectiveReturn)}::date,
      ${checkoutState}::"checkout_state", ${shopifyCartId}, ${opts.shopifyOrderId ?? null},
      ${opts.paymentExpiresAt ?? null}, now(), 'test', ${bindingId}
    )
    RETURNING id
  `;
  const reservationId = rows[0].id;

  for (const unit of units) {
    await prisma.$executeRaw`
      INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
      VALUES (gen_random_uuid(), ${reservationId}::uuid, ${unit.id}::uuid, ${status}::"reservation_status",
        daterange(${civilDateToISO(blockedFrom)}::date, ${civilDateToISO(blockedUntil)}::date, '[)'))
    `;
  }

  const itemsFingerprint = canonicalItemsFingerprint(units.map((u) => ({ variantId: u.variantId, quantity: 1 })));

  return { reservationId, pickup, effectiveReturn, bindingId, itemsFingerprint, unitVariantIds: units.map((u) => u.variantId) };
}

/** Monta um pedido "legítimo" pra uma fixture: reservation_id +
 *  reservation_binding_id + reservation_signature calculados exatamente
 *  como o servidor recalcularia, e line_items batendo com as peças
 *  reais. Se `fixture.bindingId` é null (nunca completou checkout), o
 *  pedido sai SEM atributos de binding — é o caso "só reservation_id",
 *  que o servidor deve recusar (ver describe de endurecimento). */
function signedOrderPayload(fixture: ReservationFixture, overrides: Partial<ShopifyOrderPayload> & { id: number }): ShopifyOrderPayload {
  const noteAttributes: { name: string; value: string }[] = [{ name: 'reservation_id', value: fixture.reservationId }];
  if (fixture.bindingId) {
    const secret = resolveReservationBindingSecret();
    const signature = computeReservationSignature(secret, {
      reservationId: fixture.reservationId,
      reservationBindingId: fixture.bindingId,
      itemsFingerprint: fixture.itemsFingerprint,
      pickupDate: civilDateToISO(fixture.pickup),
      effectiveReturnDate: civilDateToISO(fixture.effectiveReturn),
    });
    noteAttributes.push({ name: 'reservation_binding_id', value: fixture.bindingId });
    noteAttributes.push({ name: 'reservation_signature', value: signature });
  }
  return {
    admin_graphql_api_id: `gid://shopify/Order/${overrides.id}`,
    financial_status: 'paid',
    note_attributes: noteAttributes,
    line_items: fixture.unitVariantIds.map((variantId) => ({ variant_id: variantId, quantity: 1 })),
    ...overrides,
  };
}

/** Pedido "cru", sem binding/assinatura nenhuma — só pra testes que nem
 *  chegam a ter uma Reservation real pra correlacionar (reservation_id
 *  ausente/inexistente) ou que deliberadamente simulam um atacante que
 *  só copiou o reservation_id. */
function orderPayload(reservationId: string | null, overrides: Partial<ShopifyOrderPayload> & { id: number }): ShopifyOrderPayload {
  return {
    admin_graphql_api_id: `gid://shopify/Order/${overrides.id}`,
    financial_status: 'paid',
    note_attributes: reservationId ? [{ name: 'reservation_id', value: reservationId }] : [],
    ...overrides,
  };
}

async function cleanup() {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id
    FROM reservation_items ri
    JOIN rental_units ru ON ru.id = ri.rental_unit_id
    WHERE ru.code LIKE ${PREFIX + '%'}
  `;
  const reservationIds = rows.map((r) => r.id);

  // webhook_events deste arquivo — por prefixo do id (cobre entregas
  // que nunca chegaram a vincular reservation nenhuma, ex.: teste 8).
  const webhookRows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM webhook_events WHERE shopify_webhook_id LIKE ${PREFIX + '%'}
  `;
  const webhookEventIds = webhookRows.map((r) => r.id);

  // reservation_events aponta pra reservation E/OU webhook_event — tem
  // que sumir ANTES dos dois, senão a FK de qualquer um dos dois lados
  // trava o DELETE (foi exatamente o bug daqui: um evento sem
  // reservation_id mas COM webhook_event_id sobrava e travava o DELETE
  // de webhook_events).
  if (reservationIds.length || webhookEventIds.length) {
    await prisma.$executeRaw`
      DELETE FROM reservation_events
      WHERE reservation_id = ANY(${reservationIds}::uuid[]) OR webhook_event_id = ANY(${webhookEventIds}::uuid[])
    `;
  }
  if (webhookEventIds.length) {
    await prisma.$executeRaw`DELETE FROM webhook_events WHERE id = ANY(${webhookEventIds}::uuid[])`;
  }
  if (reservationIds.length) {
    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${reservationIds}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
}

beforeAll(cleanup);
afterAll(async () => {
  try {
    await cleanup();
  } catch (err) {
    console.error('DEBUG afterAll cleanup falhou:', err);
    throw err;
  }
  await prisma.$disconnect();
}, 60_000);

describe('WebhooksService — correlação e confirmação normal', () => {
  test('7) reservation_id ausente → ignored, nenhuma reserva tocada', async () => {
    const res = await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: orderPayload(null, { id: nextOrderId() }) });
    expect(res.outcome).toBe('ignored');
  });

  test('8) reservation_id de UUID válido mas inexistente → ignored, fail closed', async () => {
    const res = await service.handleIncoming({
      topic: 'orders/paid',
      shopifyWebhookId: nextWebhookId(),
      payload: orderPayload('00000000-0000-0000-0000-000000000000', { id: nextOrderId() }),
    });
    expect(res.outcome).toBe('ignored');
  });

  test('9) reservation existe mas nunca completou nosso checkout (nenhum binding persistido) → problem, nunca ignorado silenciosamente', async () => {
    const unit = await createUnit();
    const fixture = await createReservation([unit], 'hold', 100, { checkoutState: 'none', shopifyCartId: null, bindingId: null });
    const res = await service.handleIncoming({
      topic: 'orders/paid',
      shopifyWebhookId: nextWebhookId(),
      payload: signedOrderPayload(fixture, { id: nextOrderId() }),
    });
    expect(res.outcome).toBe('processed');
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    expect(reservation.status).toBe('problem'); // não fica em "hold" mudo — alguém tentou correlacionar um pedido real com isto
  });

  test('10) pending_payment + pagamento válido (binding assinado correto) → confirmed, confirmedAt gravado, order vinculado', async () => {
    const unit = await createUnit();
    const fixture = await createReservation([unit], 'pending_payment', 101);
    const orderId = nextOrderId();
    const res = await service.handleIncoming({
      topic: 'orders/paid',
      shopifyWebhookId: nextWebhookId(),
      payload: signedOrderPayload(fixture, { id: orderId }),
    });
    expect(res.outcome).toBe('processed');

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    expect(reservation.status).toBe('confirmed');
    expect(reservation.confirmedAt).not.toBeNull();
    expect(reservation.shopifyOrderId).toBe(String(orderId));
    expect(reservation.shopifyOrderGid).toBe(`gid://shopify/Order/${orderId}`);
  });

  test('22) ReservationItem segue o trigger — nunca é escrito diretamente, mas reflete o status novo', async () => {
    const unit = await createUnit();
    const fixture = await createReservation([unit], 'pending_payment', 102);
    await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: signedOrderPayload(fixture, { id: nextOrderId() }) });

    const items = await prisma.$queryRaw<{ status: string }[]>`SELECT status FROM reservation_items WHERE reservation_id = ${fixture.reservationId}::uuid`;
    expect(items.every((i) => i.status === 'confirmed')).toBe(true);
  });

  test('11) confirmed + webhook duplicado (mesmo shopifyWebhookId) → outcome duplicate, continua confirmed', async () => {
    const unit = await createUnit();
    const fixture = await createReservation([unit], 'pending_payment', 103);
    const orderId = nextOrderId();
    const webhookId = nextWebhookId();
    const payload = signedOrderPayload(fixture, { id: orderId });

    const first = await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: webhookId, payload });
    expect(first.outcome).toBe('processed');
    const second = await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: webhookId, payload });
    expect(second.outcome).toBe('duplicate');

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    expect(reservation.status).toBe('confirmed');

    const events = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM webhook_events WHERE shopify_webhook_id = ${webhookId}`;
    expect(Number(events[0].count)).toBe(1); // uma linha só, attemptCount incrementado nela
  }, 20_000);

  test('confirmed + evento DIFERENTE (novo shopifyWebhookId) reconfirmando o mesmo pedido → idempotente, não duplica efeito', async () => {
    const unit = await createUnit();
    const fixture = await createReservation([unit], 'pending_payment', 104);
    const orderId = nextOrderId();
    await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: signedOrderPayload(fixture, { id: orderId }) });

    // orders/create chegando DEPOIS de orders/paid já ter confirmado —
    // webhook diferente, mesmo pedido (item 15: fora de ordem).
    const res = await service.handleIncoming({
      topic: 'orders/create',
      shopifyWebhookId: nextWebhookId(),
      payload: signedOrderPayload(fixture, { id: orderId }),
    });
    expect(res.outcome).toBe('processed');
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    expect(reservation.status).toBe('confirmed'); // continua confirmed, não regrediu
  }, 20_000);

  test('15) fora de ordem: orders/create chega ANTES de orders/paid → orders/create não confirma sozinho, orders/paid confirma depois', async () => {
    const unit = await createUnit();
    const fixture = await createReservation([unit], 'pending_payment', 105);
    const orderId = nextOrderId();

    const createRes = await service.handleIncoming({
      topic: 'orders/create',
      shopifyWebhookId: nextWebhookId(),
      payload: signedOrderPayload(fixture, { id: orderId, financial_status: 'pending' }),
    });
    expect(createRes.outcome).toBe('processed');
    let reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    expect(reservation.status).toBe('pending_payment'); // orders/create sozinho (não pago) não confirma
    expect(reservation.shopifyOrderId).toBe(String(orderId)); // mas já vincula o pedido

    const paidRes = await service.handleIncoming({
      topic: 'orders/paid',
      shopifyWebhookId: nextWebhookId(),
      payload: signedOrderPayload(fixture, { id: orderId }),
    });
    expect(paidRes.outcome).toBe('processed');
    reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    expect(reservation.status).toBe('confirmed');
  }, 20_000);
});

describe('WebhooksService — late payment (item 8/9 da Fase 7)', () => {
  test('12) expired + pagamento tardio + unidade original livre → confirmed (recuperação atômica)', async () => {
    const unit = await createUnit();
    const fixture = await createReservation([unit], 'expired', 110);
    const res = await service.handleIncoming({
      topic: 'orders/paid',
      shopifyWebhookId: nextWebhookId(),
      payload: signedOrderPayload(fixture, { id: nextOrderId() }),
    });
    expect(res.outcome).toBe('processed');
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    expect(reservation.status).toBe('confirmed');
    expect(reservation.confirmedAt).not.toBeNull();
  });

  test('13/14) expired + pagamento tardio + unidade original já comprometida por OUTRA reserva → late_payment_conflict, nunca confirmed', async () => {
    const unit = await createUnit();
    const fixture = await createReservation([unit], 'expired', 111);
    // Outra reserva real ocupa a MESMA unidade para o MESMO período
    // (simulando: a unidade foi liberada e outro cliente reservou).
    await createReservation([unit], 'confirmed', 111);

    const res = await service.handleIncoming({
      topic: 'orders/paid',
      shopifyWebhookId: nextWebhookId(),
      payload: signedOrderPayload(fixture, { id: nextOrderId() }),
    });
    expect(res.outcome).toBe('processed');
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    expect(reservation.status).toBe('late_payment_conflict');
    expect(reservation.confirmedAt).toBeNull();

    // A reserva perdedora NÃO pode continuar "ocupando" fisicamente —
    // late_payment_conflict é deliberadamente excluído de
    // OCCUPYING_RESERVATION_STATUSES (ver schema.prisma).
    const items = await prisma.$queryRaw<{ status: string }[]>`SELECT status FROM reservation_items WHERE reservation_id = ${fixture.reservationId}::uuid`;
    expect(items.every((i) => i.status === 'late_payment_conflict')).toBe(true);
  });
});

describe('WebhooksService — cancelamento', () => {
  test('16) cancelamento antes da retirada (confirmed) → cancelled', async () => {
    const unit = await createUnit();
    const orderId = nextOrderId();
    const fixture = await createReservation([unit], 'confirmed', 120, { shopifyOrderId: String(orderId) });
    const res = await service.handleIncoming({
      topic: 'orders/cancelled',
      shopifyWebhookId: nextWebhookId(),
      payload: orderPayload(null, { id: orderId, cancel_reason: 'customer' }),
    });
    expect(res.outcome).toBe('processed');
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    expect(reservation.status).toBe('cancelled');
  });

  test('17) cancelamento chegando depois de picked_up → NÃO cancela automaticamente, vira problem', async () => {
    const unit = await createUnit();
    const orderId = nextOrderId();
    const fixture = await createReservation([unit], 'picked_up', 121, { shopifyOrderId: String(orderId) });
    const res = await service.handleIncoming({
      topic: 'orders/cancelled',
      shopifyWebhookId: nextWebhookId(),
      payload: orderPayload(null, { id: orderId }),
    });
    expect(res.outcome).toBe('processed');
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    expect(reservation.status).toBe('problem');
    expect(reservation.status).not.toBe('cancelled');
  });

  test('cancelamento sem pedido vinculado a nenhuma reserva → ignored', async () => {
    const res = await service.handleIncoming({
      topic: 'orders/cancelled',
      shopifyWebhookId: nextWebhookId(),
      payload: orderPayload(null, { id: nextOrderId() }),
    });
    expect(res.outcome).toBe('ignored');
  });
});

describe('WebhooksService — refund', () => {
  function refundPayload(orderId: number, amounts: string[]): ShopifyRefundPayload {
    return { id: orderId * 10, order_id: orderId, transactions: amounts.map((amount) => ({ amount })) };
  }

  test('18) refund parcial em reserva confirmed → problem, unidade NÃO liberada (item continua ocupando)', async () => {
    const unit = await createUnit();
    const orderId = nextOrderId();
    const fixture = await createReservation([unit], 'confirmed', 130, { shopifyOrderId: String(orderId) });

    const res = await service.handleIncoming({ topic: 'refunds/create', shopifyWebhookId: nextWebhookId(), payload: refundPayload(orderId, ['50.00']) });
    expect(res.outcome).toBe('processed');

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    expect(reservation.status).toBe('problem');
    const items = await prisma.$queryRaw<{ status: string }[]>`SELECT status FROM reservation_items WHERE reservation_id = ${fixture.reservationId}::uuid`;
    expect(items.every((i) => i.status === 'problem')).toBe(true); // 'problem' está em OCCUPYING_RESERVATION_STATUSES — continua bloqueando
  });

  test('19) refund total em reserva pending_payment → problem também (mesmo tratamento conservador)', async () => {
    const unit = await createUnit();
    const orderId = nextOrderId();
    const fixture = await createReservation([unit], 'pending_payment', 131, { shopifyOrderId: String(orderId) });

    const res = await service.handleIncoming({ topic: 'refunds/create', shopifyWebhookId: nextWebhookId(), payload: refundPayload(orderId, ['150.00']) });
    expect(res.outcome).toBe('processed');
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    expect(reservation.status).toBe('problem');
  });

  test('refund em reserva já cancelled → só registra, não muda status', async () => {
    const unit = await createUnit();
    const orderId = nextOrderId();
    const fixture = await createReservation([unit], 'cancelled', 132, { shopifyOrderId: String(orderId) });

    await service.handleIncoming({ topic: 'refunds/create', shopifyWebhookId: nextWebhookId(), payload: refundPayload(orderId, ['150.00']) });
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    expect(reservation.status).toBe('cancelled');
  });
});

describe('WebhooksService — concorrência', () => {
  test('29) duas instâncias processando o MESMO evento simultaneamente → só um efeito real, uma vira duplicate', async () => {
    const unit = await createUnit();
    const fixture = await createReservation([unit], 'pending_payment', 140);
    const webhookId = nextWebhookId();
    const payload = signedOrderPayload(fixture, { id: nextOrderId() });

    const [a, b] = await Promise.all([
      service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: webhookId, payload }),
      service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: webhookId, payload }),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['duplicate', 'processed']);

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    expect(reservation.status).toBe('confirmed');
    const count = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM webhook_events WHERE shopify_webhook_id = ${webhookId}`;
    expect(Number(count[0].count)).toBe(1);
  }, 20_000);
});

describe('WebhooksService — tópico não tratado', () => {
  test('tópico desconhecido/não assinado → ignored, sem erro', async () => {
    const res = await service.handleIncoming({ topic: 'products/update', shopifyWebhookId: nextWebhookId(), payload: { id: 1 } });
    expect(res.outcome).toBe('ignored');
  });
});

describe('WebhooksService — endurecimento do binding assinado Order↔Reservation', () => {
  test('só reservation_id, sem reservation_binding_id/reservation_signature (atacante copiou só o atributo público) → problem, nunca confirmed', async () => {
    const unit = await createUnit();
    const fixture = await createReservation([unit], 'pending_payment', 150);
    const res = await service.handleIncoming({
      topic: 'orders/paid',
      shopifyWebhookId: nextWebhookId(),
      payload: orderPayload(fixture.reservationId, { id: nextOrderId() }),
    });
    expect(res.outcome).toBe('processed');
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    expect(reservation.status).toBe('problem');
    expect(reservation.confirmedAt).toBeNull();
  });

  test('reservation_signature adulterada (valor trocado) → problem, nunca confirmed', async () => {
    const unit = await createUnit();
    const fixture = await createReservation([unit], 'pending_payment', 151);
    const payload = signedOrderPayload(fixture, { id: nextOrderId() });
    const tampered: ShopifyOrderPayload = {
      ...payload,
      note_attributes: payload.note_attributes!.map((a) => (a.name === 'reservation_signature' ? { ...a, value: 'f'.repeat(64) } : a)),
    };
    const res = await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: tampered });
    expect(res.outcome).toBe('processed');
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    expect(reservation.status).toBe('problem');
  });

  test('reservation_binding_id de uma tentativa antiga (assinatura cripto válida PARA ELE, mas não é o binding atual da reserva) → problem', async () => {
    const unit = await createUnit();
    const fixture = await createReservation([unit], 'pending_payment', 152);
    // Simula: um checkout anterior gerou este binding e nunca chegou a
    // 'ready' (foi sobrescrito pelo binding atual, gravado no banco); um
    // cart abandonado daquela tentativa ainda tem atributos
    // criptograficamente consistentes ENTRE SI — só não batem com o que
    // está persistido agora.
    const staleFixture: ReservationFixture = { ...fixture, bindingId: 'stale-checkout-attempt-binding-id' };
    const res = await service.handleIncoming({
      topic: 'orders/paid',
      shopifyWebhookId: nextWebhookId(),
      payload: signedOrderPayload(staleFixture, { id: nextOrderId() }),
    });
    expect(res.outcome).toBe('processed');
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    expect(reservation.status).toBe('problem');
  });

  test('linhas reais do pedido não batem com as peças da reserva (variant divergente) → problem', async () => {
    const unit = await createUnit();
    const fixture = await createReservation([unit], 'pending_payment', 153);
    const payload = signedOrderPayload(fixture, { id: nextOrderId() });
    const tampered: ShopifyOrderPayload = { ...payload, line_items: [{ variant_id: 'variante-completamente-diferente', quantity: 1 }] };
    const res = await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: tampered });
    expect(res.outcome).toBe('processed');
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    expect(reservation.status).toBe('problem');
  });

  test('binding assinado corretamente mas checkoutState não é ready (defesa em profundidade — não deveria acontecer no fluxo normal) → problem', async () => {
    const unit = await createUnit();
    const fixture = await createReservation([unit], 'hold', 154, { checkoutState: 'creating', shopifyCartId: null });
    const res = await service.handleIncoming({
      topic: 'orders/paid',
      shopifyWebhookId: nextWebhookId(),
      payload: signedOrderPayload(fixture, { id: nextOrderId() }),
    });
    expect(res.outcome).toBe('processed');
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    expect(reservation.status).toBe('problem');
  });

  test('replay: um segundo pedido tenta reusar o mesmo reservation_id + binding/signature depois do primeiro já ter vinculado a reserva → problem (DUPLICATE_ORDER), primeira confirmação preservada', async () => {
    const unit = await createUnit();
    const fixture = await createReservation([unit], 'pending_payment', 155);
    const firstOrderId = nextOrderId();
    const first = await service.handleIncoming({
      topic: 'orders/paid',
      shopifyWebhookId: nextWebhookId(),
      payload: signedOrderPayload(fixture, { id: firstOrderId }),
    });
    expect(first.outcome).toBe('processed');
    let reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    expect(reservation.status).toBe('confirmed');
    const confirmedAtAfterFirst = reservation.confirmedAt;

    // Pedido REAL diferente, mas reaproveitando os MESMOS atributos
    // assinados (mesmo reservation_id/binding/signature) — o cenário
    // exato descrito no pedido de endurecimento.
    const secondOrderId = nextOrderId();
    const second = await service.handleIncoming({
      topic: 'orders/paid',
      shopifyWebhookId: nextWebhookId(),
      payload: signedOrderPayload(fixture, { id: secondOrderId }),
    });
    expect(second.outcome).toBe('processed');

    reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } });
    // O replay em si é sinal de algo errado — mesmo em cima de uma
    // reserva legitimamente confirmada, vira `problem` pra revisão
    // manual (confirmed→problem é uma transição permitida). O que
    // importa pra "não confirmar o segundo pedido": o vínculo continua
    // sendo o do PRIMEIRO pedido, nunca sobrescrito pelo segundo.
    expect(reservation.status).toBe('problem');
    expect(reservation.shopifyOrderId).toBe(String(firstOrderId));
    expect(reservation.confirmedAt?.getTime()).toBe(confirmedAtAfterFirst?.getTime());

    const events = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM reservation_events WHERE reservation_id = ${fixture.reservationId}::uuid AND type = 'DUPLICATE_ORDER'
    `;
    expect(Number(events[0].count)).toBe(1);
  }, 20_000);
});
