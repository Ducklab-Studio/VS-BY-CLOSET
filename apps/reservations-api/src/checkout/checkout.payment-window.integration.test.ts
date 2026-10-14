import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { AvailabilityService } from '../availability/availability.service';
import { AdminCalendarService } from '../admin-panel/calendar.service';
import { HoldsService, type HoldResponse } from '../holds/holds.service';
import { ValePassWebhookService } from '../vale-pass/vale-pass-webhook.service';
import { ShopifyOrderSyncService } from '../webhooks/shopify-order-sync.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import type { ShopifyOrderPayload } from '../webhooks/shopify-order-payload';
import { canonicalItemsFingerprint, computeReservationSignature } from '../reservation-binding';
import { ReservationExpirySchedulerService } from '../reservation-expiry/reservation-expiry-scheduler.service';
import { expireDueReservations } from '../reservation-expiry/reservation-expiry';
import { CheckoutService } from './checkout.service';
import { HOLD_WINDOW_MINUTES, paymentWindowMinutes, resolveReservationBindingSecret } from './checkout.config';
import type { ShopifyCartClient } from './shopify-storefront-cart.client';
import { type CivilDate, addDays, civilDateToISO, isSunday } from '../rental-rules/civil-date';
import { calculateReturnDate, isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';

process.env.RESERVATION_BINDING_SECRET ??= 'test-reservation-binding-secret-window';

// Suíte de escrita: nunca roda contra banco hospedado, mesmo se chamada sozinha.
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const rules = new RentalRuleConfigService(prisma);
const holds = new HoldsService(prisma, rules);
const availability = new AvailabilityService(prisma, rules);
const calendar = new AdminCalendarService(prisma);
const webhooks = new WebhooksService(prisma, new ValePassWebhookService(), new ShopifyOrderSyncService());
const CFG = DEFAULT_RENTAL_RULE_CONFIG;
const PREFIX = `WIN-${Date.now()}`;
const TIMEOUT = 30_000;

let unitSeq = 0;
let dayOffset = 90;
let cartSeq = 0;
let hookSeq = 0;
let orderSeq = 8_000_000;
const originalWindow = process.env.PAYMENT_WINDOW_MINUTES;

function pickupSafe(d0: CivilDate): CivilDate {
  let d = d0;
  for (let i = 0; i < 400 && (!isOnlineReservationAllowed(d, CFG) || isSunday(d)); i++) d = addDays(d, 1);
  return d;
}
/** Retirada válida, com devolução fora de domingo, em um período próprio de cada teste. */
function nextPickup(durationDays = 2): CivilDate {
  let d = pickupSafe(addDays(engineToday(CFG), (dayOffset += 14)));
  for (let i = 0; i < 400 && isSunday(calculateReturnDate(d, durationDays)); i++) d = pickupSafe(addDays(d, 1));
  return d;
}

const fakeCart = (): ShopifyCartClient => ({
  cartCreate: vi.fn(async () => {
    const n = cartSeq++;
    return { ok: true as const, cartId: `gid://shopify/Cart/${PREFIX}-${n}`, checkoutUrl: `https://dev-store.myshopify.com/cart/c/${PREFIX}-${n}` };
  }),
}) as unknown as ShopifyCartClient;
const checkout = new CheckoutService(prisma, rules, fakeCart());

async function variant(units = 1): Promise<string> {
  const id = `${PREFIX}-v${unitSeq++}`;
  await prisma.rentalUnit.createMany({
    data: Array.from({ length: units }, (_, i) => ({ code: `${id}-u${i}`, name: 'peça de teste', shopifyVariantId: id, active: true, reservableOnline: true, countsTowardRentalDuration: true })),
  });
  return id;
}

interface Flow { hold: HoldResponse; variants: string[]; pickup: CivilDate; url: string; expiresAt: string }
/** HOLD real + checkout real (Shopify simulada): a reserva nasce em `pending_payment`. */
async function startCheckout(variants: string[], pickup = nextPickup()): Promise<Flow> {
  const hold = await holds.createHold({ items: variants.map((v) => ({ shopifyVariantId: v, quantity: 1 })), pickupDate: civilDateToISO(pickup), termsAccepted: true });
  const res = await checkout.createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! });
  return { hold, variants, pickup, url: res.checkoutUrl, expiresAt: res.expiresAt };
}

const row = (f: Flow) => prisma.reservation.findUniqueOrThrow({ where: { id: f.hold.reservationId } });
const statusOf = async (f: Flow) => (await row(f)).status;
const events = (f: Flow, type: string) => prisma.reservationEvent.count({ where: { reservationId: f.hold.reservationId, type } });
const minutesBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60_000;
/** Faz o relógio "andar": recua os instantes gravados (o banco mede o vencimento com o próprio now()). */
async function elapse(f: Flow, minutes: number, seconds = 0) {
  await prisma.$executeRaw`
    UPDATE reservations SET checkout_created_at = checkout_created_at - make_interval(mins => ${minutes}::int, secs => ${seconds}::int),
                            payment_expires_at = payment_expires_at - make_interval(mins => ${minutes}::int, secs => ${seconds}::int)
    WHERE id = ${f.hold.reservationId}::uuid`;
}
const sweep = () => expireDueReservations(prisma);
const free = async (f: Flow, i = 0) => (await availability.getAvailability({ shopifyVariantId: f.variants[i], countedPieces: 1, from: civilDateToISO(f.pickup), to: civilDateToISO(f.pickup) })).days[0].quantityAvailable;
const inCalendar = async (f: Flow) => (await calendar.getCalendar(civilDateToISO(addDays(f.pickup, -3)), civilDateToISO(addDays(f.pickup, 12)))).some((c) => c.reservationId === f.hold.reservationId);

async function orderFor(f: Flow, id: number, financialStatus: string, updatedAt: string): Promise<ShopifyOrderPayload> {
  const r = await row(f);
  const pickup = civilDateToISO(f.pickup);
  const effectiveReturn = r.returnDate!.toISOString().slice(0, 10);
  const signature = computeReservationSignature(resolveReservationBindingSecret(), {
    reservationId: r.id,
    reservationBindingId: r.reservationBindingId!,
    itemsFingerprint: canonicalItemsFingerprint(f.variants.map((v) => ({ variantId: v, quantity: 1 }))),
    pickupDate: pickup,
    effectiveReturnDate: effectiveReturn,
  });
  return {
    id,
    admin_graphql_api_id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    financial_status: financialStatus,
    updated_at: updatedAt,
    note_attributes: [
      { name: 'reservation_id', value: r.id },
      { name: 'reservation_binding_id', value: r.reservationBindingId! },
      { name: 'reservation_signature', value: signature },
    ],
    line_items: f.variants.map((v) => ({ variant_id: v, quantity: 1 })),
  };
}
const send = (topic: string, payload: ShopifyOrderPayload, id = `${PREFIX}-wh-${hookSeq++}`) => webhooks.handleIncoming({ topic, shopifyWebhookId: id, payload });

async function cleanup() {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id FROM reservation_items ri JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ru.code LIKE ${PREFIX + '%'}`;
  const ids = rows.map((r) => r.id);
  const ev = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM webhook_events WHERE shopify_webhook_id LIKE ${PREFIX + '%'}`;
  const evIds = ev.map((r) => r.id);
  if (ids.length || evIds.length) await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${ids}::uuid[]) OR webhook_event_id = ANY(${evIds}::uuid[])`;
  if (evIds.length) await prisma.$executeRaw`DELETE FROM webhook_events WHERE id = ANY(${evIds}::uuid[])`;
  if (ids.length) {
    await prisma.$executeRaw`DELETE FROM hold_idempotency_keys WHERE reservation_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${ids}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
}

localDescribe('janela de pagamento de 60 minutos — fluxo real (PostgreSQL isolado, Shopify simulada)', () => {
  beforeAll(cleanup, 60_000);
  afterEach(() => {
    if (originalWindow === undefined) delete process.env.PAYMENT_WINDOW_MINUTES;
    else process.env.PAYMENT_WINDOW_MINUTES = originalWindow;
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  }, 60_000);

  describe('configuração', () => {
    test('padrão 60 min; variável de ambiente sobrescreve; valor inválido é recusado (nunca vira prazo estranho)', () => {
      delete process.env.PAYMENT_WINDOW_MINUTES;
      expect(paymentWindowMinutes()).toBe(60);
      process.env.PAYMENT_WINDOW_MINUTES = '   ';
      expect(paymentWindowMinutes()).toBe(60);
      process.env.PAYMENT_WINDOW_MINUTES = '45';
      expect(paymentWindowMinutes()).toBe(45);
      process.env.PAYMENT_WINDOW_MINUTES = '30'; // o que o Railway tem hoje: continua sendo respeitado
      expect(paymentWindowMinutes()).toBe(30);
      for (const bad of ['0', '-5', 'abc', '1441', 'Infinity']) {
        process.env.PAYMENT_WINDOW_MINUTES = bad;
        expect(() => paymentWindowMinutes(), bad).toThrow(/PAYMENT_WINDOW_MINUTES inválido/);
      }
    });
    test('o HOLD inicial segue em 30 min e é uma fase separada da janela de pagamento', () => {
      expect(HOLD_WINDOW_MINUTES).toBe(30);
      expect(HOLD_WINDOW_MINUTES).not.toBe(paymentWindowMinutes());
    });
  });

  describe('de onde o prazo é contado', () => {
    test('HOLD: expires_at = criação + 30 min. Checkout: payment_expires_at = criação DO CHECKOUT + 60 min, e a resposta devolve esse mesmo instante', async () => {
      delete process.env.PAYMENT_WINDOW_MINUTES;
      const before = Date.now();
      const f = await startCheckout([await variant()]);
      const r = await row(f);
      expect(minutesBetween(r.createdAt, r.expiresAt!)).toBeCloseTo(30, 0);
      expect(r.status).toBe('pending_payment');
      expect(minutesBetween(r.checkoutCreatedAt!, r.paymentExpiresAt!)).toBeCloseTo(60, 1);
      expect(r.paymentExpiresAt!.toISOString()).toBe(f.expiresAt);
      expect(r.paymentExpiresAt!.getTime() - before).toBeGreaterThan(59 * 60_000);
      expect(r.paymentExpiresAt!.getTime() - before).toBeLessThan(61 * 60_000);
    }, TIMEOUT);

    test('a variável de ambiente muda o prazo só dos checkouts NOVOS (cada reserva guarda o seu)', async () => {
      const a = await startCheckout([await variant()]);
      process.env.PAYMENT_WINDOW_MINUTES = '45';
      const b = await startCheckout([await variant()]);
      const [ra, rb] = [await row(a), await row(b)];
      expect(minutesBetween(ra.checkoutCreatedAt!, ra.paymentExpiresAt!)).toBeCloseTo(60, 1);
      expect(minutesBetween(rb.checkoutCreatedAt!, rb.paymentExpiresAt!)).toBeCloseTo(45, 1);
    }, TIMEOUT);

    test('NÃO renova: novo POST /checkout, webhooks repetidos e orders/updated não mexem em payment_expires_at', async () => {
      const f = await startCheckout([await variant()]);
      const original = (await row(f)).paymentExpiresAt!.toISOString();
      const again = await checkout.createCheckout({ reservationId: f.hold.reservationId, holdToken: f.hold.holdToken! });
      expect(again.checkoutUrl).toBe(f.url);
      expect(again.expiresAt).toBe(original);

      const orderId = orderSeq++;
      const create = await orderFor(f, orderId, 'pending', '2030-07-01T10:00:00Z');
      await send('orders/create', create, `${PREFIX}-same`);
      await send('orders/create', create, `${PREFIX}-same`); // duplicado
      for (const at of ['2030-07-01T10:05:00Z', '2030-07-01T10:20:00Z', '2030-07-01T10:35:00Z']) await send('orders/updated', await orderFor(f, orderId, 'pending', at));
      await send('orders/updated', await orderFor(f, orderId, 'pending', '2030-07-01T10:05:00Z')); // fora de ordem
      const r = await row(f);
      expect(r.paymentExpiresAt!.toISOString()).toBe(original);
      expect(r.status).toBe('pending_payment');
    }, TIMEOUT);
  });

  describe('linha do tempo da janela (59 → 60 → 61 minutos)', () => {
    test('1) pagamento aprovado antes de 60 min confirma; o agendador nunca mais toca', async () => {
      const f = await startCheckout([await variant()]);
      await elapse(f, 30);
      await send('orders/paid', await orderFor(f, orderSeq++, 'paid', '2030-07-02T10:00:00Z'));
      expect(await statusOf(f)).toBe('confirmed');
      await elapse(f, 120); // mesmo com o prazo "muito vencido" depois
      await sweep();
      expect(await statusOf(f)).toBe('confirmed');
      expect(await free(f)).toBe(0);
      expect(await events(f, 'RESERVATION_EXPIRED')).toBe(0);
    }, TIMEOUT);

    test('2) aos 59 min ainda pendente: nada expira, a peça segue reservada', async () => {
      const f = await startCheckout([await variant()]);
      await elapse(f, 59);
      await sweep();
      expect(await statusOf(f)).toBe('pending_payment');
      expect(await free(f)).toBe(0);
      expect(await inCalendar(f)).toBe(true);
    }, TIMEOUT);

    test('3) aos 59:30 segue pendente; aos 60:01 expira e libera peça e calendário', async () => {
      const f = await startCheckout([await variant()]);
      await elapse(f, 59, 30);
      await sweep();
      expect(await statusOf(f)).toBe('pending_payment');
      await elapse(f, 0, 31); // total 60:01
      const result = await sweep();
      expect(result.payments).toBeGreaterThanOrEqual(1);
      expect(await statusOf(f)).toBe('expired');
      expect(await free(f)).toBe(1);
      expect(await inCalendar(f)).toBe(false);
      expect(await events(f, 'RESERVATION_EXPIRED')).toBe(1);
      expect(await prisma.reservation.count({ where: { id: f.hold.reservationId } })).toBe(1); // nunca apagada
    }, TIMEOUT);

    test('4) pagamento aprovado DEPOIS de 60 min: recuperação segura confirma se a peça está livre', async () => {
      const f = await startCheckout([await variant()]);
      await elapse(f, 61);
      await sweep();
      expect(await statusOf(f)).toBe('expired');
      await send('orders/paid', await orderFor(f, orderSeq++, 'paid', '2030-07-03T10:00:00Z'));
      expect(await statusOf(f)).toBe('confirmed');
      expect(await events(f, 'LATE_PAYMENT_RECOVERED')).toBe(1);
      expect(await free(f)).toBe(0);
    }, TIMEOUT);

    test('4b) pagamento depois de 60 min com a peça já tomada por outra: conflito sinalizado, ninguém é sobrescrito', async () => {
      const v = await variant(); // uma única unidade
      const pickup = nextPickup();
      const first = await startCheckout([v], pickup);
      await elapse(first, 61);
      await sweep();
      const second = await startCheckout([v], pickup); // outra cliente pega a mesma peça e período
      await send('orders/paid', await orderFor(second, orderSeq++, 'paid', '2030-07-04T10:00:00Z'));
      expect(await statusOf(second)).toBe('confirmed');
      await send('orders/paid', await orderFor(first, orderSeq++, 'paid', '2030-07-04T11:00:00Z'));
      expect(await statusOf(first)).toBe('late_payment_conflict');
      expect(await statusOf(second)).toBe('confirmed');
      expect(await free(second)).toBe(0);
    }, TIMEOUT);

    test('5) evento de expiração/anulação ATRASADO depois do pagamento não rebaixa a reserva paga', async () => {
      const f = await startCheckout([await variant()]);
      const orderId = orderSeq++;
      await send('orders/paid', await orderFor(f, orderId, 'paid', '2030-07-05T12:00:00Z'));
      for (const stale of ['expired', 'voided']) await send('orders/updated', await orderFor(f, orderId, stale, '2030-07-05T11:00:00Z'));
      expect(await statusOf(f)).toBe('confirmed');
      expect(await free(f)).toBe(0);
    }, TIMEOUT);
  });

  describe('reserva com várias peças e reservas futuras', () => {
    test('9) expira inteira e libera todas as peças; a reserva futura da mesma peça não é tocada', async () => {
      const [va, vb] = [await variant(), await variant()];
      const near = await startCheckout([va, vb], nextPickup());
      const future = await startCheckout([va], nextPickup()); // mesma peça A, período bem depois
      await elapse(near, 61);
      await sweep();
      expect(await statusOf(near)).toBe('expired');
      expect(await prisma.$queryRaw`SELECT status::text FROM reservation_items WHERE reservation_id = ${near.hold.reservationId}::uuid`).toEqual([{ status: 'expired' }, { status: 'expired' }]);
      expect(await free(near, 0)).toBe(1);
      expect(await free(near, 1)).toBe(1);
      expect(await statusOf(future)).toBe('pending_payment');
      expect(await free(future)).toBe(0);
      expect(await inCalendar(future)).toBe(true);
    }, TIMEOUT);
  });

  describe('reinício e múltiplas instâncias do agendador', () => {
    test('8) API reiniciada com reservas antigas vencidas: a primeira rodada depois do boot as expira, uma vez só', async () => {
      const stale = await Promise.all([await startCheckout([await variant()]), await startCheckout([await variant()])]);
      for (const f of stale) await elapse(f, 600); // 10 h parada
      vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
      const boot = new ReservationExpirySchedulerService(prisma);
      try {
        boot.onModuleInit({ RESERVATION_EXPIRY_INTERVAL_SECONDS: '60' });
        expect(await statusOf(stale[0])).toBe('pending_payment'); // ainda não rodou: o boot só agenda
        await vi.advanceTimersByTimeAsync(10_000); // primeira rodada, 10 s depois do boot
      } finally {
        vi.useRealTimers();
      }
      for (let i = 0; i < 50 && (await statusOf(stale[0])) !== 'expired'; i++) await new Promise((r) => setTimeout(r, 100));
      boot.onModuleDestroy();
      for (const f of stale) {
        expect(await statusOf(f)).toBe('expired');
        expect(await free(f)).toBe(1);
        expect(await events(f, 'RESERVATION_EXPIRED')).toBe(1);
      }
      // novo reinício: nada a fazer, nenhum evento duplicado
      const second = new ReservationExpirySchedulerService(prisma);
      await second.runOnce();
      for (const f of stale) expect(await events(f, 'RESERVATION_EXPIRED')).toBe(1);
    }, 60_000);

    test('desligado por configuração, o boot não agenda nada', () => {
      const off = new ReservationExpirySchedulerService(prisma);
      off.onModuleInit({ RESERVATION_EXPIRY_INTERVAL_SECONDS: '0' });
      off.onModuleInit({ NODE_ENV: 'test' });
      off.onModuleDestroy();
    });

    test('7) várias instâncias (conexões independentes) rodando juntas: cada reserva expira e registra UM evento', async () => {
      const flows = await Promise.all([await startCheckout([await variant()]), await startCheckout([await variant()]), await startCheckout([await variant()])]);
      for (const f of flows) await elapse(f, 61);
      const clients = Array.from({ length: 4 }, () => new PrismaService());
      try {
        const instances = clients.map((c) => new ReservationExpirySchedulerService(c));
        const results = await Promise.all([...instances.map((i) => i.runOnce()), ...instances.map((i) => i.runOnce())]);
        expect(results.every((r) => r !== undefined)).toBe(true);
        for (const f of flows) {
          expect(await statusOf(f)).toBe('expired');
          expect(await events(f, 'RESERVATION_EXPIRED')).toBe(1);
          expect(await free(f)).toBe(1);
        }
      } finally {
        await Promise.all(clients.map((c) => c.$disconnect()));
      }
    }, 60_000);

    test('6) agendador e pagamento ao mesmo tempo, repetido: a reserva paga termina confirmada e com a peça', async () => {
      for (let round = 0; round < 8; round++) {
        const f = await startCheckout([await variant()]);
        await elapse(f, 60, 5); // acabou de vencer
        const payload = await orderFor(f, orderSeq++, 'paid', `2030-08-0${(round % 8) + 1}T10:00:00Z`);
        const settled = await Promise.allSettled([sweep(), send('orders/paid', payload), sweep()]);
        expect(settled.every((s) => s.status === 'fulfilled'), `rodada ${round}`).toBe(true);
        expect(await statusOf(f), `rodada ${round}`).toBe('confirmed');
        expect(await free(f)).toBe(0);
      }
    }, 120_000);
  });

  describe('o que o agendador não faz', () => {
    test('não depende da Shopify: nenhuma chamada de rede nem cliente Shopify nos arquivos do agendador', async () => {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      for (const file of ['reservation-expiry.ts', 'reservation-expiry-scheduler.service.ts', 'reservation-expiry.module.ts']) {
        const source = readFileSync(join(__dirname, '..', 'reservation-expiry', file), 'utf8');
        expect(source, file).not.toMatch(/shopify-admin\.client|ShopifyAdminClient|fetch\(|https?:\/\/|graphql/i);
      }
    });

    test('só libera o que pode: peças já recebidas/em higienização não são tocadas pelo gatilho', async () => {
      const f = await startCheckout([await variant(), await variant()]);
      const items = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM reservation_items WHERE reservation_id = ${f.hold.reservationId}::uuid ORDER BY id`;
      // estado artificial: uma peça já no ciclo físico (nunca ocorre com pending_payment, mas o gatilho precisa proteger)
      await prisma.$executeRaw`UPDATE reservation_items SET status = 'cleaning', returned_at = now() WHERE id = ${items[0].id}::uuid`;
      await elapse(f, 61);
      await sweep();
      const after = await prisma.$queryRaw<{ id: string; status: string }[]>`SELECT id, status::text FROM reservation_items WHERE reservation_id = ${f.hold.reservationId}::uuid ORDER BY id`;
      expect(after.find((i) => i.id === items[0].id)?.status).toBe('cleaning');
      expect(after.find((i) => i.id === items[1].id)?.status).toBe('expired');
    }, TIMEOUT);
  });
});
