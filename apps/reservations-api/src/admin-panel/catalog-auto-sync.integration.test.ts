import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AvailabilityController } from '../availability/availability.controller';
import { AvailabilityService } from '../availability/availability.service';
import { HoldsService } from '../holds/holds.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { addDays, civilDateToISO } from '../rental-rules/civil-date';
import { today } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';
import { ValePassWebhookService } from '../vale-pass/vale-pass-webhook.service';
import { ShopifyOrderSyncService } from '../webhooks/shopify-order-sync.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import type { ShopifyAdminClient, ShopifyCatalogVariant } from './shopify-admin.client';
import { ShopifyCatalogSyncService } from './shopify-catalog-sync.service';
import { ShopifyCatalogService } from './shopify-catalog.service';
import { CatalogRevalidationService } from './catalog-revalidation.service';

/**
 * Anderson administra o catálogo na Shopify; a vitrine e o ClosetAdmin seguem sem
 * cadastro duplicado. Esta suíte cobre o caminho dos webhooks de produto
 * (create/update/delete) contra um Postgres de TESTE real, com a Shopify simulada
 * (nenhuma chamada de rede): produto novo, edição, preço, SKU, variantes, despublicação,
 * produto sem peça física, webhook duplicado / fora de ordem, falha temporária da Shopify,
 * reserva existente durante as mudanças e a impossibilidade de reservar peça inexistente.
 *
 * Princípios verificados: a Shopify é a fonte de título/preço/SKU; peça física NUNCA nasce
 * sozinha (estoque da Shopify não vira unidade); vínculo sempre pelo ID da variante; nada é
 * apagado; reservas existentes ficam intactas.
 */
const prisma = new PrismaService();
const RUN = Date.now();
const PREFIX = `cat-auto-${RUN}`;
const WEBHOOK_PREFIX = `cat-auto-wh-${RUN}`;

class FakeShopify {
  variants: ShopifyCatalogVariant[] = [];
  failuresLeft = 0;
  async listVariants(): Promise<ShopifyCatalogVariant[]> {
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new ServiceUnavailableException('Shopify Admin API indisponível (simulado).');
    }
    return this.variants;
  }
  async getVariant(id: string): Promise<ShopifyCatalogVariant | null> {
    return this.variants.find((v) => v.id === id) ?? null;
  }
}

/** Registra os avisos "o catálogo mudou" que iriam para a vitrine (nenhuma rede). */
class SpyNotifier extends CatalogRevalidationService {
  calls: (string | null)[] = [];
  mode: 'ok' | 'reject' = 'ok';
  override async notify(handle?: string | null): Promise<'sent' | 'disabled' | 'failed'> {
    this.calls.push(handle ?? null);
    if (this.mode === 'reject') throw new Error('vitrine fora do ar (simulado)');
    return 'sent';
  }
}

const fake = new FakeShopify();
const client = fake as unknown as ShopifyAdminClient;
const sync = new ShopifyCatalogSyncService(prisma, client);
const catalog = new ShopifyCatalogService(prisma, client);
const notifier = new SpyNotifier();
const webhooks = new WebhooksService(prisma, new ValePassWebhookService(), new ShopifyOrderSyncService(), sync, notifier);
const rules = new RentalRuleConfigService(prisma);
const availability = new AvailabilityService(prisma, rules);
const publicApi = new AvailabilityController(availability, prisma);
const holds = new HoldsService(prisma, rules);

let counter = 0;
const nextWebhookId = () => `${WEBHOOK_PREFIX}-${counter++}`;
const newNumber = () => `${RUN}${String(counter++).padStart(3, '0')}`;

function shopifyVariant(number: string, index: number, sku: string | null, overrides: Partial<ShopifyCatalogVariant> = {}, status = 'ACTIVE'): ShopifyCatalogVariant {
  return {
    id: `gid://shopify/ProductVariant/${number}${index}`,
    title: index === 0 ? 'Default Title' : `Tam ${index}`,
    sku,
    inventoryQuantity: 3,
    imageUrl: null,
    imageAlt: null,
    selectedOptions: [],
    product: { id: `gid://shopify/Product/${number}`, title: 'Jaqueta Firenze', handle: `jaqueta-${number}`, productType: 'Jaqueta', status },
    ...overrides,
  };
}

/** Peça física cadastrada para uma variante (o que o ClosetAdmin faz em "Cadastrar peças"). */
function registerUnit(v: ShopifyCatalogVariant, suffix: string, data: { active?: boolean; reservableOnline?: boolean; code?: string } = {}) {
  return prisma.rentalUnit.create({
    data: {
      code: data.code ?? `${PREFIX}-${suffix}`,
      name: v.product.title,
      shopifyProductId: v.product.id,
      shopifyVariantId: v.id,
      shopifySku: v.sku,
      active: data.active ?? true,
      reservableOnline: data.reservableOnline ?? true,
      countsTowardRentalDuration: true,
    },
  });
}

async function futureReservation(unitId: string) {
  const pickup = addDays(today(DEFAULT_RENTAL_RULE_CONFIG), 80 + counter++);
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservations (id, status, source, origin_store_id, pickup_date, return_date, terms_accepted_at, terms_version)
    VALUES (gen_random_uuid(), 'confirmed', 'manual_admin', 'dev-store', ${civilDateToISO(pickup)}::date, ${civilDateToISO(addDays(pickup, 2))}::date, now(), 'test')
    RETURNING id`;
  await prisma.$executeRaw`
    INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
    VALUES (gen_random_uuid(), ${row.id}::uuid, ${unitId}::uuid, 'confirmed',
            daterange(${civilDateToISO(addDays(pickup, -3))}::date, ${civilDateToISO(addDays(pickup, 5))}::date, '[)'))`;
  return row.id;
}

async function reservationSnapshot(id: string) {
  const r = await prisma.reservation.findUniqueOrThrow({ where: { id }, include: { items: true } });
  return { status: r.status, items: r.items.map((i) => ({ id: i.id, rentalUnitId: i.rentalUnitId, status: i.status })) };
}

const unit = (id: string) => prisma.rentalUnit.findUniqueOrThrow({ where: { id } });
const unitsOf = (variantId: string) => prisma.rentalUnit.findMany({ where: { shopifyVariantId: variantId } });
const publicState = async () => publicApi.getCatalogVariants();
const productWebhook = (topic: string, number: string, extra: Record<string, unknown> = {}, webhookId = nextWebhookId()) =>
  webhooks.handleIncoming({ topic, shopifyWebhookId: webhookId, payload: { id: Number(number), handle: `jaqueta-${number}`, ...extra } });
const pickupISO = () => civilDateToISO(addDays(today(DEFAULT_RENTAL_RULE_CONFIG), 90));

async function cleanup() {
  const units = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM rental_units WHERE code LIKE ${PREFIX + '%'} OR shopify_product_id LIKE ${'gid://shopify/Product/' + RUN + '%'}`;
  const unitIds = units.map((u) => u.id);
  if (unitIds.length) {
    const rs = await prisma.$queryRaw<{ id: string }[]>`SELECT DISTINCT reservation_id AS id FROM reservation_items WHERE rental_unit_id = ANY(${unitIds}::uuid[])`;
    const reservationIds = rs.map((r) => r.id);
    if (reservationIds.length) {
      await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
      await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
      await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${reservationIds}::uuid[])`;
    }
    await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE entity_id = ANY(${unitIds})`;
    await prisma.$executeRaw`DELETE FROM rental_units WHERE id = ANY(${unitIds}::uuid[])`;
  }
  const events = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM webhook_events WHERE shopify_webhook_id LIKE ${WEBHOOK_PREFIX + '%'}`;
  if (events.length) {
    await prisma.$executeRaw`DELETE FROM reservation_events WHERE webhook_event_id = ANY(${events.map((e) => e.id)}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM webhook_events WHERE shopify_webhook_id LIKE ${WEBHOOK_PREFIX + '%'}`;
  }
}

// Mesma proteção das demais suítes de escrita: nunca contra banco hospedado.
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

beforeAll(async () => {
  if (localDatabase) await cleanup();
}, 60_000);
afterEach(() => {
  fake.variants = [];
  fake.failuresLeft = 0;
  notifier.calls = [];
  notifier.mode = 'ok';
});
afterAll(async () => {
  if (localDatabase) await cleanup();
  await prisma.$disconnect();
}, 60_000);

localDescribe('Shopify → ClosetAdmin → vitrine: sincronização automática pelos webhooks de produto', () => {
  test('1) produto NOVO na Shopify: ClosetAdmin o enxerga sem cadastro; nenhuma peça física nasce; vitrine é avisada; reserva é impossível', async () => {
    const number = newNumber();
    const v = shopifyVariant(number, 0, `SKU-NOVO-${RUN}`);
    fake.variants = [v];

    const res = await productWebhook('products/create', number);
    expect(res.outcome).toBe('processed');

    const entry = (await catalog.list()).find((e) => e.id === v.id)!;
    expect([entry.sku, entry.skuStatus, entry.physicalUnitsTotal, entry.physicalUnitsReservableOnline]).toEqual([`SKU-NOVO-${RUN}`, 'synced', 0, 0]);
    // estoque 3 na Shopify NÃO vira peça física
    expect(await unitsOf(v.id)).toHaveLength(0);
    // a vitrine recebe o aviso, com o handle do produto
    expect(notifier.calls).toEqual([`jaqueta-${number}`]);
    // estado público: nem reservável nem "cadastrada" → a vitrine mostra como indisponível, e só isso
    const state = await publicState();
    expect(state.variantIds).not.toContain(v.id);
    expect(state.registeredVariantIds).not.toContain(v.id);
    // 14) reservar peça inexistente é impossível: disponibilidade 404 e hold recusado, nada gravado
    await expect(availability.getAvailability({ shopifyVariantId: v.id, countedPieces: 1, from: pickupISO(), to: pickupISO() })).rejects.toMatchObject({ status: 404 });
    await expect(holds.createHold({ items: [{ shopifyVariantId: v.id, quantity: 1 }], pickupDate: pickupISO(), termsAccepted: true })).rejects.toBeInstanceOf(HttpException);
    expect(await prisma.reservationItem.count({ where: { rentalUnit: { shopifyVariantId: v.id } } })).toBe(0);
  });

  test('2) inventário físico configurado depois: variante passa a reservável e a "cadastrada"; peça inativa fica cadastrada mas não reservável', async () => {
    const number = newNumber();
    const v = shopifyVariant(number, 0, `SKU-A-${RUN}`);
    fake.variants = [v];
    const piece = await registerUnit(v, `${number}-a`);

    let state = await publicState();
    expect(state.variantIds).toContain(v.id);
    expect(state.registeredVariantIds).toContain(v.id);
    expect((await catalog.list()).find((e) => e.id === v.id)).toMatchObject({ physicalUnitsTotal: 1, physicalUnitsReservableOnline: 1 });

    await prisma.rentalUnit.update({ where: { id: piece.id }, data: { active: false } });
    state = await publicState();
    expect(state.variantIds).not.toContain(v.id);
    expect(state.registeredVariantIds).toContain(v.id); // já teve peça: a vitrine NÃO o trata como "novo, aguardando inventário"
  });

  test('3) produto/preço editado: nada muda nas peças nem nas reservas (título e preço vêm direto da Shopify); vitrine é avisada', async () => {
    const number = newNumber();
    const v = shopifyVariant(number, 0, `SKU-E-${RUN}`);
    fake.variants = [v];
    const piece = await registerUnit(v, `${number}-e`, { code: v.sku as string }); // código = SKU: a sincronização não renomeia nada
    const reservationId = await futureReservation(piece.id);
    const before = { unit: await unit(piece.id), reservation: await reservationSnapshot(reservationId) };

    // título e descrição mudam na Shopify (o preço mora na variante da Storefront API, que a vitrine lê direto)
    fake.variants = [{ ...v, product: { ...v.product, title: 'Jaqueta Firenze — nova coleção' } }];
    const res = await productWebhook('products/update', number, { title: 'Jaqueta Firenze — nova coleção', variants: [{ id: 1, price: '199.90' }] });

    expect(res.outcome).toBe('processed');
    expect(await unit(piece.id)).toMatchObject({ code: before.unit.code, active: true, reservableOnline: true, shopifyVariantId: v.id, shopifySku: before.unit.shopifySku });
    expect(await reservationSnapshot(reservationId)).toEqual(before.reservation);
    expect(notifier.calls).toEqual([`jaqueta-${number}`]);
  });

  test('4) SKU alterado na Shopify: a peça acompanha pelo ID da variante, sem perder a reserva nem o histórico', async () => {
    const number = newNumber();
    const v = shopifyVariant(number, 0, `SKU-ANTIGO-${RUN}`);
    fake.variants = [v];
    const piece = await registerUnit(v, `${number}-s`);
    const reservationId = await futureReservation(piece.id);
    const before = await reservationSnapshot(reservationId);

    fake.variants = [{ ...v, sku: `SKU-NOVO-${RUN}` }];
    await productWebhook('products/update', number);

    expect(await unit(piece.id)).toMatchObject({ id: piece.id, shopifyVariantId: v.id, shopifySku: `SKU-NOVO-${RUN}`, active: true });
    expect(await reservationSnapshot(reservationId)).toEqual(before);
    expect(await prisma.rentalUnit.count({ where: { shopifyVariantId: v.id } })).toBe(1); // nenhuma peça duplicada
  });

  test('5) variante ADICIONADA (novo tamanho): aparece no ClosetAdmin sem peça; nada é criado sozinho; a variante antiga continua reservável', async () => {
    const number = newNumber();
    const p = shopifyVariant(number, 0, `SKU-P-${RUN}`);
    fake.variants = [p];
    await registerUnit(p, `${number}-p`);

    const g = shopifyVariant(number, 1, `SKU-G-${RUN}`);
    fake.variants = [p, g];
    await productWebhook('products/update', number);

    const listing = await catalog.list();
    expect(listing.find((e) => e.id === g.id)).toMatchObject({ sku: `SKU-G-${RUN}`, physicalUnitsTotal: 0 });
    expect(await unitsOf(g.id)).toHaveLength(0);
    const state = await publicState();
    expect(state.variantIds).toContain(p.id);
    expect(state.variantIds).not.toContain(g.id);
    expect(state.registeredVariantIds).not.toContain(g.id);
  });

  test('6) variante REMOVIDA: a peça é arquivada (nunca apagada), a reserva existente fica intacta e a variante some da lista reservável', async () => {
    const number = newNumber();
    const p = shopifyVariant(number, 0, `SKU-RP-${RUN}`);
    const g = shopifyVariant(number, 1, `SKU-RG-${RUN}`);
    fake.variants = [p, g];
    const pieceP = await registerUnit(p, `${number}-rp`);
    const pieceG = await registerUnit(g, `${number}-rg`);
    const reservationId = await futureReservation(pieceG.id);
    const before = await reservationSnapshot(reservationId);

    fake.variants = [p]; // G excluída na Shopify
    await productWebhook('products/update', number);

    expect(await unit(pieceG.id)).toMatchObject({ active: false });
    expect((await unit(pieceG.id)).shopifyVariantMissingAt).not.toBeNull();
    expect(await unit(pieceP.id)).toMatchObject({ active: true });
    expect(await reservationSnapshot(reservationId)).toEqual(before);
    const state = await publicState();
    expect(state.variantIds).toContain(p.id);
    expect(state.variantIds).not.toContain(g.id);
  });

  test('7) produto DESPUBLICADO/rascunho na Shopify: peças saem de operação, reserva existente intacta, nada apagado', async () => {
    const number = newNumber();
    const v = shopifyVariant(number, 0, `SKU-D-${RUN}`);
    fake.variants = [v];
    const piece = await registerUnit(v, `${number}-d`);
    const reservationId = await futureReservation(piece.id);
    const before = await reservationSnapshot(reservationId);

    fake.variants = [{ ...v, product: { ...v.product, status: 'DRAFT' } }];
    await productWebhook('products/update', number, { status: 'draft' });

    expect(await unit(piece.id)).toMatchObject({ active: false });
    expect(await reservationSnapshot(reservationId)).toEqual(before);
    expect((await publicState()).variantIds).not.toContain(v.id);
    expect(await prisma.rentalUnit.count({ where: { id: piece.id } })).toBe(1);

    // republicado (ACTIVE de novo): a peça pode ser reativada pelo fluxo seguro, sem duplicar
    fake.variants = [v];
    await productWebhook('products/update', number, { status: 'active' });
    expect(await prisma.rentalUnit.count({ where: { shopifyVariantId: v.id } })).toBe(1);
  });

  test('8) produto com peça física disponível aparece reservável e a disponibilidade responde com a peça', async () => {
    const number = newNumber();
    const v = shopifyVariant(number, 0, `SKU-OK-${RUN}`);
    fake.variants = [v];
    await registerUnit(v, `${number}-ok`);
    await productWebhook('products/create', number);

    expect((await publicState()).variantIds).toContain(v.id);
    const res = await availability.getAvailability({ shopifyVariantId: v.id, countedPieces: 1, from: civilDateToISO(today(DEFAULT_RENTAL_RULE_CONFIG)), to: civilDateToISO(addDays(today(DEFAULT_RENTAL_RULE_CONFIG), 5)) });
    expect(res.unitsTotal).toBe(1);
  });

  test('9) webhook DUPLICADO (mesmo id): processado uma vez; a vitrine é avisada uma vez; entrega nova do mesmo produto é idempotente', async () => {
    const number = newNumber();
    const v = shopifyVariant(number, 0, `SKU-DUP-${RUN}`);
    fake.variants = [v];
    const piece = await registerUnit(v, `${number}-dup`);
    const id = nextWebhookId();

    const first = await productWebhook('products/update', number, {}, id);
    const again = await productWebhook('products/update', number, {}, id);
    const other = await productWebhook('products/update', number);

    expect([first.outcome, again.outcome, other.outcome]).toEqual(['processed', 'duplicate', 'processed']);
    expect(await prisma.webhookEvent.count({ where: { shopifyWebhookId: id } })).toBe(1);
    expect(notifier.calls).toHaveLength(2); // o duplicado não avisa de novo
    expect(await prisma.rentalUnit.count({ where: { shopifyVariantId: v.id } })).toBe(1);
    expect((await unit(piece.id)).active).toBe(true);
  });

  test('10) eventos FORA DE ORDEM: vale sempre o estado atual da Shopify, nunca o corpo do evento atrasado', async () => {
    const number = newNumber();
    const v = shopifyVariant(number, 0, `SKU-V1-${RUN}`);
    fake.variants = [v];
    const piece = await registerUnit(v, `${number}-ord`);

    fake.variants = [{ ...v, sku: `SKU-V2-${RUN}` }]; // estado atual: v2
    // chega primeiro o evento da edição mais nova, depois o da mais velha (corpo com SKU antigo/forjado)
    await productWebhook('products/update', number, { variants: [{ id: 1, sku: `SKU-V2-${RUN}` }], updated_at: '2030-02-01T00:00:00Z' });
    await productWebhook('products/update', number, { variants: [{ id: 1, sku: `SKU-V1-${RUN}` }], updated_at: '2030-01-01T00:00:00Z' });

    expect(await unit(piece.id)).toMatchObject({ shopifySku: `SKU-V2-${RUN}`, active: true });
  });

  test('11) falha TEMPORÁRIA da Shopify: 503 para a Shopify reenviar, nada muda, vitrine não é avisada; o reenvio conclui', async () => {
    const number = newNumber();
    const v = shopifyVariant(number, 0, `SKU-F1-${RUN}`);
    fake.variants = [v];
    const piece = await registerUnit(v, `${number}-fail`);
    const reservationId = await futureReservation(piece.id);
    const before = await reservationSnapshot(reservationId);
    fake.variants = [{ ...v, sku: `SKU-F2-${RUN}` }];
    fake.failuresLeft = 1;
    const id = nextWebhookId();

    await expect(productWebhook('products/update', number, {}, id)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(await unit(piece.id)).toMatchObject({ shopifySku: `SKU-F1-${RUN}`, active: true });
    expect(await reservationSnapshot(reservationId)).toEqual(before);
    expect(notifier.calls).toEqual([]);
    expect((await prisma.webhookEvent.findMany({ where: { shopifyWebhookId: id } }))[0]?.status).toBe('failed');

    const retry = await productWebhook('products/update', number, {}, id);
    expect(retry.outcome).toBe('processed');
    expect(await unit(piece.id)).toMatchObject({ shopifySku: `SKU-F2-${RUN}` });
    expect(notifier.calls).toHaveLength(1);
  });

  test('12) vitrine fora do ar não quebra o webhook: o aviso falha em silêncio e o evento continua processado', async () => {
    const number = newNumber();
    const v = shopifyVariant(number, 0, `SKU-W-${RUN}`);
    fake.variants = [v];
    await registerUnit(v, `${number}-w`);
    notifier.mode = 'reject';
    const id = nextWebhookId();

    const res = await productWebhook('products/update', number, {}, id);

    expect(res.outcome).toBe('processed');
    expect((await prisma.webhookEvent.findMany({ where: { shopifyWebhookId: id } }))[0]?.status).toBe('processed');
  });

  test('14) bloqueio no BACKEND quando não há peça física reservável: peça inativa (404) e peça só "loja" (422) recusam disponibilidade e hold; estoque da Shopify não muda isso', async () => {
    const number = newNumber();
    const inactive = shopifyVariant(number, 0, `SKU-IN-${RUN}`, { inventoryQuantity: 200 });
    const storeOnly = shopifyVariant(number, 1, `SKU-LJ-${RUN}`, { inventoryQuantity: 200 });
    fake.variants = [inactive, storeOnly];
    await registerUnit(inactive, `${number}-in`, { active: false });
    await registerUnit(storeOnly, `${number}-lj`, { reservableOnline: false });
    const range = { from: pickupISO(), to: pickupISO() };

    await expect(availability.getAvailability({ shopifyVariantId: inactive.id, countedPieces: 1, ...range })).rejects.toMatchObject({ status: 404 });
    await expect(availability.getAvailability({ shopifyVariantId: storeOnly.id, countedPieces: 1, ...range })).rejects.toMatchObject({ status: 422 });
    for (const v of [inactive, storeOnly]) {
      await expect(holds.createHold({ items: [{ shopifyVariantId: v.id, quantity: 1 }], pickupDate: pickupISO(), termsAccepted: true })).rejects.toBeInstanceOf(HttpException);
      expect(await prisma.reservationItem.count({ where: { rentalUnit: { shopifyVariantId: v.id } } })).toBe(0);
    }
    const state = await publicState();
    expect(state.variantIds).not.toContain(inactive.id);
    expect(state.variantIds).not.toContain(storeOnly.id);
    // o painel continua mostrando o estoque da Shopify como informação, sem torná-lo reservável
    const entry = (await catalog.list()).find((e) => e.id === inactive.id)!;
    expect([entry.inventoryQuantity, entry.physicalUnitsReservableOnline]).toEqual([200, 0]);
  });

  test('13) webhooks que NÃO são de produto (pedido/pagamento) não disparam aviso de catálogo', async () => {
    await webhooks.handleIncoming({ topic: 'orders/updated', shopifyWebhookId: nextWebhookId(), payload: { id: 1, financial_status: 'pending' } });
    expect(notifier.calls).toEqual([]);
  });
});
