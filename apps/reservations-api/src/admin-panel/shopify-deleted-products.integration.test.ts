import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, civilDateToISO } from '../rental-rules/civil-date';
import { today } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';
import { ValePassWebhookService } from '../vale-pass/vale-pass-webhook.service';
import { ShopifyOrderSyncService } from '../webhooks/shopify-order-sync.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { WebhooksController } from '../webhooks/webhooks.controller';
import { AvailabilityController } from '../availability/availability.controller';
import type { AvailabilityService } from '../availability/availability.service';
import type { ShopifyAdminClient, ShopifyCatalogVariant } from './shopify-admin.client';
import { ShopifyCatalogSyncService } from './shopify-catalog-sync.service';
import { AdminPiecesService } from './pieces.service';

/**
 * Produto/variante EXCLUÍDO da Shopify → ClosetAdmin. Postgres de TESTE real,
 * Shopify simulada (nenhuma chamada de rede). Chaves: shopifyProductId e
 * shopifyVariantId — nunca o nome.
 *
 * Regra: a peça NUNCA é apagada. Excluída, em rascunho ou arquivada na
 * Shopify → arquivada (inativa, marcador da sincronização, SKU desvinculado):
 * fora das Peças ativas, da disponibilidade, do catálogo público e de novas
 * reservas, com reservas, bloqueios, histórico e auditoria preservados. Se a
 * variante voltar a ACTIVE, a mesma peça é reativada pelo fluxo existente.
 *
 * Reconciliações diretas são escopadas às peças da fixture (`rentalUnitIds`)
 * e o webhook ao produto da fixture — nunca varre peças alheias.
 */
const prisma = new PrismaService();
const RUN = Date.now();
const PREFIX = `del-sync-${RUN}`;
const WEBHOOK_PREFIX = `del-sync-wh-${RUN}`;
const PHONE_TAG = `7${RUN}`;
const SECRET = 'del-sync-test-webhook-secret';
const originalSecret = process.env.SHOPIFY_CLIENT_SECRET;

/** `getVariant` = consulta da própria variante. Por padrão falha (sem
 *  confirmação); `confirmDeletions` faz a Shopify responder como a real:
 *  a variante existe se estiver no catálogo (ou em `hiddenFromList`). */
class FakeShopifyAdminClient {
  variants: ShopifyCatalogVariant[] = [];
  hiddenFromList: ShopifyCatalogVariant[] = [];
  confirmDeletions = false;
  async listVariants(): Promise<ShopifyCatalogVariant[]> {
    return this.variants;
  }
  async getVariant(id: string): Promise<ShopifyCatalogVariant | null> {
    if (!this.confirmDeletions) throw new ServiceUnavailableException('Shopify indisponível (simulado).');
    return [...this.variants, ...this.hiddenFromList].find((v) => v.id === id) ?? null;
  }
}

const fake = new FakeShopifyAdminClient();
const sync = new ShopifyCatalogSyncService(prisma, fake as unknown as ShopifyAdminClient);
const pieces = new AdminPiecesService(prisma);
const availability = new AvailabilityController({} as AvailabilityService, prisma);
const webhooks = new WebhooksService(prisma, new ValePassWebhookService(), new ShopifyOrderSyncService(), sync);
const controller = new WebhooksController(webhooks);

let counter = 0;
let blockOwnerId: string;
const UNRELATED = () => [variant(`gid://shopify/ProductVariant/viva-${counter++}`, 'gid://shopify/Product/viva')];

function variant(id: string, productId: string, status = 'ACTIVE', sku: string | null = null): ShopifyCatalogVariant {
  return {
    id,
    title: 'Default Title',
    sku,
    inventoryQuantity: 1,
    imageUrl: null,
    imageAlt: null,
    selectedOptions: [],
    product: { id: productId, title: 'Produto', handle: 'produto', productType: '', status },
  };
}

/** Produto com N variantes, uma peça física por variante (nome livre — só rótulo). */
async function product(names: readonly string[]) {
  const number = `${RUN}${String(counter++).padStart(3, '0')}`;
  const productId = `gid://shopify/Product/${number}`;
  const units = [];
  for (let i = 0; i < names.length; i++) {
    units.push(
      await prisma.rentalUnit.create({
        data: {
          code: `${PREFIX}-${number}-${i}`,
          name: names[i],
          shopifyProductId: productId,
          shopifyVariantId: `gid://shopify/ProductVariant/${number}${i}`,
          shopifySku: `SKU-${number}-${i}`,
          active: true,
          reservableOnline: true,
          countsTowardRentalDuration: true,
        },
      }),
    );
    await prisma.adminAuditEvent.create({
      data: { adminUserName: 'fixture', action: 'SHOPIFY_UNITS_IMPORTED', entityType: 'RentalUnit', entityId: units[i].id, detail: { note: 'histórico da fixture' } },
    });
  }
  return { number, productId, units };
}

/** A variante "viva" na Shopify tem o mesmo SKU da peça (estes cenários não são de troca de SKU). */
const liveVariants = (units: readonly { shopifyVariantId: string | null; shopifyProductId: string | null; shopifySku: string | null }[], status = 'ACTIVE') =>
  units.map((u) => variant(u.shopifyVariantId!, u.shopifyProductId!, status, u.shopifySku));
const reconcile = (unitIds: readonly string[]) => sync.reconcile({ apply: true, rentalUnitIds: unitIds });
const unit = (id: string) => prisma.rentalUnit.findUniqueOrThrow({ where: { id } });
const audits = (id: string, action?: string) => prisma.adminAuditEvent.findMany({ where: { entityId: id, ...(action ? { action } : {}) } });
const nextWebhookId = () => `${WEBHOOK_PREFIX}-${counter++}`;
const deleteWebhook = (number: string, webhookId = nextWebhookId()) =>
  webhooks.handleIncoming({ topic: 'products/delete', shopifyWebhookId: webhookId, payload: { id: Number(number) } });

/** Arquivada pela sincronização: existe, inativa, com marcador, SKU desvinculado e o MESMO vínculo. */
async function expectArchived(u: { id: string; code: string; shopifyVariantId: string | null; shopifyProductId: string | null }) {
  const row = await unit(u.id);
  expect(row).toMatchObject({ active: false, shopifySku: null, code: u.code, shopifyVariantId: u.shopifyVariantId, shopifyProductId: u.shopifyProductId });
  expect(row.shopifyVariantMissingAt).not.toBeNull();
}

async function reservationFor(unitId: string, status: 'confirmed' | 'cancelled' | 'returned' = 'confirmed', daysAhead = 80) {
  const pickup = addDays(today(DEFAULT_RENTAL_RULE_CONFIG), daysAhead + counter++);
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservations (id, status, source, origin_store_id, pickup_date, return_date, terms_accepted_at, terms_version)
    VALUES (gen_random_uuid(), ${status}::"reservation_status", 'manual_admin', 'dev-store', ${civilDateToISO(pickup)}::date, ${civilDateToISO(addDays(pickup, 2))}::date, now(), 'test')
    RETURNING id
  `;
  await prisma.$executeRaw`
    INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
    VALUES (gen_random_uuid(), ${row.id}::uuid, ${unitId}::uuid, ${status}::"reservation_status",
            daterange(${civilDateToISO(addDays(pickup, -3))}::date, ${civilDateToISO(addDays(pickup, 5))}::date, '[)'))
  `;
  await prisma.reservationEvent.create({ data: { reservationId: row.id, type: 'MANUAL_NOTE', detail: { note: 'histórico da fixture' } } });
  return row.id;
}

async function snapshotReservation(id: string) {
  const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id }, include: { items: true } });
  const events = await prisma.reservationEvent.findMany({ where: { reservationId: id }, orderBy: { createdAt: 'asc' } });
  return { status: reservation.status, items: reservation.items.map((i) => ({ id: i.id, unit: i.rentalUnitId, status: i.status })), events: events.map((e) => e.id) };
}

async function cleanup() {
  const units = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
  const unitIds = units.map((u) => u.id);
  if (unitIds.length) {
    const reservations = await prisma.$queryRaw<{ id: string }[]>`SELECT DISTINCT reservation_id AS id FROM reservation_items WHERE rental_unit_id = ANY(${unitIds}::uuid[])`;
    const reservationIds = reservations.map((r) => r.id);
    if (reservationIds.length) {
      await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
      await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
      await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${reservationIds}::uuid[])`;
    }
    await prisma.$executeRaw`DELETE FROM operational_blocks WHERE rental_unit_id = ANY(${unitIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE entity_id = ANY(${unitIds})`;
    await prisma.$executeRaw`DELETE FROM rental_units WHERE id = ANY(${unitIds}::uuid[])`;
  }
  const events = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM webhook_events WHERE shopify_webhook_id LIKE ${WEBHOOK_PREFIX + '%'}`;
  if (events.length) {
    await prisma.$executeRaw`DELETE FROM reservation_events WHERE webhook_event_id = ANY(${events.map((e) => e.id)}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM webhook_events WHERE shopify_webhook_id LIKE ${WEBHOOK_PREFIX + '%'}`;
  }
  await prisma.$executeRaw`DELETE FROM operational_blocks WHERE created_by_admin_user_id IN (SELECT id FROM admin_users WHERE phone LIKE ${PHONE_TAG + '%'})`;
  await prisma.$executeRaw`DELETE FROM admin_users WHERE phone LIKE ${PHONE_TAG + '%'}`;
}

beforeAll(async () => {
  process.env.SHOPIFY_CLIENT_SECRET = SECRET;
  await cleanup();
  const owner = await prisma.adminUser.create({ data: { name: 'Dono de bloqueio (teste)', phone: `${PHONE_TAG}0`, pinHash: 'x', role: 'ADMIN', active: true } });
  blockOwnerId = owner.id;
});
afterEach(() => {
  fake.variants = [];
  fake.hiddenFromList = [];
  fake.confirmDeletions = false;
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  if (originalSecret === undefined) delete process.env.SHOPIFY_CLIENT_SECRET;
  else process.env.SHOPIFY_CLIENT_SECRET = originalSecret;
});

describe('Produto/variante excluído da Shopify → arquivado no ClosetAdmin, nunca apagado (Postgres de teste, Shopify simulada)', () => {
  test('1) exclusão de produto (products/delete): todas as peças do produto são arquivadas e auditadas', async () => {
    const { number, units } = await product(['Casaco A', 'Casaco B']);
    fake.variants = UNRELATED();

    const res = await deleteWebhook(number);

    expect(res.outcome).toBe('processed');
    for (const u of units) {
      await expectArchived(u);
      const [archive] = await audits(u.id, 'CATALOG_UNIT_DEACTIVATED');
      expect(archive).toMatchObject({ adminUserName: 'Sistema (sincronização de catálogo)', before: { active: true, shopifySku: u.shopifySku }, after: { active: false, shopifySku: null, archived: true } });
      expect(archive.detail).toMatchObject({ origin: 'shopify_catalog_sync', reason: 'shopify_variant_missing', shopifyVariantId: u.shopifyVariantId });
      expect(JSON.stringify(archive)).not.toMatch(/token|secret|password/i);
    }
  });

  test('2) exclusão de UMA variante (products/update): só a peça daquela variante é arquivada; a irmã continua ativa', async () => {
    const { number, units: [gone, kept] } = await product(['Blazer P', 'Blazer G']);
    fake.variants = liveVariants([kept]);

    await webhooks.handleIncoming({ topic: 'products/update', shopifyWebhookId: nextWebhookId(), payload: { id: Number(number) } });

    await expectArchived(gone);
    expect(await unit(kept.id)).toMatchObject({ active: true, shopifyVariantMissingAt: null, shopifySku: kept.shopifySku });
  });

  test('3) produto ARQUIVADO na Shopify: peça arquivada, vai para "Peças arquivadas"', async () => {
    const { units: [piece] } = await product(['Vestido']);
    fake.variants = liveVariants([piece], 'ARCHIVED');

    const report = await reconcile([piece.id]);

    expect(report.divergences.map((d) => [d.kind, d.applied])).toEqual([['product_inactive', true]]);
    await expectArchived(piece);
    expect((await pieces.list({ archived: true })).map((p) => p.id)).toContain(piece.id);
    expect((await pieces.list()).map((p) => p.id)).not.toContain(piece.id);
  });

  test('4) variante removida, produto mantido, peça COM bloqueio: arquivada, bloqueio intacto', async () => {
    const { number, units: [gone, kept] } = await product(['Bota 37', 'Bota 38']);
    const block = await prisma.operationalBlock.create({
      data: { scope: 'UNIT', rentalUnitId: gone.id, startDate: new Date('2027-03-01'), endDate: new Date('2027-03-02'), reason: `${PREFIX} manutenção`, createdByAdminUserId: blockOwnerId },
    });
    fake.variants = liveVariants([kept]);

    await webhooks.handleIncoming({ topic: 'products/update', shopifyWebhookId: nextWebhookId(), payload: { id: Number(number) } });

    await expectArchived(gone);
    expect(await prisma.operationalBlock.findUniqueOrThrow({ where: { id: block.id } })).toMatchObject({ rentalUnitId: gone.id, active: true, removedAt: null });
    expect(await unit(kept.id)).toMatchObject({ active: true });
  });

  test('5) item SEM reservas também só é arquivado — nunca apagado — e nada além dele muda', async () => {
    const { units: [piece] } = await product(['Cachecol']);
    const { units: [bystander] } = await product(['Luva']);
    fake.variants = liveVariants([bystander]);

    await reconcile([piece.id, bystander.id]);

    await expectArchived(piece);
    expect(await unit(bystander.id)).toMatchObject({ active: true, shopifyVariantMissingAt: null });
  });

  test('6) item com reservas (inclusive cancelada) é arquivado; reservas intactas, só um alerta de revisão se soma', async () => {
    const { units: [piece] } = await product(['Sobretudo Camelo']);
    const future = await reservationFor(piece.id, 'confirmed');
    const cancelled = await reservationFor(piece.id, 'cancelled', 120);
    const before = [await snapshotReservation(future), await snapshotReservation(cancelled)];
    fake.variants = UNRELATED();

    const report = await reconcile([piece.id]);

    expect(report.divergences[0]).toMatchObject({ kind: 'variant_missing', applied: true, upcomingReservations: 1 });
    await expectArchived(piece);
    const after = [await snapshotReservation(future), await snapshotReservation(cancelled)];
    expect(after[0].status).toBe(before[0].status);
    expect(after[0].items).toEqual(before[0].items);
    expect(after[0].events.slice(0, before[0].events.length)).toEqual(before[0].events);
    expect(after[1]).toEqual(before[1]);
  });

  test('7) histórico e auditoria preservados: nada some, só o arquivamento se soma', async () => {
    const { units: [piece] } = await product(['Chapéu']);
    fake.variants = UNRELATED();
    const before = await audits(piece.id);

    await reconcile([piece.id]);

    const after = await audits(piece.id);
    expect(after.map((a) => a.id)).toEqual(expect.arrayContaining(before.map((a) => a.id)));
    expect(after.map((a) => a.action).sort()).toEqual(['CATALOG_UNIT_DEACTIVATED', 'SHOPIFY_UNITS_IMPORTED']);
  });

  test('8) sai da disponibilidade, do catálogo público, da lista operacional e de novas reservas', async () => {
    const { units: [withHistory] } = await product(['Jaqueta']);
    await reservationFor(withHistory.id, 'returned', 10);
    const { units: [noHistory] } = await product(['Gorro']);
    const { units: [live] } = await product(['Casaco vivo']);
    fake.variants = liveVariants([live]);

    const before = (await availability.getCatalogVariants()).variantIds;
    expect(before).toEqual(expect.arrayContaining([withHistory.shopifyVariantId, noHistory.shopifyVariantId, live.shopifyVariantId]));

    await reconcile([withHistory.id, noHistory.id, live.id]);

    const publicIds = (await availability.getCatalogVariants()).variantIds;
    const operational = (await pieces.list()).map((p) => p.id);
    const archived = (await pieces.list({ archived: true })).map((p) => p.id);
    for (const u of [withHistory, noHistory]) {
      expect(publicIds).not.toContain(u.shopifyVariantId);
      expect(operational).not.toContain(u.id);
      expect(archived).toContain(u.id);
      // HOLD/reserva manual: mesma condição de servidor (active=true) exclui a peça.
      expect(await prisma.rentalUnit.count({ where: { id: u.id, active: true } })).toBe(0);
    }
    expect(publicIds).toContain(live.shopifyVariantId);
  });

  test('9) webhook repetido é idempotente: um arquivamento, um evento, nenhum erro', async () => {
    const { number, units: [piece] } = await product(['Saia']);
    fake.variants = UNRELATED();
    const webhookId = nextWebhookId();

    const first = await deleteWebhook(number, webhookId);
    const again = await deleteWebhook(number, webhookId);
    const redelivery = await deleteWebhook(number);

    expect([first.outcome, again.outcome, redelivery.outcome]).toEqual(['processed', 'duplicate', 'processed']);
    await expectArchived(piece);
    expect(await audits(piece.id, 'CATALOG_UNIT_DEACTIVATED')).toHaveLength(1);
    expect(await prisma.rentalUnit.count({ where: { shopifyVariantId: piece.shopifyVariantId } })).toBe(1);
  });

  test('10) webhook inválido (assinatura errada, sem assinatura, outra loja) é rejeitado e não muda nada', async () => {
    const { number, units: [piece] } = await product(['Colete']);
    fake.variants = UNRELATED();
    const body = JSON.stringify({ id: Number(number) });
    const webhookId = nextWebhookId();
    const valid = createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('base64');
    const forged = createHmac('sha256', 'segredo-errado').update(Buffer.from(body, 'utf8')).digest('base64');

    for (const [hmac, shop] of [[forged, 'dev-store.myshopify.com'], [undefined, 'dev-store.myshopify.com'], [valid, 'outra-loja.myshopify.com']] as const) {
      await expect(controller.receive({ rawBody: Buffer.from(body) }, hmac, 'products/delete', webhookId, shop)).rejects.toBeInstanceOf(UnauthorizedException);
    }

    expect(await unit(piece.id)).toMatchObject({ active: true, shopifyVariantMissingAt: null, shopifySku: piece.shopifySku });
    expect(await prisma.webhookEvent.count({ where: { shopifyWebhookId: webhookId } })).toBe(0);
  });

  test('11) resposta vazia da Shopify não arquiva nem apaga nada (503 → Shopify reenvia)', async () => {
    const { number, units: [piece] } = await product(['Camisa']);
    fake.variants = [];

    await expect(deleteWebhook(number)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(reconcile([piece.id])).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(await unit(piece.id)).toMatchObject({ active: true, shopifyVariantMissingAt: null, shopifySku: piece.shopifySku });
    expect(await audits(piece.id, 'CATALOG_UNIT_DEACTIVATED')).toHaveLength(0);
  });

  test('12) reconciliação periódica corrige item removido sem webhook; relatório não escreve', async () => {
    const { units: [piece] } = await product(['Calça']);
    fake.variants = UNRELATED();

    const preview = await sync.reconcile({ apply: false, rentalUnitIds: [piece.id] });
    expect(preview.divergences).toEqual([expect.objectContaining({ kind: 'variant_missing', action: 'deactivate', applied: false })]);
    expect(await unit(piece.id)).toMatchObject({ active: true });

    await reconcile([piece.id]);
    await expectArchived(piece);
    expect((await reconcile([piece.id])).divergences).toHaveLength(0);
  });

  test('13) variante volta a ACTIVE: a MESMA peça é reativada, com SKU relido da Shopify', async () => {
    const { number, units: [piece] } = await product(['Blusa']);
    fake.variants = UNRELATED();
    await deleteWebhook(number);
    await expectArchived(piece);

    fake.variants = liveVariants([piece], 'ACTIVE').map((v) => ({ ...v, sku: 'SKU-DE-VOLTA' }));
    const report = await reconcile([piece.id]);

    expect(report.divergences.map((d) => [d.kind, d.applied])).toEqual([['variant_restored', true]]);
    expect(await unit(piece.id)).toMatchObject({ active: true, shopifyVariantMissingAt: null, shopifySku: 'SKU-DE-VOLTA', code: piece.code });
    expect(await prisma.rentalUnit.count({ where: { shopifyVariantId: piece.shopifyVariantId } })).toBe(1);
  });

  test('14) nenhum registro físico criado ou apagado', async () => {
    const { number, units: [gone] } = await product(['Casaco que some']);
    const { units: [live] } = await product(['Casaco que fica']);
    const { units: [manual] } = await product(['Peça desativada à mão']);
    await prisma.rentalUnit.update({ where: { id: manual.id }, data: { active: false } }); // decisão humana, sem marcador
    const newVariant = variant(`gid://shopify/ProductVariant/${RUN}nova`, `gid://shopify/Product/${RUN}nova`);
    fake.variants = [...liveVariants([live]), newVariant];
    const totalBefore = await prisma.rentalUnit.count();

    await deleteWebhook(number);
    await reconcile([gone.id, live.id, manual.id]);
    await reconcile([gone.id, live.id, manual.id]);

    expect(await prisma.rentalUnit.count()).toBe(totalBefore);
    await expectArchived(gone);
    expect(await unit(manual.id)).toMatchObject({ active: false, shopifyVariantMissingAt: null, shopifySku: manual.shopifySku });
    expect(await unit(live.id)).toMatchObject({ active: true });
    expect(await prisma.rentalUnit.count({ where: { shopifyVariantId: newVariant.id } })).toBe(0);
  });
});

describe('Peça desativada à mão + produto excluído da Shopify (caso do Sobretudo)', () => {
  async function manuallyInactive(name: string) {
    const created = await product([name]);
    const [u] = created.units;
    await prisma.rentalUnit.update({ where: { id: u.id }, data: { active: false } }); // decisão humana, sem marcador
    return { ...created, unit: u };
  }

  test('Shopify confirma a exclusão → vai para Peças arquivadas, continua inativa, nada é apagado', async () => {
    const { number, unit: piece } = await manuallyInactive('Sobretudo');
    const reservationId = await reservationFor(piece.id, 'returned', 5);
    const before = await snapshotReservation(reservationId);
    fake.variants = UNRELATED();
    fake.confirmDeletions = true;

    await deleteWebhook(number);

    await expectArchived(piece);
    expect((await pieces.list()).map((p) => p.id)).not.toContain(piece.id);
    expect((await pieces.list({ archived: true })).map((p) => p.id)).toContain(piece.id);
    const [archive] = await audits(piece.id, 'CATALOG_UNIT_DEACTIVATED');
    expect(archive).toMatchObject({ before: { active: false, shopifySku: piece.shopifySku }, after: { active: false, shopifySku: null, archived: true } });
    expect(archive.detail).toMatchObject({ reason: 'shopify_variant_deleted_confirmed', shopifyVariantId: piece.shopifyVariantId });
    expect(await snapshotReservation(reservationId)).toEqual(before);
  });

  test('repetido é idempotente: um arquivamento, um evento', async () => {
    const { number, unit: piece } = await manuallyInactive('Sobretudo');
    fake.variants = UNRELATED();
    fake.confirmDeletions = true;

    await deleteWebhook(number);
    await deleteWebhook(number);
    const rerun = await reconcile([piece.id]);

    expect(rerun.divergences).toHaveLength(0);
    expect(await audits(piece.id, 'CATALOG_UNIT_DEACTIVATED')).toHaveLength(1);
    await expectArchived(piece);
  });

  test('sem confirmação da Shopify (erro, ou a variante ainda existe fora da lista) → não mexe', async () => {
    const { unit: piece } = await manuallyInactive('Sobretudo');
    fake.variants = UNRELATED();

    await reconcile([piece.id]); // getVariant falha
    fake.confirmDeletions = true;
    fake.hiddenFromList = liveVariants([piece]); // lista incompleta: a variante existe
    const report = await reconcile([piece.id]);

    expect(report.divergences.map((d) => [d.kind, d.applied])).toEqual([['variant_deleted_inactive', false]]);
    expect(await unit(piece.id)).toMatchObject({ active: false, shopifyVariantMissingAt: null, shopifySku: piece.shopifySku });
    expect(await audits(piece.id, 'CATALOG_UNIT_DEACTIVATED')).toHaveLength(0);
  });

  test('produto só em RASCUNHO/ARQUIVADO na Shopify (pode voltar) → decisão manual respeitada, não mexe', async () => {
    const { unit: piece } = await manuallyInactive('Sobretudo');
    fake.variants = liveVariants([piece], 'DRAFT');
    fake.confirmDeletions = true;

    const report = await reconcile([piece.id]);

    expect(report.divergences).toHaveLength(0);
    expect(await unit(piece.id)).toMatchObject({ active: false, shopifyVariantMissingAt: null });
  });
});

describe('Validação: Blazer Kensington, teste e Sobretudo (recriados no banco de teste, fluxo real de webhook)', () => {
  test('excluídos da Shopify: todos arquivados, fora do operacional e do público, histórico intacto', async () => {
    // Mesmos nomes do painel; a chave é SEMPRE produto/variante, nunca o nome.
    const blazer = await product(['Blazer Kensington', 'Blazer Kensington']); // variante 0 excluída (com reserva); variante 1 continua
    await reservationFor(blazer.units[0].id, 'returned', 5);
    const teste = await product(['teste']); // produto excluído, sem nada
    const sobretudo = await product(['Sobretudo', 'Sobretudo']); // produto excluído; peça 0 com reserva, peça 1 sem
    const reservationId = await reservationFor(sobretudo.units[0].id, 'confirmed');
    const before = await snapshotReservation(reservationId);
    const totalBefore = await prisma.rentalUnit.count();
    fake.variants = liveVariants([blazer.units[1]]);

    await webhooks.handleIncoming({ topic: 'products/update', shopifyWebhookId: nextWebhookId(), payload: { id: Number(blazer.number) } });
    await deleteWebhook(teste.number);
    await deleteWebhook(sobretudo.number);

    const all = [...blazer.units, ...teste.units, ...sobretudo.units];
    const result = [];
    for (const u of all) {
      const row = await prisma.rentalUnit.findUnique({ where: { id: u.id } });
      result.push({ name: u.name, variant: u.shopifyVariantId!.split('/').pop(), estado: !row ? 'apagada' : row.active ? 'ativa' : 'arquivada' });
    }
    console.log('Resultado no banco de teste:', JSON.stringify(result));
    expect(result.map((r) => r.estado)).toEqual(['arquivada', 'ativa', 'arquivada', 'arquivada', 'arquivada']);
    expect(await prisma.rentalUnit.count()).toBe(totalBefore);

    const publicIds = (await availability.getCatalogVariants()).variantIds;
    const operational = (await pieces.list()).map((p) => p.id);
    const archived = (await pieces.list({ archived: true })).map((p) => p.id);
    for (const u of [blazer.units[0], ...teste.units, ...sobretudo.units]) {
      await expectArchived(u);
      expect(publicIds).not.toContain(u.shopifyVariantId);
      expect(operational).not.toContain(u.id);
      expect(archived).toContain(u.id);
    }
    const after = await snapshotReservation(reservationId);
    expect(after.items).toEqual(before.items);
    expect(after.status).toBe(before.status);
  }, 90_000); // três webhooks em série contra o Neon de teste
});
