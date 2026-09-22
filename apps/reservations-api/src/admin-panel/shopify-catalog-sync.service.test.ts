import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ensureStoreConfig, resolveStoreConfig } from '../holds/store-config';
import { addDays, civilDateToISO } from '../rental-rules/civil-date';
import { today } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';
import type { ShopifyAdminClient, ShopifyCatalogVariant } from './shopify-admin.client';
import { ShopifyCatalogSyncService } from './shopify-catalog-sync.service';

/**
 * Sincronização catálogo Shopify ↔ peça física — cenário do pedido (Blazer
 * Kensington: variante removida da Shopify, peça ainda ativa no banco).
 * `ShopifyAdminClient` é FALSO aqui — nenhuma chamada de rede.
 *
 * `reconcile()` varre `rental_units` inteira em produção; nos testes SEMPRE
 * passamos `rentalUnitIds` com só os ids da própria fixture — sem isso, um
 * teste rodando junto de outros arquivos (mesmo Postgres, workers em
 * paralelo) desativaria peças de fixtures alheias sempre que `fake.variants`
 * estivesse vazio. É a mesma razão de existir de `orderIds` em
 * ShopifyReconciliationService.
 */
const prisma = new PrismaService();
const PREFIX = `catalog-sync-${Date.now()}`;
const ACTOR = { id: '44444444-4444-4444-8444-444444444444', name: 'Admin sintético' };

class FakeShopifyAdminClient {
  variants: ShopifyCatalogVariant[] = [];
  async listVariants(): Promise<ShopifyCatalogVariant[]> {
    return this.variants;
  }
  async getVariant(): Promise<ShopifyCatalogVariant | null> {
    throw new Error('não usado nesta sincronização');
  }
}

const DECOY_VARIANT = 'gid://shopify/ProductVariant/decoy-nao-relacionada';

function variant(id: string, overrides: Partial<ShopifyCatalogVariant> = {}): ShopifyCatalogVariant {
  return {
    id,
    title: 'Default Title',
    sku: null,
    inventoryQuantity: null,
    imageUrl: null,
    imageAlt: null,
    selectedOptions: [],
    product: { id: `${id}-product`, title: 'Produto', handle: 'produto', productType: '', status: 'ACTIVE' },
    ...overrides,
  };
}

let unitCounter = 0;
async function createUnit(opts: { active?: boolean; shopifyVariantId?: string | null } = {}) {
  const code = `${PREFIX}-u${unitCounter++}`;
  return prisma.rentalUnit.create({
    data: {
      code,
      name: 'Blazer Kensington',
      shopifyProductId: `${code}-product`,
      shopifyVariantId: opts.shopifyVariantId === undefined ? `${code}-variant` : opts.shopifyVariantId,
      shopifySku: `${code}-sku`,
      active: opts.active ?? true,
      reservableOnline: true,
      countsTowardRentalDuration: true,
    },
  });
}

async function createFutureReservation(unitId: string) {
  const pickup = addDays(today(DEFAULT_RENTAL_RULE_CONFIG), 60 + unitCounter++);
  const blockedFrom = civilDateToISO(addDays(pickup, -3));
  const blockedUntil = civilDateToISO(addDays(pickup, 5));
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservations (id, status, source, origin_store_id, pickup_date, return_date, terms_accepted_at, terms_version)
    VALUES (gen_random_uuid(), 'confirmed', 'manual_admin', 'dev-store', ${civilDateToISO(pickup)}::date, ${civilDateToISO(addDays(pickup, 2))}::date, now(), 'test')
    RETURNING id
  `;
  await prisma.$executeRaw`
    INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
    VALUES (gen_random_uuid(), ${row.id}::uuid, ${unitId}::uuid, 'confirmed', daterange(${blockedFrom}::date, ${blockedUntil}::date, '[)'))
  `;
  return row.id;
}

async function unit(id: string) {
  return prisma.rentalUnit.findUniqueOrThrow({ where: { id } });
}
async function auditEvents(entityId: string, action: string) {
  return prisma.adminAuditEvent.findMany({ where: { entityId, action } });
}
async function reservationEvents(reservationId: string, type: string) {
  return prisma.reservationEvent.findMany({ where: { reservationId, type } });
}

async function cleanup() {
  const units = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
  const unitIds = units.map((u) => u.id);
  if (unitIds.length) {
    const reservations = await prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT reservation_id AS id FROM reservation_items WHERE rental_unit_id = ANY(${unitIds}::uuid[])
    `;
    const reservationIds = reservations.map((r) => r.id);
    if (reservationIds.length) {
      await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
      await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
      await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${reservationIds}::uuid[])`;
    }
    await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE entity_id = ANY(${unitIds})`;
    await prisma.$executeRaw`DELETE FROM rental_units WHERE id = ANY(${unitIds}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM catalog_sync_state WHERE id = 'default' AND last_synced_by = ${ACTOR.id}::uuid`;
  await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE admin_user_id = ${ACTOR.id}::uuid`;
}
async function cleanupActor() {
  await prisma.$executeRaw`DELETE FROM admin_users WHERE id = ${ACTOR.id}::uuid`;
}

describe('ShopifyCatalogSyncService (PostgreSQL isolado, Shopify simulada)', () => {
  let fake: FakeShopifyAdminClient;
  let service: ShopifyCatalogSyncService;
  let ids: string[];

  const reconcile = (opts: { apply: boolean; actor?: { id: string; name: string } }) =>
    service.reconcile({ ...opts, rentalUnitIds: ids });

  beforeAll(async () => {
    await cleanup();
    await ensureStoreConfig(prisma, resolveStoreConfig());
    // ACTOR precisa ser um AdminUser real — AdminAuditEvent.adminUserId tem FK.
    await prisma.adminUser.upsert({
      where: { id: ACTOR.id },
      create: { id: ACTOR.id, name: ACTOR.name, phone: `9${Date.now()}0`, pinHash: 'x:y', role: 'ADMIN', active: true },
      update: {},
    });
  });
  beforeEach(() => {
    fake = new FakeShopifyAdminClient();
    service = new ShopifyCatalogSyncService(prisma, fake as unknown as ShopifyAdminClient);
    ids = [];
  });
  afterAll(async () => {
    await cleanup();
    await cleanupActor();
    await prisma.$disconnect();
  }, 60_000);

  test('variante removida desativa a peça, bloqueia disponibilidade e audita com origem do sistema', async () => {
    const kensington = await createUnit();
    ids = [kensington.id];
    fake.variants = [variant(DECOY_VARIANT)]; // Shopify tem outras variantes — só ESTA peça está sem a sua

    const report = await reconcile({ apply: true, actor: ACTOR });

    expect(report.mode).toBe('apply');
    const row = await unit(kensington.id);
    expect(row.active).toBe(false);
    expect(row.shopifyVariantId).toBe(kensington.shopifyVariantId); // vínculo preservado, só invalidado
    expect(row.shopifyVariantMissingAt).not.toBeNull();

    const divergence = report.divergences.find((d) => d.rentalUnitId === kensington.id);
    expect(divergence).toMatchObject({ kind: 'variant_missing', action: 'deactivate', applied: true });

    const [audit] = await auditEvents(kensington.id, 'CATALOG_UNIT_DEACTIVATED');
    expect(audit).toBeTruthy();
    expect(audit.adminUserId).toBe(ACTOR.id);
    expect(audit.detail).toMatchObject({ origin: 'shopify_catalog_sync', reason: 'shopify_variant_missing', shopifyVariantId: kensington.shopifyVariantId });
    expect(JSON.stringify(audit)).not.toMatch(/token|secret|access_token/i);
  });

  test('variante existente permanece ativa, sem evento nenhum', async () => {
    const active = await createUnit();
    ids = [active.id];
    fake.variants = [variant(active.shopifyVariantId as string)];

    const report = await reconcile({ apply: true, actor: ACTOR });

    expect(report.divergences.find((d) => d.rentalUnitId === active.id)).toBeUndefined();
    const row = await unit(active.id);
    expect(row.active).toBe(true);
    expect(row.shopifyVariantMissingAt).toBeNull();
    expect(await auditEvents(active.id, 'CATALOG_UNIT_DEACTIVATED')).toHaveLength(0);
  });

  test('execução repetida é idempotente: uma única desativação e um único evento', async () => {
    const piece = await createUnit();
    ids = [piece.id];
    fake.variants = [variant(DECOY_VARIANT)]; // Shopify tem outras variantes — só ESTA peça está sem a sua

    await reconcile({ apply: true, actor: ACTOR });
    const second = await reconcile({ apply: true, actor: ACTOR });
    const third = await reconcile({ apply: true, actor: ACTOR });

    expect(second.divergences.find((d) => d.rentalUnitId === piece.id)).toBeUndefined();
    expect(third.divergences.find((d) => d.rentalUnitId === piece.id)).toBeUndefined();
    expect(await auditEvents(piece.id, 'CATALOG_UNIT_DEACTIVATED')).toHaveLength(1);
    const row = await unit(piece.id);
    expect(row.active).toBe(false);
  });

  test('variante restaurada pode ser reativada, sem duplicar a peça', async () => {
    const piece = await createUnit();
    ids = [piece.id];
    fake.variants = [variant(DECOY_VARIANT)]; // Shopify tem outras variantes — só ESTA peça está sem a sua
    await reconcile({ apply: true, actor: ACTOR });
    expect((await unit(piece.id)).active).toBe(false);

    fake.variants = [variant(piece.shopifyVariantId as string)];
    const report = await reconcile({ apply: true, actor: ACTOR });

    const row = await unit(piece.id);
    expect(row.active).toBe(true);
    expect(row.shopifyVariantMissingAt).toBeNull();
    expect(report.divergences.find((d) => d.rentalUnitId === piece.id)).toMatchObject({ kind: 'variant_restored', applied: true });
    expect(await auditEvents(piece.id, 'CATALOG_UNIT_REACTIVATED')).toHaveLength(1);
    expect(await prisma.rentalUnit.count({ where: { shopifyVariantId: piece.shopifyVariantId } })).toBe(1);
  });

  test('peça inativa por decisão manual (sem marcador) nunca é tocada pela sincronização', async () => {
    const manual = await createUnit({ active: false });
    ids = [manual.id];
    fake.variants = [variant(manual.shopifyVariantId as string)];

    const report = await reconcile({ apply: true, actor: ACTOR });

    expect(report.divergences.find((d) => d.rentalUnitId === manual.id)).toBeUndefined();
    const row = await unit(manual.id);
    expect(row.active).toBe(false);
    expect(row.shopifyVariantMissingAt).toBeNull();
  });

  test('reativação manual limpa o marcador; a peça não é duplicada ao voltar', async () => {
    const piece = await createUnit();
    ids = [piece.id];
    fake.variants = [variant(DECOY_VARIANT)]; // Shopify tem outras variantes — só ESTA peça está sem a sua
    await reconcile({ apply: true, actor: ACTOR });
    expect((await unit(piece.id)).shopifyVariantMissingAt).not.toBeNull();

    // Simula o PATCH manual do painel limpando o marcador (mesma regra de pieces.service.ts).
    await prisma.rentalUnit.update({ where: { id: piece.id }, data: { active: true, shopifyVariantMissingAt: null } });

    fake.variants = [variant(piece.shopifyVariantId as string)];
    const report = await reconcile({ apply: true, actor: ACTOR });
    expect(report.divergences.find((d) => d.rentalUnitId === piece.id)).toBeUndefined();
    expect(await prisma.rentalUnit.count({ where: { shopifyVariantId: piece.shopifyVariantId } })).toBe(1);
  });

  test('peça desativada não aparece como disponível (mesma condição de servidor de AvailabilityService/HoldsService)', async () => {
    const piece = await createUnit();
    ids = [piece.id];
    fake.variants = [variant(DECOY_VARIANT)]; // Shopify tem outras variantes — só ESTA peça está sem a sua
    await reconcile({ apply: true, actor: ACTOR });

    const found = await prisma.rentalUnit.findFirst({ where: { shopifyVariantId: piece.shopifyVariantId as string, active: true } });
    expect(found).toBeNull();
  });

  test('reserva futura gera alerta de auditoria, mas a reserva não é apagada nem alterada', async () => {
    const piece = await createUnit();
    ids = [piece.id];
    const reservationId = await createFutureReservation(piece.id);
    fake.variants = [variant(DECOY_VARIANT)]; // Shopify tem outras variantes — só ESTA peça está sem a sua

    await reconcile({ apply: true, actor: ACTOR });

    const [alert] = await reservationEvents(reservationId, 'SHOPIFY_CATALOG_UNIT_MISSING_RESERVATION_ALERT');
    expect(alert).toBeTruthy();
    expect(alert.detail).toMatchObject({ origin: 'shopify_catalog_sync', rentalUnitId: piece.id });
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    expect(reservation.status).toBe('confirmed');
    expect(await prisma.reservation.count({ where: { id: reservationId } })).toBe(1);

    // Reprocessar não duplica o alerta.
    await reconcile({ apply: true, actor: ACTOR });
    expect(await reservationEvents(reservationId, 'SHOPIFY_CATALOG_UNIT_MISSING_RESERVATION_ALERT')).toHaveLength(1);
  });

  test('nenhuma peça é duplicada: código único preservado ao longo de várias execuções', async () => {
    const piece = await createUnit();
    ids = [piece.id];
    fake.variants = [variant(DECOY_VARIANT)]; // Shopify tem outras variantes — só ESTA peça está sem a sua
    await reconcile({ apply: true, actor: ACTOR });
    fake.variants = [variant(piece.shopifyVariantId as string)];
    await reconcile({ apply: true, actor: ACTOR });
    fake.variants = [variant(DECOY_VARIANT)]; // Shopify tem outras variantes — só ESTA peça está sem a sua
    await reconcile({ apply: true, actor: ACTOR });

    expect(await prisma.rentalUnit.count({ where: { code: piece.code } })).toBe(1);
  });

  test('modo relatório nunca escreve: nenhuma peça muda, nenhum evento é criado', async () => {
    const piece = await createUnit();
    ids = [piece.id];
    fake.variants = [variant(DECOY_VARIANT)]; // Shopify tem outras variantes — só ESTA peça está sem a sua

    const report = await reconcile({ apply: false });

    expect(report.mode).toBe('report');
    expect(report.divergences.find((d) => d.rentalUnitId === piece.id)).toMatchObject({ action: 'deactivate', applied: false });
    const row = await unit(piece.id);
    expect(row.active).toBe(true);
    expect(row.shopifyVariantMissingAt).toBeNull();
    expect(await auditEvents(piece.id, 'CATALOG_UNIT_DEACTIVATED')).toHaveLength(0);
  });

  test('Shopify retornando 0 variantes com peças vinculadas aborta por segurança — nada é desativado', async () => {
    const a = await createUnit();
    const b = await createUnit();
    ids = [a.id, b.id];
    fake.variants = []; // catálogo inteiro vazio — o cenário que o guard existe para pegar

    await expect(reconcile({ apply: true, actor: ACTOR })).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect((await unit(a.id)).active).toBe(true);
    expect((await unit(b.id)).active).toBe(true);
  });

  test('produtos/variantes presentes na Shopify não geram divergência nenhuma', async () => {
    const linked = await createUnit();
    ids = [linked.id];
    fake.variants = [variant(linked.shopifyVariantId as string), variant('gid://shopify/ProductVariant/nao-cadastrada')];

    const report = await reconcile({ apply: false });

    expect(report.divergences).toHaveLength(0);
    expect(report.totalShopifyVariants).toBe(2);
  });

  test('permissões: GET reconciliação é STAFF-legível; POST sync exige ADMIN (verificado nos metadados do controller)', async () => {
    const { ShopifyCatalogSyncController } = await import('./shopify-catalog-sync.controller');
    const { REQUIRE_MODULE_KEY } = await import('../admin/require-module.decorator');
    const { REQUIRE_ROLE_KEY } = await import('../admin/require-role.decorator');
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, ShopifyCatalogSyncController)).toBe('PIECES');
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, ShopifyCatalogSyncController.prototype.sync)).toBe('ADMIN');
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, ShopifyCatalogSyncController.prototype.reconciliation)).toBeUndefined();
  });
});
