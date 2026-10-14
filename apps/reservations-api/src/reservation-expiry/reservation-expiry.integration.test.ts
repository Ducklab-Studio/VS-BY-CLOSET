import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { AvailabilityService } from '../availability/availability.service';
import { AdminCalendarService } from '../admin-panel/calendar.service';
import { ValePassWebhookService } from '../vale-pass/vale-pass-webhook.service';
import { resolveReservationBindingSecret } from '../checkout/checkout.config';
import { canonicalItemsFingerprint, computeReservationSignature, generateReservationBindingId } from '../reservation-binding';
import { addDays, civilDateToISO, isSunday, type CivilDate } from '../rental-rules/civil-date';
import { isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';
import { ShopifyOrderSyncService } from '../webhooks/shopify-order-sync.service';
import type { ShopifyOrderPayload } from '../webhooks/shopify-order-payload';
import { WebhooksService } from '../webhooks/webhooks.service';
import { expireDueReservations } from './reservation-expiry';
import { ReservationExpirySchedulerService, reservationExpiryIntervalSeconds } from './reservation-expiry-scheduler.service';

process.env.RESERVATION_BINDING_SECRET ??= 'test-reservation-binding-secret-expiry';

// Suíte de escrita: nunca roda contra banco hospedado, mesmo se chamada sozinha.
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const rules = new RentalRuleConfigService(prisma);
const availability = new AvailabilityService(prisma, rules);
const calendar = new AdminCalendarService(prisma);
const webhooks = new WebhooksService(prisma, new ValePassWebhookService(), new ShopifyOrderSyncService());
const scheduler = new ReservationExpirySchedulerService(prisma);

const PREFIX = `EXP-${Date.now()}`;
let seq = 0;
let orderSeq = 7_000_000;
const webhookId = () => `${PREFIX}-wh-${seq++}`;
const nextOrderId = () => orderSeq++;
let pickup: CivilDate;
let ret: CivilDate;

interface Piece { code: string; variantId: string; unitId: string }
interface Fixture { id: string; pieces: Piece[]; bindingId: string; pickup: CivilDate; ret: CivilDate }

const iso = civilDateToISO;
async function newPiece(): Promise<Piece> {
  const code = `${PREFIX}-u${seq++}`;
  const variantId = code; // a mesma chave serve à disponibilidade (variante = código) e ao pedido
  const unit = await prisma.rentalUnit.create({ data: { code, name: 'peça de teste', shopifyVariantId: variantId, active: true, reservableOnline: true, countsTowardRentalDuration: true } });
  return { code, variantId, unitId: unit.id };
}

/** Reserva ONLINE vinculada a peças; `windowElapsed` = a janela de pagamento já venceu. */
async function make(opts: { status?: string; items?: number; windowElapsed?: boolean; pieces?: Piece[]; shiftDays?: number } = {}): Promise<Fixture> {
  const status = opts.status ?? 'pending_payment';
  const pieces = opts.pieces ?? (await Promise.all(Array.from({ length: opts.items ?? 1 }, () => newPiece())));
  const start = addDays(pickup, opts.shiftDays ?? 0);
  const end = addDays(ret, opts.shiftDays ?? 0);
  const bindingId = generateReservationBindingId();
  const window = opts.windowElapsed ? new Date(Date.now() - 10 * 60_000) : new Date(Date.now() + 30 * 60_000);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservations (id, status, origin_store_id, pickup_date, return_date, checkout_state, shopify_cart_id, payment_expires_at, terms_accepted_at, terms_version, reservation_binding_id, customer_name)
    VALUES (gen_random_uuid(), ${status}::"reservation_status", 'dev-store', ${iso(start)}::date, ${iso(end)}::date, 'ready'::"checkout_state", ${`${PREFIX}-cart-${seq++}`}, ${window}, now(), 'test', ${bindingId}, 'teste teste')
    RETURNING id`;
  for (const piece of pieces) {
    await prisma.$executeRaw`
      INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
      VALUES (gen_random_uuid(), ${rows[0].id}::uuid, ${piece.unitId}::uuid, ${status}::"reservation_status", daterange(${iso(addDays(start, -3))}::date, ${iso(addDays(end, 3))}::date, '[)'))`;
  }
  return { id: rows[0].id, pieces, bindingId, pickup: start, ret: end };
}

/** Pedido como a Shopify entrega: atributos assinados no checkout + linhas iguais às peças. */
function order(f: Fixture, id: number, financialStatus: string, extra: Partial<ShopifyOrderPayload> = {}): ShopifyOrderPayload {
  const signature = computeReservationSignature(resolveReservationBindingSecret(), {
    reservationId: f.id,
    reservationBindingId: f.bindingId,
    itemsFingerprint: canonicalItemsFingerprint(f.pieces.map((p) => ({ variantId: p.variantId, quantity: 1 }))),
    pickupDate: iso(f.pickup),
    effectiveReturnDate: iso(f.ret),
  });
  return {
    id,
    admin_graphql_api_id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    financial_status: financialStatus,
    note_attributes: [
      { name: 'reservation_id', value: f.id },
      { name: 'reservation_binding_id', value: f.bindingId },
      { name: 'reservation_signature', value: signature },
    ],
    line_items: f.pieces.map((p) => ({ variant_id: p.variantId, quantity: 1 })),
    ...extra,
  };
}

const send = (topic: string, payload: ShopifyOrderPayload, id = webhookId()) => webhooks.handleIncoming({ topic, shopifyWebhookId: id, payload });
const statusOf = async (f: Fixture) => (await prisma.reservation.findUniqueOrThrow({ where: { id: f.id } })).status;
const itemStatuses = async (f: Fixture) => (await prisma.$queryRaw<{ status: string }[]>`SELECT status::text FROM reservation_items WHERE reservation_id = ${f.id}::uuid ORDER BY id`).map((r) => r.status);
const eventCount = (f: Fixture, type: string) => prisma.reservationEvent.count({ where: { reservationId: f.id, type } });
const free = async (p: Piece) => (await availability.getAvailability({ shopifyVariantId: p.variantId, countedPieces: 1, from: iso(pickup), to: iso(pickup) })).days[0].quantityAvailable;
const inCalendar = async (f: Fixture) => (await calendar.getCalendar(iso(addDays(pickup, -3)), iso(addDays(ret, 3)))).some((c) => c.reservationId === f.id);
/** Só as reservas do teste: o banco local pode ter outras reservas vencidas de outras suítes. */
const sweep = async () => expireDueReservations(prisma);

async function cleanup() {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id FROM reservation_items ri JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ru.code LIKE ${PREFIX + '%'}`;
  const ids = rows.map((r) => r.id);
  const events = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM webhook_events WHERE shopify_webhook_id LIKE ${PREFIX + '%'}`;
  const eventIds = events.map((r) => r.id);
  if (ids.length || eventIds.length) await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${ids}::uuid[]) OR webhook_event_id = ANY(${eventIds}::uuid[])`;
  if (eventIds.length) await prisma.$executeRaw`DELETE FROM webhook_events WHERE id = ANY(${eventIds}::uuid[])`;
  if (ids.length) {
    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${ids}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
}

localDescribe('expiração de pagamento × Shopify × disponibilidade (PostgreSQL isolado)', () => {
  beforeAll(async () => {
    if (!localDatabase) throw new Error('Banco local obrigatório');
    const valid = (d: CivilDate) => isOnlineReservationAllowed(d, DEFAULT_RENTAL_RULE_CONFIG) && !isSunday(d);
    let d = addDays(engineToday(await rules.load()), 70);
    while (!valid(d) || isSunday(addDays(d, 2))) d = addDays(d, 1);
    pickup = d;
    ret = addDays(d, 2);
    await cleanup();
  }, 60_000);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  }, 60_000);

  // 1) pedido criado com pagamento pendente
  test('pedido criado com pagamento pendente: segue aguardando e a peça segue bloqueada dentro da janela', async () => {
    const f = await make();
    const r = await send('orders/create', order(f, nextOrderId(), 'pending'));
    expect(r.outcome).toBe('processed');
    expect(await statusOf(f)).toBe('pending_payment');
    await sweep();
    expect(await statusOf(f)).toBe('pending_payment'); // dentro da janela de 30 min: nada expira
    expect(await free(f.pieces[0])).toBe(0);
    expect(await eventCount(f, 'RESERVATION_EXPIRED')).toBe(0);
  });

  // 2) pagamento aprovado
  test('pagamento aprovado confirma; nem uma janela vencida nem o agendador mexem na reserva paga', async () => {
    const f = await make(); // pago DENTRO da janela
    await send('orders/paid', order(f, nextOrderId(), 'paid'));
    expect(await statusOf(f)).toBe('confirmed');
    await prisma.$executeRaw`UPDATE reservations SET payment_expires_at = now() - interval '1 hour' WHERE id = ${f.id}::uuid`; // a janela vence depois
    await sweep();
    await sweep();
    expect(await statusOf(f)).toBe('confirmed');
    expect(await itemStatuses(f)).toEqual(['confirmed']);
    expect(await free(f.pieces[0])).toBe(0);
    expect(await inCalendar(f)).toBe(true);
    expect(await eventCount(f, 'RESERVATION_EXPIRED')).toBe(0);
  });

  // 3) pagamento expirado sem aprovação — o caso do pedido #1010
  test('PEDIDO #1010: janela vencida e nenhum webhook diz "expired" — antes do agendador a peça segue bloqueada; depois, expira e libera', async () => {
    const f = await make(); // checkout criado: dentro da janela de 30 min
    const id = nextOrderId();
    // 1) orders/create dentro da janela vincula o pedido (o que aconteceu às 02:37Z no #1010)
    await send('orders/create', order(f, id, 'pending', { updated_at: '2030-06-01T02:37:00Z' }));
    expect(await statusOf(f)).toBe('pending_payment');
    // 2) a janela vence; a Shopify marca o pedido como expirado, mas o webhook REST segue dizendo "pending"
    await prisma.$executeRaw`UPDATE reservations SET payment_expires_at = now() - interval '10 minutes' WHERE id = ${f.id}::uuid`;
    for (const at of ['2030-06-01T03:06:00Z', '2030-06-01T03:10:00Z']) {
      const r = await send('orders/updated', order(f, id, 'pending', { updated_at: at }));
      expect(r.outcome).toBe('processed');
    }
    expect(await statusOf(f)).toBe('pending_payment'); // o webhook sozinho não expira: documenta a causa
    expect(await free(f.pieces[0])).toBe(0);            // e a peça segue bloqueada
    expect(await inCalendar(f)).toBe(true);

    const result = await scheduler.runOnce();
    expect(result?.payments).toBeGreaterThanOrEqual(1);
    expect(await statusOf(f)).toBe('expired');
    expect(await itemStatuses(f)).toEqual(['expired']);
    expect(await free(f.pieces[0])).toBe(1);
    expect(await inCalendar(f)).toBe(false);
    const event = await prisma.reservationEvent.findFirstOrThrow({ where: { reservationId: f.id, type: 'RESERVATION_EXPIRED' } });
    expect(event.detail).toMatchObject({ source: 'SYSTEM', reason: 'payment_window_elapsed', from: 'pending_payment', to: 'expired' });
    // a linha nunca é apagada
    expect(await prisma.reservation.count({ where: { id: f.id } })).toBe(1);
  });

  test('o status "expired" do payload (quando a Shopify o envia) continua expirando só a reserva aguardando pagamento', async () => {
    const waiting = await make();
    await send('orders/updated', order(waiting, nextOrderId(), 'expired', { updated_at: new Date().toISOString() }));
    expect(await statusOf(waiting)).toBe('expired');
    expect(await free(waiting.pieces[0])).toBe(1);

    // reserva JÁ PAGA com um "expired" depois: vai para revisão, NUNCA libera a peça
    const paid = await make();
    const paidOrderId = nextOrderId();
    await send('orders/paid', order(paid, paidOrderId, 'paid', { updated_at: '2030-01-01T00:00:00Z' }));
    await send('orders/updated', order(paid, paidOrderId, 'expired', { updated_at: '2031-01-01T00:00:00Z' }));
    expect(['confirmed', 'problem']).toContain(await statusOf(paid));
    expect(await free(paid.pieces[0])).toBe(0);
  });

  // 4) pagamento anulado
  test('pagamento anulado: aguardando pagamento expira e libera; paga vai para revisão e continua ocupando', async () => {
    const waiting = await make();
    await send('orders/updated', order(waiting, nextOrderId(), 'voided', { updated_at: new Date().toISOString() }));
    expect(await statusOf(waiting)).toBe('expired');
    expect(await free(waiting.pieces[0])).toBe(1);

    const paid = await make();
    const orderId = nextOrderId();
    await send('orders/paid', order(paid, orderId, 'paid', { updated_at: '2030-02-01T00:00:00Z' }));
    await send('orders/updated', order(paid, orderId, 'voided', { updated_at: '2030-03-01T00:00:00Z' }));
    expect(await statusOf(paid)).toBe('problem');
    expect(await free(paid.pieces[0])).toBe(0); // revisão humana; a peça NÃO é liberada
  });

  // 5) duplicado
  test('webhook duplicado e agendador repetido são idempotentes (um evento, um efeito)', async () => {
    const f = await make({ windowElapsed: true });
    await sweep();
    const again = await sweep();
    expect(await eventCount(f, 'RESERVATION_EXPIRED')).toBe(1);
    expect(again.payments).toBe(0);

    const paid = await make();
    const id = webhookId();
    const payload = order(paid, nextOrderId(), 'paid');
    expect((await send('orders/paid', payload, id)).outcome).toBe('processed');
    expect((await send('orders/paid', payload, id)).outcome).toBe('duplicate');
    expect(await eventCount(paid, 'PAYMENT_CONFIRMED')).toBe(1);
  });

  // 6) fora de ordem
  test('evento antigo de expiração NUNCA cancela reserva paga; entrega atrasada não desfaz estado mais novo', async () => {
    const f = await make();
    const orderId = nextOrderId();
    await send('orders/paid', order(f, orderId, 'paid', { updated_at: '2030-05-02T10:00:00Z' }));
    expect(await statusOf(f)).toBe('confirmed');
    // entrega ATRASADA (updated_at anterior ao pagamento) dizendo que expirou/anulou
    for (const stale of ['expired', 'voided']) {
      const r = await send('orders/updated', order(f, orderId, stale, { updated_at: '2030-05-02T09:00:00Z' }));
      expect(r.outcome).toBe('processed');
    }
    expect(await statusOf(f)).toBe('confirmed');
    expect(await itemStatuses(f)).toEqual(['confirmed']);
    expect(await free(f.pieces[0])).toBe(0);
    await sweep();
    expect(await statusOf(f)).toBe('confirmed');
  });

  // 7) pagamento tardio
  test('pagamento tardio: depois da expiração, a recuperação segura confirma se a peça ainda está livre', async () => {
    const f = await make({ windowElapsed: true });
    await sweep();
    expect(await statusOf(f)).toBe('expired');
    const r = await send('orders/paid', order(f, nextOrderId(), 'paid'));
    expect(r.outcome).toBe('processed');
    expect(await statusOf(f)).toBe('confirmed');
    expect(await itemStatuses(f)).toEqual(['confirmed']);
    expect(await free(f.pieces[0])).toBe(0);
    expect(await eventCount(f, 'LATE_PAYMENT_RECOVERED')).toBe(1);
  });

  test('pagamento tardio com a peça já tomada por outra cliente: conflito sinalizado, ninguém é sobrescrito', async () => {
    const f = await make({ windowElapsed: true });
    await sweep();
    const other = await make({ pieces: f.pieces, status: 'confirmed' }); // outra reserva paga ocupa a mesma peça e período
    const r = await send('orders/paid', order(f, nextOrderId(), 'paid'));
    expect(r.outcome).toBe('processed');
    expect(await statusOf(f)).toBe('late_payment_conflict');
    expect(await statusOf(other)).toBe('confirmed');
    expect(await free(f.pieces[0])).toBe(0);
  });

  // 8) várias peças
  test('reserva com várias peças expira inteira e libera todas; confirmada mantém todas', async () => {
    const stale = await make({ items: 3, windowElapsed: true });
    const live = await make({ items: 2, windowElapsed: true });
    await send('orders/paid', order(live, nextOrderId(), 'paid'));
    await sweep();
    expect(await statusOf(stale)).toBe('expired');
    expect(await itemStatuses(stale)).toEqual(['expired', 'expired', 'expired']);
    for (const p of stale.pieces) expect(await free(p)).toBe(1);
    expect(await statusOf(live)).toBe('confirmed');
    expect(await itemStatuses(live)).toEqual(['confirmed', 'confirmed']);
    for (const p of live.pieces) expect(await free(p)).toBe(0);
  });

  // 9) peça com reserva futura
  test('peça com reserva futura: expirar a vencida não toca a futura da mesma peça', async () => {
    const stale = await make({ windowElapsed: true });
    const future = await make({ pieces: stale.pieces, status: 'confirmed', shiftDays: 40 });
    const laterPending = await make({ pieces: stale.pieces, shiftDays: 80 }); // dentro da janela
    await sweep();
    expect(await statusOf(stale)).toBe('expired');
    expect(await statusOf(future)).toBe('confirmed');
    expect(await itemStatuses(future)).toEqual(['confirmed']);
    expect(await statusOf(laterPending)).toBe('pending_payment');
    expect(await free(stale.pieces[0])).toBe(1); // o período da vencida volta a ficar livre
    expect((await calendar.getCalendar(iso(addDays(pickup, 37)), iso(addDays(ret, 43)))).some((c) => c.reservationId === future.id)).toBe(true);
  });

  // 10) concorrência
  test('CONCORRÊNCIA: expiração × aprovação, repetidas — a reserva paga nunca fica expirada nem perde a peça', async () => {
    for (let round = 0; round < 12; round++) {
      const f = await make({ windowElapsed: true });
      const payload = order(f, nextOrderId(), 'paid');
      const settled = await Promise.allSettled([sweep(), send('orders/paid', payload), sweep(), scheduler.runOnce()]);
      expect(settled.every((s) => s.status === 'fulfilled'), `rodada ${round}`).toBe(true);
      // se o agendador ganhou, a recuperação de pagamento tardio confirmou; se o pagamento ganhou, o agendador pulou
      expect(await statusOf(f), `rodada ${round}`).toBe('confirmed');
      expect(await itemStatuses(f)).toEqual(['confirmed']);
      expect(await free(f.pieces[0])).toBe(0);
    }
  });

  test('CONCORRÊNCIA: dois agendadores ao mesmo tempo expiram uma vez só', async () => {
    const f = await make({ windowElapsed: true });
    const results = await Promise.all([sweep(), sweep(), sweep()]);
    expect(results.reduce((n, r) => n + r.payments, 0)).toBeGreaterThanOrEqual(1);
    expect(await eventCount(f, 'RESERVATION_EXPIRED')).toBe(1);
    expect(await statusOf(f)).toBe('expired');
  });

  test('o agendador pula a reserva que um webhook está processando (lock) e expira na rodada seguinte', async () => {
    const f = await make({ windowElapsed: true });
    let during: Awaited<ReturnType<typeof sweep>> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM reservations WHERE id = ${f.id}::uuid FOR UPDATE`; // webhook "em andamento"
      during = await sweep();
    });
    expect(await statusOf(f)).toBe('pending_payment');
    expect(during).toBeDefined();
    await sweep();
    expect(await statusOf(f)).toBe('expired');
  });

  // 11) falha parcial e reprocessamento
  test('falha no meio de uma transação desfaz a expiração e o evento; a próxima rodada funciona', async () => {
    const f = await make({ windowElapsed: true });
    await expect(prisma.$transaction(async (tx) => {
      await expireDueReservations(tx);
      throw new Error('falha simulada depois da expiração');
    })).rejects.toThrow(/falha simulada/);
    expect(await statusOf(f)).toBe('pending_payment');
    expect(await eventCount(f, 'RESERVATION_EXPIRED')).toBe(0);
    await sweep();
    expect(await statusOf(f)).toBe('expired');
    expect(await eventCount(f, 'RESERVATION_EXPIRED')).toBe(1);
  });

  test('webhook de pagamento que falha (503) e é reentregue depois de a reserva expirar: reprocessa e confirma', async () => {
    const f = await make({ windowElapsed: true });
    const id = webhookId();
    const payload = order(f, nextOrderId(), 'paid');
    const secret = process.env.RESERVATION_BINDING_SECRET;
    delete process.env.RESERVATION_BINDING_SECRET;
    try {
      await expect(send('orders/paid', payload, id)).rejects.toMatchObject({ status: 503 });
    } finally {
      process.env.RESERVATION_BINDING_SECRET = secret;
    }
    await sweep(); // enquanto isso a janela vence
    expect(await statusOf(f)).toBe('expired');
    const retry = await send('orders/paid', payload, id);
    expect(retry.outcome).toBe('processed');
    expect(await statusOf(f)).toBe('confirmed');
  });

  // 12) integridade
  test('o que o agendador nunca toca: confirmada, operacional, problema, cancelada e carrinho ainda válido', async () => {
    const confirmed = await make({ status: 'confirmed', windowElapsed: true });
    const problem = await make({ status: 'problem', windowElapsed: true });
    const cancelled = await make({ status: 'cancelled', windowElapsed: true });
    const returned = await make({ status: 'returned', windowElapsed: true });
    const hold = await make({ status: 'hold' });
    await prisma.$executeRaw`UPDATE reservations SET expires_at = now() + interval '10 minutes' WHERE id = ${hold.id}::uuid`;
    const before = await Promise.all([confirmed, problem, cancelled, returned, hold].map(statusOf));
    await sweep();
    expect(await Promise.all([confirmed, problem, cancelled, returned, hold].map(statusOf))).toEqual(before);
    expect(await free(confirmed.pieces[0])).toBe(0);
    expect(await free(problem.pieces[0])).toBe(0);
    expect(await free(hold.pieces[0])).toBe(0);
  });

  test('HOLD abandonado também expira (regra antiga) e não gera evento', async () => {
    const hold = await make({ status: 'hold' });
    await prisma.$executeRaw`UPDATE reservations SET expires_at = now() - interval '1 minute' WHERE id = ${hold.id}::uuid`;
    const result = await sweep();
    expect(result.holds).toBeGreaterThanOrEqual(1);
    expect(await statusOf(hold)).toBe('expired');
    expect(await eventCount(hold, 'RESERVATION_EXPIRED')).toBe(0);
    expect(await free(hold.pieces[0])).toBe(1);
  });

  test('reserva manual não é paga pela Shopify nem expira por tempo', async () => {
    const manual = await make({ status: 'confirmed', windowElapsed: true });
    await prisma.$executeRaw`UPDATE reservations SET source = 'manual_admin', payment_expires_at = now() - interval '1 day' WHERE id = ${manual.id}::uuid`;
    await sweep();
    expect(await statusOf(manual)).toBe('confirmed');
  });

  describe('configuração do agendador', () => {
    test('intervalo: padrão 60 s, mínimo 15 s, 0 desliga, testes ficam desligados', () => {
      expect(reservationExpiryIntervalSeconds({})).toBe(60);
      expect(reservationExpiryIntervalSeconds({ RESERVATION_EXPIRY_INTERVAL_SECONDS: '5' })).toBe(15);
      expect(reservationExpiryIntervalSeconds({ RESERVATION_EXPIRY_INTERVAL_SECONDS: '120' })).toBe(120);
      expect(reservationExpiryIntervalSeconds({ RESERVATION_EXPIRY_INTERVAL_SECONDS: '0' })).toBeNull();
      expect(reservationExpiryIntervalSeconds({ RESERVATION_EXPIRY_INTERVAL_SECONDS: 'x' })).toBeNull();
      expect(reservationExpiryIntervalSeconds({ NODE_ENV: 'test' })).toBeNull();
      expect(reservationExpiryIntervalSeconds({ VITEST: 'true' })).toBeNull();
    });

    test('falha do banco não derruba o processo: a rodada devolve null e a seguinte funciona', async () => {
      const broken = new ReservationExpirySchedulerService(new Proxy(prisma, {
        get(target, key, receiver) {
          if (key === '$queryRaw') return () => Promise.reject(new Error('banco fora'));
          return Reflect.get(target, key, receiver);
        },
      }) as unknown as PrismaService);
      await expect(broken.runOnce()).resolves.toBeNull();
      await expect(scheduler.runOnce()).resolves.not.toBeNull();
    });

    test('nunca duas rodadas ao mesmo tempo', async () => {
      const [a, b] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
      expect([a, b].filter((r) => r === null).length).toBeLessThanOrEqual(1);
    });
  });
});
