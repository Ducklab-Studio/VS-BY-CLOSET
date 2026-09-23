import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ConflictException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { hashPin } from '../admin/admin-pin';
import { ensureStoreConfig, resolveStoreConfig } from '../holds/store-config';
import { WebhooksService } from '../webhooks/webhooks.service';
import { ShopifyOrderSyncService } from '../webhooks/shopify-order-sync.service';
import { lockShopifyOrder } from '../webhooks/shopify-order-lock';
import { ValePassWebhookService } from './vale-pass-webhook.service';
import { ValePassVouchersService } from './vale-pass-vouchers.service';

/**
 * Corrida entre cancelamento manual do Valle Pass, restauração, uso e os
 * webhooks de cancelamento/reembolso da Shopify. Integração real contra
 * Postgres LOCAL (sem `DATABASE_URL` de loopback com nome de teste, o arquivo
 * é pulado); webhooks entram por `WebhooksService.handleIncoming`, o mesmo
 * pipeline (transação + locks) de produção.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const valePassWebhook = new ValePassWebhookService();
const webhooks = new WebhooksService(prisma, valePassWebhook, new ShopifyOrderSyncService());
const vouchers = new ValePassVouchersService(prisma);

const SUFFIX = Date.now();
const TAG = `VP-RACE-${SUFFIX}`;
const CAMPAIGN_NAME = `Campanha ${TAG}`;
let orderCounter = 4_000_000_000 + (SUFFIX % 1_000_000);
let variantCounter = 7_000_000 + (SUFFIX % 1_000_000);
let counter = 0;
const createdOrderIds: string[] = [];
const nextWebhookId = () => `${TAG}-wh-${counter++}`;
const nextOrderId = () => {
  const id = String(orderCounter++);
  createdOrderIds.push(id);
  return id;
};

async function createAdmin() {
  return prisma.adminUser.create({ data: { name: 'Admin Corrida', phone: `${TAG}-${counter++}`, pinHash: await hashPin('1234'), role: 'SUPER_ADMIN', active: true } });
}

async function createCampaign() {
  return prisma.valePassCampaign.create({ data: { name: CAMPAIGN_NAME, amountCents: 15000, validityDays: 90, shopifyVariantId: String(variantCounter++) } });
}

function paidPayload(orderId: string, variantId: string, quantity: number) {
  return { id: Number(orderId), admin_graphql_api_id: `gid://shopify/Order/${orderId}`, name: `#${orderId}`, financial_status: 'paid', line_items: [{ variant_id: Number(variantId), quantity }] };
}

/** Pedido pago de verdade pelo pipeline de webhook; vales em ordem estável. */
async function paidOrder(quantity = 1) {
  const campaign = await createCampaign();
  const orderId = nextOrderId();
  await webhooks.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: paidPayload(orderId, campaign.shopifyVariantId, quantity) });
  const rows = await prisma.valePass.findMany({ where: { campaignId: campaign.id }, orderBy: { code: 'asc' } });
  expect(rows).toHaveLength(quantity);
  return { campaign, orderId, rows };
}

type CancelTopic = 'orders/cancelled' | 'orders/updated' | 'refunds/create';

function cancellationWebhook(topic: CancelTopic, orderId: string, webhookId = nextWebhookId()) {
  const payload =
    topic === 'refunds/create'
      ? { id: counter++, order_id: Number(orderId), transactions: [{ amount: '150.00' }] }
      : { id: Number(orderId), cancel_reason: 'customer', cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString(), financial_status: 'refunded' };
  return webhooks.handleIncoming({ topic, shopifyWebhookId: webhookId, payload });
}

const voucher = (id: string) => prisma.valePass.findUniqueOrThrow({ where: { id } });
const eventsOf = (id: string) => prisma.valePassEvent.findMany({ where: { valePassId: id }, orderBy: { createdAt: 'asc' } });
const countEvents = async (id: string, type: string) => prisma.valePassEvent.count({ where: { valePassId: id, type } });
const countAudit = (id: string, action: string) => prisma.adminAuditEvent.count({ where: { entityId: id, action } });
const settle = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

/** Cliente Prisma cuja gravação de auditoria sempre falha — dentro e fora de
 *  transação — pra provar que a mudança de status não sobrevive sem ela. */
function prismaWithFailingAudit(): PrismaService {
  const failing = { create: async () => { throw new Error('falha simulada na auditoria'); } };
  const wrap = <T extends object>(client: T): T =>
    new Proxy(client, {
      get(target, prop) {
        if (prop === 'adminAuditEvent') return failing;
        if (prop === '$transaction') {
          const original = (target as unknown as { $transaction: (fn: (tx: object) => unknown, opts?: unknown) => Promise<unknown> }).$transaction.bind(target);
          return (fn: (tx: object) => unknown, opts?: unknown) => original((tx) => fn(wrap(tx)), opts);
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  return wrap(prisma);
}

async function cleanup() {
  const ids = (await prisma.valePass.findMany({ where: { campaign: { name: CAMPAIGN_NAME } }, select: { id: true } })).map((v) => v.id);
  if (ids.length) {
    await prisma.$executeRaw`DELETE FROM vale_pass_events WHERE vale_pass_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE entity_id = ANY(${ids}::text[])`;
    await prisma.$executeRaw`DELETE FROM vale_passes WHERE id = ANY(${ids}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM vale_pass_campaigns WHERE name = ${CAMPAIGN_NAME}`;
  if (createdOrderIds.length) await prisma.$executeRaw`DELETE FROM vale_pass_order_cancellations WHERE shopify_order_id = ANY(${createdOrderIds}::text[])`;

  const reservationIds = (await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id FROM reservation_items ri JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ru.code LIKE ${TAG + '%'}
  `).map((r) => r.id);
  await prisma.$executeRaw`DELETE FROM reservation_events WHERE webhook_event_id IN (SELECT id FROM webhook_events WHERE shopify_webhook_id LIKE ${TAG + '-%'}) OR reservation_id = ANY(${reservationIds}::uuid[])`;
  await prisma.$executeRaw`DELETE FROM webhook_events WHERE shopify_webhook_id LIKE ${TAG + '-%'}`;
  if (reservationIds.length) {
    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${reservationIds}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${TAG + '%'}`;

  const admins = (await prisma.adminUser.findMany({ where: { phone: { startsWith: TAG } }, select: { id: true } })).map((a) => a.id);
  if (admins.length) {
    await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE admin_user_id = ANY(${admins}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM admin_users WHERE id = ANY(${admins}::uuid[])`;
  }
}

localDescribe('Valle Pass × webhooks Shopify — cancelamento, restauração e concorrência (Postgres local)', () => {
  beforeAll(async () => {
    await cleanup();
    await ensureStoreConfig(prisma, resolveStoreConfig());
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  describe('ordem dos eventos', () => {
    test.each<CancelTopic>(['refunds/create', 'orders/cancelled', 'orders/updated'])(
      'admin cancela → %s chega depois → restauração bloqueada, cancelamento manual preservado',
      async (topic) => {
        const admin = await createAdmin();
        const { orderId, rows: [v] } = await paidOrder(1);
        await vouchers.cancel(v.code, 'cliente pediu', admin.id, admin.name);

        await cancellationWebhook(topic, orderId);

        const record = await prisma.valePassOrderCancellation.findUniqueOrThrow({ where: { shopifyOrderId: orderId } });
        expect(record.topic).toBe(topic === 'orders/updated' ? 'orders/cancelled' : topic);

        await expect(vouchers.restore(v.code, 'tentativa depois do reembolso', admin.id, admin.name)).rejects.toThrow(ConflictException);

        const after = await voucher(v.id);
        expect(after.status).toBe('CANCELLED');
        expect(after.cancelledBy).toBe(admin.id); // o cancelamento manual continua sendo o que foi
        expect(after.cancelReason).toBe('cliente pediu');
        expect(await countEvents(v.id, 'SHOPIFY_ORDER_CANCELLED')).toBe(1);
        expect(await countEvents(v.id, 'RESTORED')).toBe(0);
      },
      20_000,
    );

    test('histórico e auditoria distinguem cancelamento manual, confirmação da Shopify e restauração bloqueada', async () => {
      const admin = await createAdmin();
      const { campaign, orderId, rows: [v] } = await paidOrder(1);
      await vouchers.cancel(v.code, 'cliente pediu', admin.id, admin.name);
      await cancellationWebhook('refunds/create', orderId);
      await expect(vouchers.restore(v.code, 'tentativa', admin.id, admin.name)).rejects.toThrow(ConflictException);

      const events = await eventsOf(v.id);
      expect(events.map((e) => e.type)).toEqual(['CREATED', 'CANCELLED', 'SHOPIFY_ORDER_CANCELLED', 'RESTORE_BLOCKED']);
      expect(events[1].detail).toMatchObject({ actorId: admin.id, reason: 'cliente pediu', source: 'admin' });
      expect(events[2].detail).toMatchObject({ orderId, topic: 'refunds/create', source: 'shopify', statusAtConfirmation: 'CANCELLED' });
      expect(events[3].detail).toMatchObject({ actorId: admin.id, reason: 'tentativa', blockedBy: 'shopify_order_cancelled' });

      expect(await countAudit(v.id, 'VALE_PASS_CANCELLED_BY_ADMIN')).toBe(1);
      expect(await countAudit(v.id, 'VALE_PASS_RESTORED')).toBe(0);
      const blocked = await prisma.adminAuditEvent.findFirstOrThrow({ where: { entityId: v.id, action: 'VALE_PASS_RESTORE_BLOCKED' } });
      expect(blocked.adminUserId).toBe(admin.id);
      expect(blocked.isCritical).toBe(true);
      expect(blocked.detail).toMatchObject({ code: v.code, blockedBy: 'shopify_order_cancelled' });

      const listed = (await vouchers.list({ campaignId: campaign.id })).find((item) => item.id === v.id);
      expect(listed).toMatchObject({ canBeRestored: false, restoreBlockedReason: 'O pedido Shopify deste vale foi cancelado ou reembolsado.' });
    }, 20_000);

    test('webhook chega primeiro → admin tenta restaurar → bloqueada e registrada', async () => {
      const admin = await createAdmin();
      const { orderId, rows: [v] } = await paidOrder(1);
      await cancellationWebhook('refunds/create', orderId);

      const cancelled = await voucher(v.id);
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.cancelledBy).toBeNull();
      expect((await eventsOf(v.id)).find((e) => e.type === 'CANCELLED')?.detail).toMatchObject({ source: 'shopify', reason: 'refunds/create' });

      await expect(vouchers.restore(v.code, 'tentativa', admin.id, admin.name)).rejects.toThrow(ConflictException);
      expect((await voucher(v.id)).status).toBe('CANCELLED');
      expect(await countEvents(v.id, 'RESTORE_BLOCKED')).toBe(1);
    }, 20_000);

    test('restauração concluída antes do webhook → o webhook cancela o vale restaurado', async () => {
      const admin = await createAdmin();
      const { orderId, rows: [v] } = await paidOrder(1);
      await vouchers.cancel(v.code, 'engano', admin.id, admin.name);
      await vouchers.restore(v.code, 'engano desfeito', admin.id, admin.name);

      await cancellationWebhook('orders/cancelled', orderId);

      const after = await voucher(v.id);
      expect(after.status).toBe('CANCELLED');
      expect(after.cancelledBy).toBeNull();
      expect((await eventsOf(v.id)).map((e) => e.type)).toEqual(['CREATED', 'CANCELLED', 'RESTORED', 'CANCELLED']);
    }, 20_000);

    test('orders/paid reentregue depois do cancelamento → o vale já nasce cancelado e não é restaurável', async () => {
      const admin = await createAdmin();
      const campaign = await createCampaign();
      const orderId = nextOrderId();
      await cancellationWebhook('orders/cancelled', orderId); // nenhum vale ainda: só o registro do pedido
      await webhooks.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: paidPayload(orderId, campaign.shopifyVariantId, 1) });

      const [v] = await prisma.valePass.findMany({ where: { campaignId: campaign.id } });
      expect(v.status).toBe('CANCELLED');
      expect(v.cancelledBy).toBeNull();
      expect((await eventsOf(v.id)).map((e) => e.type).sort()).toEqual(['CANCELLED', 'CREATED']);
      await expect(vouchers.restore(v.code, 'tentativa', admin.id, admin.name)).rejects.toThrow(ConflictException);
    }, 20_000);
  });

  describe('concorrência', () => {
    test('webhook em andamento segura o lock do pedido → restauração espera e é recusada', async () => {
      const admin = await createAdmin();
      const { orderId, rows: [a, b] } = await paidOrder(2);
      await vouchers.cancel(a.code, 'cliente pediu', admin.id, admin.name);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let applied!: () => void;
      const appliedSignal = new Promise<void>((resolve) => (applied = resolve));
      // Mesma sequência do WebhooksService: lock do pedido, depois o handler.
      const webhookTx = prisma.$transaction(async (tx) => {
        await lockShopifyOrder(tx, orderId);
        await valePassWebhook.handleOrderCancelledOrRefunded(tx, orderId, 'refunds/create');
        applied();
        await gate; // ainda não commitou: B cancelado e o pedido registrado só dentro desta transação
      }, { timeout: 20_000 });
      await appliedSignal;

      let settled = false;
      const restore = settle(vouchers.restore(a.code, 'tentativa concorrente', admin.id, admin.name)).finally(() => (settled = true));
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(settled).toBe(false); // bloqueada no lock do pedido, não passou por cima do webhook

      release();
      await webhookTx;
      const outcome = await restore;
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.error).toBeInstanceOf(ConflictException);
      expect((await voucher(a.id)).status).toBe('CANCELLED');
      expect((await voucher(b.id)).status).toBe('CANCELLED');
      expect(await countEvents(a.id, 'RESTORED')).toBe(0);
    }, 30_000);

    test('restauração e webhook disparados juntos, repetidamente → o vale nunca termina ACTIVE', async () => {
      for (let i = 0; i < 8; i++) {
        const admin = await createAdmin();
        const { orderId, rows: [a] } = await paidOrder(2);
        await vouchers.cancel(a.code, 'cliente pediu', admin.id, admin.name);

        const [restore, webhook] = await Promise.all([
          settle(vouchers.restore(a.code, 'corrida', admin.id, admin.name)),
          settle(cancellationWebhook('refunds/create', orderId)),
        ]);
        expect(webhook.ok).toBe(true);

        const after = await voucher(a.id);
        expect(after.status).toBe('CANCELLED');
        const events = await eventsOf(a.id);
        const shopifyCancels = events.filter((e) => e.type === 'CANCELLED' && (e.detail as { source?: string } | null)?.source === 'shopify');
        if (restore.ok) {
          // Restauração venceu o lock: o webhook, logo depois, cancelou o vale.
          expect(events.filter((e) => e.type === 'RESTORED')).toHaveLength(1);
          expect(shopifyCancels).toHaveLength(1);
          expect(after.cancelledBy).toBeNull();
        } else {
          expect(restore.error).toBeInstanceOf(ConflictException);
          expect(events.some((e) => e.type === 'RESTORED')).toBe(false);
          expect(shopifyCancels).toHaveLength(0);
          expect(after.cancelledBy).toBe(admin.id);
        }
      }
    }, 90_000);

    test('duas restaurações simultâneas → só uma vence', async () => {
      const admin = await createAdmin();
      const { rows: [v] } = await paidOrder(1);
      await vouchers.cancel(v.code, 'engano', admin.id, admin.name);

      const results = await Promise.all(Array.from({ length: 5 }, () => settle(vouchers.restore(v.code, 'duplo clique', admin.id, admin.name))));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const r of results) if (!r.ok) expect(r.error).toBeInstanceOf(HttpException);
      expect((await voucher(v.id)).status).toBe('ACTIVE');
      expect(await countEvents(v.id, 'RESTORED')).toBe(1);
      expect(await countAudit(v.id, 'VALE_PASS_RESTORED')).toBe(1);
    }, 30_000);

    test('restauração e uso simultâneos → cada transição acontece no máximo uma vez, em ordem válida', async () => {
      const admin = await createAdmin();
      const { rows: [v] } = await paidOrder(1);
      await vouchers.cancel(v.code, 'engano', admin.id, admin.name);

      const calls = Array.from({ length: 3 }, () => [
        settle(vouchers.restore(v.code, 'corrida com uso', admin.id, admin.name)),
        settle(vouchers.markUsed(v.code, admin.id, admin.name)),
      ]).flat();
      await Promise.all(calls);

      const after = await voucher(v.id);
      const restored = await countEvents(v.id, 'RESTORED');
      const used = await countEvents(v.id, 'USED');
      expect(restored).toBe(1);
      expect(used).toBeLessThanOrEqual(1);
      expect(after.status).toBe(used === 1 ? 'USED' : 'ACTIVE');
      expect(await countAudit(v.id, 'VALE_PASS_RESTORED')).toBe(1);
      expect(await countAudit(v.id, 'VALE_PASS_MARKED_USED')).toBe(used);
    }, 30_000);

    test('cancelamento e uso simultâneos de um vale ACTIVE → exatamente uma operação vence', async () => {
      const admin = await createAdmin();
      const { rows: [v] } = await paidOrder(1);

      const results = await Promise.all(
        Array.from({ length: 4 }, () => [settle(vouchers.cancel(v.code, 'corrida', admin.id, admin.name)), settle(vouchers.markUsed(v.code, admin.id, admin.name))]).flat(),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);

      const after = await voucher(v.id);
      expect(['CANCELLED', 'USED']).toContain(after.status);
      expect((await countEvents(v.id, 'CANCELLED')) + (await countEvents(v.id, 'USED'))).toBe(1);
    }, 30_000);
  });

  describe('idempotência', () => {
    test('mesmo webhook entregue várias vezes (inclusive em paralelo) → nenhum efeito duplicado', async () => {
      const admin = await createAdmin();
      const { orderId, rows: [a, b] } = await paidOrder(2);
      await vouchers.cancel(a.code, 'cliente pediu', admin.id, admin.name);

      const webhookId = nextWebhookId();
      const outcomes = await Promise.all([1, 2, 3].map(() => cancellationWebhook('refunds/create', orderId, webhookId)));
      expect(outcomes.map((o) => o.outcome).sort()).toEqual(['duplicate', 'duplicate', 'processed']);
      expect((await cancellationWebhook('refunds/create', orderId, webhookId)).outcome).toBe('duplicate');

      expect(await countEvents(a.id, 'SHOPIFY_ORDER_CANCELLED')).toBe(1);
      expect(await countEvents(b.id, 'CANCELLED')).toBe(1);
      expect(await prisma.valePassOrderCancellation.count({ where: { shopifyOrderId: orderId } })).toBe(1);
    }, 30_000);

    test('cancelamento e reembolso do mesmo pedido (tópicos diferentes) → primeira confirmação vence, eventos uma vez só', async () => {
      const admin = await createAdmin();
      const { orderId, rows: [a, b] } = await paidOrder(2);
      await vouchers.cancel(a.code, 'cliente pediu', admin.id, admin.name);

      await cancellationWebhook('orders/cancelled', orderId);
      await cancellationWebhook('refunds/create', orderId);
      await cancellationWebhook('orders/updated', orderId);

      const record = await prisma.valePassOrderCancellation.findUniqueOrThrow({ where: { shopifyOrderId: orderId } });
      expect(record.topic).toBe('orders/cancelled');
      expect(await countEvents(a.id, 'SHOPIFY_ORDER_CANCELLED')).toBe(1);
      expect(await countEvents(b.id, 'CANCELLED')).toBe(1);
      expect((await voucher(b.id)).cancelReason).toBe('orders/cancelled');
    }, 30_000);
  });

  test('pedido com vários vales — manual, ativo e usado — só o ativo muda de status; nenhum é restaurável ou utilizável', async () => {
    const admin = await createAdmin();
    const { campaign, orderId, rows: [manual, active, used] } = await paidOrder(3);
    await vouchers.cancel(manual.code, 'cancelado no balcão', admin.id, admin.name);
    await vouchers.markUsed(used.code, admin.id, admin.name);

    await cancellationWebhook('refunds/create', orderId);

    const [m, a, u] = await Promise.all([voucher(manual.id), voucher(active.id), voucher(used.id)]);
    expect(m).toMatchObject({ status: 'CANCELLED', cancelledBy: admin.id, cancelReason: 'cancelado no balcão' });
    expect(a).toMatchObject({ status: 'CANCELLED', cancelledBy: null, cancelReason: 'refunds/create' });
    expect(u.status).toBe('USED');
    expect(await countEvents(manual.id, 'SHOPIFY_ORDER_CANCELLED')).toBe(1);
    expect(await countEvents(used.id, 'SHOPIFY_ORDER_CANCELLED')).toBe(1);
    expect(await countEvents(active.id, 'SHOPIFY_ORDER_CANCELLED')).toBe(0); // ele ganhou o CANCELLED de origem Shopify

    await expect(vouchers.restore(manual.code, 'tentativa', admin.id, admin.name)).rejects.toThrow(ConflictException);
    await expect(vouchers.restore(active.code, 'tentativa', admin.id, admin.name)).rejects.toThrow(ConflictException);
    await expect(vouchers.markUsed(active.code, admin.id, admin.name)).rejects.toThrow(HttpException);

    const listed = await vouchers.list({ campaignId: campaign.id });
    expect(listed.find((i) => i.id === manual.id)).toMatchObject({ canBeRestored: false, restoreBlockedReason: 'O pedido Shopify deste vale foi cancelado ou reembolsado.' });
    expect(listed.find((i) => i.id === active.id)).toMatchObject({ canBeRestored: false, restoreBlockedReason: 'Cancelado automaticamente por um cancelamento/reembolso do pedido na Shopify.' });
  }, 30_000);

  test('reserva manual vinculada ao mesmo número de pedido nunca é alterada pelos webhooks', async () => {
    const { orderId, rows: [v] } = await paidOrder(1);
    const unit = await prisma.rentalUnit.create({
      data: { code: `${TAG}-u0`, name: 'peça de teste', shopifyVariantId: `${TAG}-u0-variant`, active: true, reservableOnline: true, countsTowardRentalDuration: true },
    });
    const [reservation] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO reservations (id, status, source, origin_store_id, pickup_date, return_date, checkout_state, shopify_cart_id, shopify_order_id, terms_accepted_at, terms_version, created_at, customer_email)
      VALUES (gen_random_uuid(), 'confirmed'::"reservation_status", 'manual_admin'::"reservation_source", ${resolveStoreConfig().id},
        '2029-03-10'::date, '2029-03-12'::date, 'ready'::"checkout_state", ${`${TAG}-cart`}, ${orderId}, now(), 'test', now(), 'manual@example.test')
      RETURNING id
    `;
    await prisma.$executeRaw`
      INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
      VALUES (gen_random_uuid(), ${reservation.id}::uuid, ${unit.id}::uuid, 'confirmed'::"reservation_status", daterange('2029-03-07'::date, '2029-03-15'::date, '[)'))
    `;
    const before = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id }, include: { items: true } });

    await cancellationWebhook('refunds/create', orderId);
    await cancellationWebhook('orders/cancelled', orderId);
    await cancellationWebhook('orders/updated', orderId);

    const after = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id }, include: { items: true } });
    expect(after.status).toBe('confirmed');
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.items.map((i) => i.status)).toEqual(['confirmed']);
    expect(await prisma.reservationEvent.count({ where: { reservationId: reservation.id } })).toBe(0);
    expect((await voucher(v.id)).status).toBe('CANCELLED'); // o vale do pedido, sim, é cancelado
  }, 30_000);

  describe('falha no meio da transação → rollback total', () => {
    test('restauração: auditoria falha → vale continua CANCELLED, sem evento nem auditoria de restauração', async () => {
      const admin = await createAdmin();
      const { rows: [v] } = await paidOrder(1);
      await vouchers.cancel(v.code, 'engano', admin.id, admin.name);

      const failing = new ValePassVouchersService(prismaWithFailingAudit());
      await expect(failing.restore(v.code, 'vai falhar', admin.id, admin.name)).rejects.toThrow(ServiceUnavailableException);

      const after = await voucher(v.id);
      expect(after).toMatchObject({ status: 'CANCELLED', cancelledBy: admin.id, cancelReason: 'engano' });
      expect(await countEvents(v.id, 'RESTORED')).toBe(0);
      expect(await countAudit(v.id, 'VALE_PASS_RESTORED')).toBe(0);
    }, 20_000);

    test('cancelamento e uso: auditoria falha → vale continua ACTIVE, sem eventos', async () => {
      const admin = await createAdmin();
      const { rows: [v] } = await paidOrder(1);
      const failing = new ValePassVouchersService(prismaWithFailingAudit());

      await expect(failing.cancel(v.code, 'vai falhar', admin.id, admin.name)).rejects.toThrow(ServiceUnavailableException);
      await expect(failing.markUsed(v.code, admin.id, admin.name)).rejects.toThrow(ServiceUnavailableException);

      expect((await voucher(v.id)).status).toBe('ACTIVE');
      expect((await eventsOf(v.id)).map((e) => e.type)).toEqual(['CREATED']);
    }, 20_000);

    test('webhook: falha depois de processar o Valle Pass → nada fica gravado (nem registro do pedido, nem cancelamento)', async () => {
      const admin = await createAdmin();
      const { orderId, rows: [manual, active] } = await paidOrder(2);
      await vouchers.cancel(manual.code, 'cliente pediu', admin.id, admin.name);

      class FailingAfterValePass extends ValePassWebhookService {
        override async handleOrderCancelledOrRefunded(tx: Prisma.TransactionClient, id: string, topic: string): ReturnType<ValePassWebhookService['handleOrderCancelledOrRefunded']> {
          await super.handleOrderCancelledOrRefunded(tx, id, topic);
          throw new Error('falha simulada depois de gravar o Valle Pass');
        }
      }
      const failingWebhooks = new WebhooksService(prisma, new FailingAfterValePass(), new ShopifyOrderSyncService());
      const webhookId = nextWebhookId();
      await expect(
        failingWebhooks.handleIncoming({ topic: 'refunds/create', shopifyWebhookId: webhookId, payload: { id: counter++, order_id: Number(orderId), transactions: [] } }),
      ).rejects.toThrow(ServiceUnavailableException);

      expect(await prisma.valePassOrderCancellation.count({ where: { shopifyOrderId: orderId } })).toBe(0);
      expect((await voucher(active.id)).status).toBe('ACTIVE');
      expect(await countEvents(manual.id, 'SHOPIFY_ORDER_CANCELLED')).toBe(0);
      expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { shopifyWebhookId: webhookId } })).status).toBe('failed');

      // A reentrega da Shopify (mesmo id, agora sem falha) aplica tudo.
      await cancellationWebhook('refunds/create', orderId, webhookId);
      expect((await voucher(active.id)).status).toBe('CANCELLED');
      expect(await countEvents(manual.id, 'SHOPIFY_ORDER_CANCELLED')).toBe(1);
    }, 30_000);
  });
});
