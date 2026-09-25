import { ShopifyOrderSyncService } from './webhooks/shopify-order-sync.service';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from './prisma/prisma.service';
import { RentalRuleConfigService } from './rental-rule-config/rental-rule-config.service';
import { AdminRulesService } from './admin-panel/rules.service';
import { AdminBlocksService } from './admin-panel/blocks.service';
import { HoldsService } from './holds/holds.service';
import { AvailabilityService } from './availability/availability.service';
import { AdminReservationsService } from './admin-reservations/admin-reservations.service';
import { RentalPlanService } from './rental-plan/rental-plan.service';
import { CheckoutService } from './checkout/checkout.service';
import type { ShopifyCartClient } from './checkout/shopify-storefront-cart.client';
import { CreateHoldDto } from './holds/dto/create-hold.dto';
import { CreateManualReservationDto } from './admin-reservations/dto/create-manual-reservation.dto';
import { DEFAULT_RENTAL_RULE_CONFIG } from './rental-rules/rental-rule-config';
import { addDays, civilDateToISO, isSunday } from './rental-rules/civil-date';
import { today } from './rental-rules/rental-engine';
import { AppController } from './app.controller';
import { AdminPiecesService } from './admin-panel/pieces.service';
import { WebhooksService } from './webhooks/webhooks.service';
import { ValePassWebhookService } from './vale-pass/vale-pass-webhook.service';
import { ensureStoreConfig } from './holds/store-config';

const prisma = new PrismaService();
const config = new RentalRuleConfigService(prisma);
const rules = new AdminRulesService(prisma);
const holds = new HoldsService(prisma, config);
const manual = new AdminReservationsService(prisma, config);
const availability = new AvailabilityService(prisma, config);
const blocks = new AdminBlocksService(prisma);
const prefix = `final-audit-${randomUUID()}`;
let adminUserId: string;
let original: Awaited<ReturnType<typeof rules.get>>;
let nextUnit = 0;
let nextWebhook = 0;
/** Achado (limpeza órfã depois de uma falha): um `shopifyWebhookId`
 *  gerado com `randomUUID()` cru não carrega `prefix`, então o
 *  afterAll só consegue achar o webhookEvent de volta indiretamente
 *  (via reservationId) — e pelo menos um caso aqui (orders/paid
 *  chegando DEPOIS de orders/cancelled, linha ~309) cria um segundo
 *  webhookEvent que nenhum finally local limpa. Prefixar todo
 *  shopifyWebhookId gerado neste arquivo com `prefix` dá ao afterAll
 *  uma forma direta e completa de achar (e apagar) todos eles. */
function nextWebhookId(): string {
  return `${prefix}-webhook-${nextWebhook++}`;
}
const base = { ...DEFAULT_RENTAL_RULE_CONFIG, minAdvanceDays: 0, operationStartDate: null, maxPieces: 8, piecesToDaysTable: [{ upTo: 8, days: 2 }] };
let pickup = addDays(today(base), 45);
while (isSunday(pickup) || isSunday(addDays(pickup, 2))) pickup = addDays(pickup, 1);
const pickupDate = civilDateToISO(pickup);
const bindingSecret = process.env.RESERVATION_BINDING_SECRET;

async function units(count = 1, reservableOnline = true) {
  const variant = `${prefix}-${nextUnit++}`;
  await prisma.rentalUnit.createMany({ data: Array.from({ length: count }, (_, i) => ({ code: `${variant}-${i}`, name: 'Audit fixture', shopifyVariantId: variant, reservableOnline, countsTowardRentalDuration: reservableOnline })) });
  return prisma.rentalUnit.findMany({ where: { shopifyVariantId: variant }, orderBy: { id: 'asc' } });
}
function holdDto(variant: string, quantity = 1) {
  return { items: [{ shopifyVariantId: variant, quantity }], pickupDate, termsAccepted: true };
}
function manualDto(ids: string[]) {
  return { items: ids.map((rentalUnitId) => ({ rentalUnitId })), pickupDate, customerName: 'Audit fixture', customerPhone: '+56900000000' };
}
function cartResult() {
  return { ok: true as const, cartId: `gid://shopify/Cart/${randomUUID()}`, checkoutUrl: 'https://dev-store.myshopify.com/test-checkout' };
}
function checkout(client: ShopifyCartClient['cartCreate']) {
  return new CheckoutService(prisma, config, { cartCreate: client } as ShopifyCartClient);
}
async function change(data: Parameters<typeof rules.update>[0]) {
  return rules.update(data, adminUserId, 'Audit admin');
}

beforeAll(async () => {
  original = await rules.get();
  adminUserId = (await prisma.adminUser.create({ data: { name: 'Audit admin', phone: prefix, pinHash: 'unused', role: 'ADMIN' } })).id;
  await prisma.rentalRuleConfig.update({ where: { id: 'default' }, data: base });
  process.env.RESERVATION_BINDING_SECRET = randomUUID();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await prisma.operationalBlock.deleteMany({ where: { createdByAdminUserId: adminUserId } });
  await prisma.rentalRuleConfig.update({ where: { id: 'default' }, data: base });
});
afterAll(async () => {
  // Best-effort por etapa (achado real: um erro numa etapa — ex.:
  // FK ao apagar webhookEvent — abortava TODA a limpeza depois dela,
  // deixando rental_units/reservations órfãs visíveis no ClosetAdmin
  // "Peças" até alguém investigar manualmente). Uma etapa que falha só
  // é logada; as demais continuam tentando limpar o que der.
  async function step(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (err) {
      console.error(`[backend-audit cleanup] falhou "${label}":`, err instanceof Error ? err.message : err);
    }
  }

  try {
    // Restore the singleton even if cleanup of a related fixture fails.
    await step('restore rental_rule_config', () =>
      prisma.rentalRuleConfig.update({
        where: { id: 'default' },
        data: {
          ...original,
          operationStartDate: original.operationStartDate ? new Date(original.operationStartDate) : null,
          piecesToDaysTable: original.piecesToDaysTable as object[],
        },
      }),
    );
    const reserved = await prisma.reservation.findMany({ where: { items: { some: { rentalUnit: { code: { startsWith: prefix } } } } }, select: { id: true } });
    const ids = reserved.map(({ id }) => id);
    // Busca por `shopifyWebhookId` prefixado (ver nextWebhookId) em vez
    // de só por reservationId — mais completa: também acha webhooks
    // criados por um handleIncoming() cujo próprio finally local do
    // teste não cobria (ex.: um segundo evento chegando depois do
    // primeiro, linha ~309).
    const webhooks = await prisma.webhookEvent.findMany({ where: { shopifyWebhookId: { startsWith: prefix } }, select: { id: true } });
    const webhookIds = webhooks.map(({ id }) => id);
    await step('reservationEvent deleteMany', () =>
      prisma.reservationEvent.deleteMany({ where: { OR: [{ reservationId: { in: ids } }, { webhookEventId: { in: webhookIds } }] } }),
    );
    await step('webhookEvent deleteMany', () => prisma.webhookEvent.deleteMany({ where: { id: { in: webhookIds } } }));
    await step('holdIdempotencyKey deleteMany', () => prisma.holdIdempotencyKey.deleteMany({ where: { reservationId: { in: ids } } }));
    await step('manualReservationIdempotencyKey deleteMany', () => prisma.manualReservationIdempotencyKey.deleteMany({ where: { reservationId: { in: ids } } }));
    await step('reservationItem deleteMany', () => prisma.reservationItem.deleteMany({ where: { reservationId: { in: ids } } }));
    await step('reservation deleteMany', () => prisma.reservation.deleteMany({ where: { id: { in: ids } } }));
    await step('rentalUnit deleteMany', () => prisma.rentalUnit.deleteMany({ where: { code: { startsWith: prefix } } }));
    await step('adminAuditEvent deleteMany', () => prisma.adminAuditEvent.deleteMany({ where: { adminUserId } }));
    await step('adminUser delete', () => prisma.adminUser.delete({ where: { id: adminUserId } }));
    await step('store deleteMany', () => prisma.store.deleteMany({ where: { id: { startsWith: prefix } } }));
  } finally {
    // Restaurar a env var e desconectar o Prisma mesmo se alguma etapa de
    // limpeza acima falhar — sem isto, uma falha em qualquer delete deixa o
    // binding secret vazando pros próximos arquivos de teste e a conexão do
    // Prisma aberta (achado: afterAll não tinha try/finally, então uma
    // exceção no meio da limpeza pulava tanto a restauração da env var
    // quanto o $disconnect()).
    if (bindingSecret === undefined) delete process.env.RESERVATION_BINDING_SECRET;
    else process.env.RESERVATION_BINDING_SECRET = bindingSecret;
    await prisma.$disconnect();
  }
});

describe('Final backend audit: real PostgreSQL', () => {
  test('concurrent first use initializes one consistent store without unique-key failures', async () => {
    const store = { id: `${prefix}-store`, shopifyDomain: `${prefix}-store.myshopify.com`, currency: 'CLP' };
    await Promise.all(Array.from({ length: 8 }, () => prisma.$transaction((tx) => ensureStoreConfig(tx, store))));
    expect(await prisma.store.count({ where: { id: store.id, shopifyDomain: store.shopifyDomain, currency: store.currency } })).toBe(1);
    await expect(prisma.$transaction((tx) => ensureStoreConfig(tx, { ...store, currency: 'BRL' }))).rejects.toMatchObject({ status: 503 });
  });
  test('already-expired reservations consistently return 410 without calling Shopify', async () => {
    const [unit] = await units();
    const hold = await holds.createHold(holdDto(unit.shopifyVariantId!));
    await prisma.reservation.update({ where: { id: hold.reservationId }, data: { status: 'expired' } });
    const client = vi.fn(async () => cartResult());
    const service = checkout(client);
    const dto = { reservationId: hold.reservationId, holdToken: hold.holdToken! };
    await expect(service.createCheckout(dto)).rejects.toMatchObject({ status: 410 });
    await expect(service.createCheckout(dto)).rejects.toMatchObject({ status: 410 });
    await expect(service.createCheckout({ ...dto, holdToken: 'wrong' })).rejects.toMatchObject({ status: 403 });
    expect(client).not.toHaveBeenCalled();
  });
  test('legacy paid order with only calendar properties cannot confirm or allocate a reservation', async () => {
    const [unit] = await units();
    const hold = await holds.createHold(holdDto(unit.shopifyVariantId!));
    const webhookId = nextWebhookId();
    const service = new WebhooksService(prisma, new ValePassWebhookService(), new ShopifyOrderSyncService());
    const input = { topic: 'orders/paid', shopifyWebhookId: webhookId, payload: {
      id: Date.now(), financial_status: 'paid', note_attributes: [],
      line_items: [{ variant_id: unit.shopifyVariantId, quantity: 1, properties: [
        { name: '_vsc_pickup', value: pickupDate }, { name: '_vsc_return', value: hold.effectiveReturnDate },
      ] }],
    } };
    try {
      expect(await service.handleIncoming(input)).toEqual({ outcome: 'ignored' });
      expect(await service.handleIncoming(input)).toEqual({ outcome: 'duplicate' });
      const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { shopifyWebhookId: webhookId } });
      expect(event.reservationId).toBeNull();
      expect(await prisma.reservationEvent.count({ where: { webhookEventId: event.id, type: 'WEBHOOK_UNRESOLVED_RESERVATION' } })).toBe(1);
      expect((await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } })).status).toBe('hold');
      expect(await prisma.reservationItem.count({ where: { rentalUnitId: unit.id } })).toBe(1);
      await expect(holds.createHold(holdDto(unit.shopifyVariantId!))).rejects.toMatchObject({ status: 409 });
    } finally {
      const event = await prisma.webhookEvent.findUnique({ where: { shopifyWebhookId: webhookId } });
      if (event) {
        await prisma.reservationEvent.deleteMany({ where: { webhookEventId: event.id } });
        await prisma.webhookEvent.delete({ where: { id: event.id } });
      }
    }
  });
  test('DTOs accept 8 pieces and reject 51', async () => {
    expect(await validate(plainToInstance(CreateHoldDto, holdDto('fixture', 8)))).toHaveLength(0);
    expect(await validate(plainToInstance(CreateHoldDto, holdDto('fixture', 51)))).not.toHaveLength(0);
    expect(await validate(plainToInstance(CreateManualReservationDto, manualDto(Array.from({ length: 8 }, () => randomUUID()))))).toHaveLength(0);
    expect(await validate(plainToInstance(CreateManualReservationDto, manualDto(Array.from({ length: 51 }, () => randomUUID()))))).not.toHaveLength(0);
  });
  test('HOLD and manual reservations accept the configured maximum above six', async () => {
    const online = await units(8);
    expect((await holds.createHold(holdDto(online[0].shopifyVariantId!, 8))).items[0].quantity).toBe(8);
    const offline = await units(8);
    expect((await manual.createManual(manualDto(offline.map(({ id }) => id)))).items).toHaveLength(8);
  });
  test('HOLD, manual, availability and rental-plan respect a lower DB maximum', async () => {
    await change({ maxPieces: 1, adminUserId });
    const rows = await units(2);
    await expect(holds.createHold(holdDto(rows[0].shopifyVariantId!, 2))).rejects.toMatchObject({ status: 422 });
    await expect(manual.createManual(manualDto(rows.map(({ id }) => id)))).rejects.toMatchObject({ status: 422 });
    const response = await availability.getAvailability({ shopifyVariantId: rows[0].shopifyVariantId!, countedPieces: 2, from: pickupDate, to: pickupDate });
    expect(response.days[0]).toMatchObject({ bookable: false, reason: 'max_pieces_exceeded' });
    await expect(new RentalPlanService(config).getDuration(2)).rejects.toMatchObject({ status: 422 });
  });
  test('accessories remain impossible to reserve online', async () => {
    const [unit] = await units(1, false);
    await expect(holds.createHold(holdDto(unit.shopifyVariantId!))).rejects.toMatchObject({ status: 422 });
    await expect(availability.getAvailability({ shopifyVariantId: unit.shopifyVariantId!, countedPieces: 1, from: pickupDate, to: pickupDate })).rejects.toMatchObject({ status: 422 });
  });
  test.each(['UNIT', 'STORE_WIDE'] as const)('one-day %s block includes its final date in HOLD, availability and manual', async (scope) => {
    const [unit] = await units();
    const date = civilDateToISO(addDays(pickup, -base.prepDays));
    await blocks.create({ scope, ...(scope === 'UNIT' ? { rentalUnitId: unit.id } : {}), startDate: date, endDate: date, reason: 'Audit block', adminUserId }, adminUserId, 'Audit admin');
    await expect(holds.createHold(holdDto(unit.shopifyVariantId!))).rejects.toMatchObject({ status: 409 });
    await expect(manual.createManual(manualDto([unit.id]))).rejects.toMatchObject({ status: 409 });
    const response = await availability.getAvailability({ shopifyVariantId: unit.shopifyVariantId!, countedPieces: 1, from: pickupDate, to: pickupDate });
    expect(response.days[0].bookable).toBe(false);
  });
  test('availability scans the entire configured duration, not a fixed eight-day margin', async () => {
    const [unit] = await units();
    await change({ piecesToDaysTable: [{ upTo: 8, days: 20 }], adminUserId });
    await prisma.store.upsert({ where: { id: prefix }, create: { id: prefix, shopifyDomain: `${prefix}.myshopify.com`, currency: 'CLP' }, update: {} });
    const reservation = await prisma.reservation.create({ data: { status: 'confirmed', originStoreId: prefix } });
    const from = civilDateToISO(addDays(pickup, 15));
    const to = civilDateToISO(addDays(pickup, 18));
    await prisma.$executeRaw`INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range) VALUES (gen_random_uuid(), ${reservation.id}::uuid, ${unit.id}::uuid, 'confirmed', daterange(${from}::date, ${to}::date, '[)'))`;
    const response = await availability.getAvailability({ shopifyVariantId: unit.shopifyVariantId!, countedPieces: 1, from: pickupDate, to: pickupDate });
    expect(response.days[0].bookable).toBe(false);
  });
  test('rule updates cannot combine into an invalid configuration under concurrency', async () => {
    const results = await Promise.allSettled([
      change({ maxPieces: 6, piecesToDaysTable: [{ upTo: 6, days: 2 }], adminUserId }),
      change({ maxPieces: 8, adminUserId }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled').length).toBeGreaterThan(0);
    const final = await config.load();
    expect(final.piecesToDaysTable.at(-1)!.upTo).toBeGreaterThanOrEqual(final.maxPieces);
  });
  test('corrupt persisted rules fail closed', async () => {
    await prisma.rentalRuleConfig.update({ where: { id: 'default' }, data: { piecesToDaysTable: [] } });
    await expect(config.load()).rejects.toMatchObject({ status: 503 });
  });
  test('block removal rolls back when its audit cannot be persisted', async () => {
    const block = await blocks.create({ scope: 'STORE_WIDE', startDate: pickupDate, endDate: pickupDate, reason: 'Audit block', adminUserId }, adminUserId, 'Audit admin');
    await expect(blocks.remove(block.id, randomUUID(), 'Invalid admin')).rejects.toMatchObject({ status: 503 });
    expect((await prisma.operationalBlock.findUniqueOrThrow({ where: { id: block.id } })).removedAt).toBeNull();
  });
  test('HOLD replay and checkout preserve the accepted plan after rules change', async () => {
    const rows = await units(8);
    const dto = holdDto(rows[0].shopifyVariantId!, 8);
    const key = randomUUID();
    const first = await holds.createHold(dto, key);
    await change({ maxPieces: 1, piecesToDaysTable: [{ upTo: 1, days: 1 }], adminUserId });
    const replay = await holds.createHold(dto, key);
    expect(replay).toMatchObject({ reservationId: first.reservationId, durationDays: first.durationDays, calculatedReturnDate: first.calculatedReturnDate, holdToken: null });
    const client = vi.fn<ShopifyCartClient['cartCreate']>(async () => cartResult());
    await checkout(client).createCheckout({ reservationId: first.reservationId, holdToken: first.holdToken! });
    expect(client.mock.calls[0][1]).toContainEqual({ key: 'rental_duration_days', value: '2' });
  });
  test.each(['cancelled', 'expired'] as const)('slow Shopify response cannot resurrect a %s HOLD', async (status) => {
    const [unit] = await units();
    const hold = await holds.createHold(holdDto(unit.shopifyVariantId!));
    const client = async () => {
      await prisma.reservation.update({ where: { id: hold.reservationId }, data: { status } });
      return cartResult();
    };
    await expect(checkout(client).createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! })).rejects.toMatchObject({ status: 503 });
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } })).status).toBe(status);
  });
  test('an expired payment window cannot replay a payable checkout', async () => {
    const [unit] = await units();
    const hold = await holds.createHold(holdDto(unit.shopifyVariantId!));
    const service = checkout(async () => cartResult());
    const dto = { reservationId: hold.reservationId, holdToken: hold.holdToken! };
    await service.createCheckout(dto);
    await prisma.reservation.update({ where: { id: hold.reservationId }, data: { paymentExpiresAt: new Date(0) } });
    await expect(service.createCheckout(dto)).rejects.toMatchObject({ status: 410 });
    expect((await prisma.reservationItem.findFirstOrThrow({ where: { reservationId: hold.reservationId } })).status).toBe('expired');
  });
  test('health checks database invariants and fails closed on database errors', async () => {
    await expect(new AppController(prisma).health()).resolves.toEqual({ status: 'ok' });
    await expect(new AppController({ $queryRaw: vi.fn().mockRejectedValue(new Error('private host')) } as unknown as PrismaService).health()).rejects.toMatchObject({ status: 503 });
  });
  test('unit updates roll back if audit persistence fails', async () => {
    const [unit] = await units();
    await expect(new AdminPiecesService(prisma).update(unit.id, { active: false }, randomUUID(), 'Missing admin')).rejects.toMatchObject({ status: 503 });
    expect((await prisma.rentalUnit.findUniqueOrThrow({ where: { id: unit.id } })).active).toBe(true);
  });
  test('HOLD expiration during cart creation cannot enter pending_payment', async () => {
    const [unit] = await units();
    const hold = await holds.createHold(holdDto(unit.shopifyVariantId!));
    const client = async () => {
      await prisma.reservation.update({ where: { id: hold.reservationId }, data: { expiresAt: new Date(0) } });
      return cartResult();
    };
    await expect(checkout(client).createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! })).rejects.toMatchObject({ status: 503 });
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } })).status).not.toBe('pending_payment');
  });
  test('a superseded checkout attempt cannot overwrite the winning cart or binding', async () => {
    const [unit] = await units();
    const hold = await holds.createHold(holdDto(unit.shopifyVariantId!));
    const dto = { reservationId: hold.reservationId, holdToken: hold.holdToken! };
    const winner = cartResult();
    const firstClient = async () => {
      await prisma.$executeRaw`UPDATE reservations SET updated_at = now() - interval '1 minute' WHERE id = ${hold.reservationId}::uuid`;
      await checkout(async () => winner).createCheckout(dto);
      return cartResult();
    };
    await expect(checkout(firstClient).createCheckout(dto)).rejects.toMatchObject({ status: 503 });
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } })).shopifyCartId).toBe(winner.cartId);
  });
  test.each(['inactive', 'blocked'] as const)('late payment cannot recover an %s original unit', async (reason) => {
    const [unit] = await units();
    const hold = await holds.createHold(holdDto(unit.shopifyVariantId!));
    let attributes: { key: string; value: string }[] = [];
    await checkout(async (_lines, attrs) => { attributes = [...attrs]; return cartResult(); }).createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! });
    await prisma.reservation.update({ where: { id: hold.reservationId }, data: { paymentExpiresAt: new Date(0) } });
    if (reason === 'inactive') await prisma.rentalUnit.update({ where: { id: unit.id }, data: { active: false } });
    else await blocks.create({ scope: 'UNIT', rentalUnitId: unit.id, startDate: pickupDate, endDate: pickupDate, reason: 'Audit block', adminUserId }, adminUserId, 'Audit admin');
    const orderId = Date.now();
    await new WebhooksService(prisma, new ValePassWebhookService(), new ShopifyOrderSyncService()).handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload: {
      id: orderId, admin_graphql_api_id: `gid://shopify/Order/${orderId}`, financial_status: 'paid',
      note_attributes: attributes.map(({ key, value }) => ({ name: key, value })),
      line_items: [{ variant_id: unit.shopifyVariantId, quantity: 1 }],
    } });
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } })).status).toBe('late_payment_conflict');
  });
  test.each(['orders/cancelled', 'refunds/create'] as const)('%s arriving before orders/paid is not lost', async (topic) => {
    const [unit] = await units();
    const hold = await holds.createHold(holdDto(unit.shopifyVariantId!));
    let attributes: { key: string; value: string }[] = [];
    await checkout(async (_lines, attrs) => { attributes = [...attrs]; return cartResult(); }).createCheckout({ reservationId: hold.reservationId, holdToken: hold.holdToken! });
    const orderId = Date.now();
    const payload = {
      id: orderId, admin_graphql_api_id: `gid://shopify/Order/${orderId}`, financial_status: 'paid',
      note_attributes: attributes.map(({ key, value }) => ({ name: key, value })), line_items: [{ variant_id: unit.shopifyVariantId, quantity: 1 }],
    };
    const service = new WebhooksService(prisma, new ValePassWebhookService(), new ShopifyOrderSyncService());
    const firstId = nextWebhookId();
    try {
      await service.handleIncoming({ topic, shopifyWebhookId: firstId, payload: topic === 'refunds/create' ? { id: orderId + 1, order_id: orderId, transactions: [] } : payload });
      await service.handleIncoming({ topic: 'orders/paid', shopifyWebhookId: nextWebhookId(), payload });
      expect((await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } })).status).toBe(topic === 'orders/cancelled' ? 'cancelled' : 'problem');
    } finally {
      const first = await prisma.webhookEvent.findUnique({ where: { shopifyWebhookId: firstId } });
      if (first) {
        await prisma.reservationEvent.deleteMany({ where: { webhookEventId: first.id } });
        await prisma.webhookEvent.delete({ where: { id: first.id } });
      }
    }
  });
});
