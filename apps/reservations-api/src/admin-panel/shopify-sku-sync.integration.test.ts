import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { ExecutionContext, ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AdminModule, AdminRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, civilDateToISO } from '../rental-rules/civil-date';
import { today } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';
import { ValePassWebhookService } from '../vale-pass/vale-pass-webhook.service';
import { ShopifyOrderSyncService } from '../webhooks/shopify-order-sync.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { WebhooksController } from '../webhooks/webhooks.controller';
import { hashPin } from '../admin/admin-pin';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { generateSessionToken, hashSessionToken } from '../admin/admin-session-token';
import type { ShopifyAdminClient, ShopifyCatalogVariant } from './shopify-admin.client';
import { ShopifyCatalogSyncService } from './shopify-catalog-sync.service';
import { ShopifyCatalogService } from './shopify-catalog.service';
import { ShopifyCatalogSyncController } from './shopify-catalog-sync.controller';

/**
 * SKU da Shopify → peça física, vinculado SEMPRE pelo `shopifyVariantId`.
 * Postgres de TESTE real; a Shopify é simulada (nenhuma chamada de rede).
 * O SKU aplicado vem da Admin API (a fake abaixo), nunca do corpo do webhook.
 *
 * Toda reconciliação direta é escopada às peças da própria fixture
 * (`rentalUnitIds`), e o caminho do webhook ao produto da fixture — nunca
 * varre peças alheias do banco de teste.
 */
const prisma = new PrismaService();
const RUN = Date.now();
/** SKU único por rodada: o código da peça passa a ser o SKU, e código é único no banco. */
const sku = (label: string) => `${label}-${RUN}`;
const PREFIX = `sku-sync-${RUN}`;
const WEBHOOK_PREFIX = `sku-sync-wh-${RUN}`;
const PHONE_TAG = `8${RUN}`;
const SECRET = 'sku-sync-test-webhook-secret';
const originalSecret = process.env.SHOPIFY_CLIENT_SECRET;

class FakeShopifyAdminClient {
  variants: ShopifyCatalogVariant[] = [];
  failuresLeft = 0;
  async listVariants(): Promise<ShopifyCatalogVariant[]> {
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new ServiceUnavailableException('Shopify Admin API indisponível (simulado).');
    }
    return this.variants;
  }
  async getVariant(): Promise<ShopifyCatalogVariant | null> {
    throw new Error('não usado nesta suíte');
  }
}

const fake = new FakeShopifyAdminClient();
const sync = new ShopifyCatalogSyncService(prisma, fake as unknown as ShopifyAdminClient);
const catalog = new ShopifyCatalogService(prisma, fake as unknown as ShopifyAdminClient);
const webhooks = new WebhooksService(prisma, new ValePassWebhookService(), new ShopifyOrderSyncService(), sync);
const controller = new WebhooksController(webhooks);

let counter = 0;
const productNumber = () => `${RUN}${String(counter++).padStart(3, '0')}`;

function variant(id: string, productId: string, sku: string | null, overrides: Partial<ShopifyCatalogVariant> = {}): ShopifyCatalogVariant {
  return {
    id,
    title: 'Default Title',
    sku,
    inventoryQuantity: 5,
    imageUrl: null,
    imageAlt: null,
    selectedOptions: [],
    product: { id: productId, title: 'Sobretudo', handle: 'sobretudo', productType: '', status: 'ACTIVE' },
    ...overrides,
  };
}

/** Produto com N variantes, cada uma com uma peça física vinculada. */
async function fixture(skus: readonly (string | null)[]) {
  const number = productNumber();
  const productId = `gid://shopify/Product/${number}`;
  const units = [];
  for (let i = 0; i < skus.length; i++) {
    units.push(
      await prisma.rentalUnit.create({
        data: {
          code: `${PREFIX}-${number}-${i}`,
          name: 'Sobretudo Preto',
          shopifyProductId: productId,
          shopifyVariantId: `gid://shopify/ProductVariant/${number}${i}`,
          shopifySku: skus[i],
          active: true,
          reservableOnline: true,
          countsTowardRentalDuration: true,
        },
      }),
    );
  }
  return { number, productId, units };
}

const reconcile = (unitIds: readonly string[]) => sync.reconcile({ apply: true, rentalUnitIds: unitIds });
const unit = (id: string) => prisma.rentalUnit.findUniqueOrThrow({ where: { id } });
const skuAudits = (id: string) =>
  prisma.adminAuditEvent.findMany({ where: { entityId: id, action: 'CATALOG_UNIT_SKU_SYNCED' }, orderBy: { createdAt: 'asc' } });
const nextWebhookId = () => `${WEBHOOK_PREFIX}-${counter++}`;

async function createFutureReservation(unitId: string) {
  const pickup = addDays(today(DEFAULT_RENTAL_RULE_CONFIG), 70 + counter++);
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO reservations (id, status, source, origin_store_id, pickup_date, return_date, terms_accepted_at, terms_version)
    VALUES (gen_random_uuid(), 'confirmed', 'manual_admin', 'dev-store', ${civilDateToISO(pickup)}::date, ${civilDateToISO(addDays(pickup, 2))}::date, now(), 'test')
    RETURNING id
  `;
  await prisma.$executeRaw`
    INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
    VALUES (gen_random_uuid(), ${row.id}::uuid, ${unitId}::uuid, 'confirmed',
            daterange(${civilDateToISO(addDays(pickup, -3))}::date, ${civilDateToISO(addDays(pickup, 5))}::date, '[)'))
  `;
  await prisma.reservationEvent.create({ data: { reservationId: row.id, type: 'MANUAL_NOTE', detail: { note: 'histórico da fixture' } } });
  return row.id;
}

async function snapshotReservation(id: string) {
  const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id }, include: { items: true } });
  const events = await prisma.reservationEvent.findMany({ where: { reservationId: id }, orderBy: { createdAt: 'asc' } });
  return {
    status: reservation.status,
    items: reservation.items.map((item) => ({ id: item.id, rentalUnitId: item.rentalUnitId, status: item.status })),
    events: events.map((event) => ({ id: event.id, type: event.type })),
  };
}

async function cleanup() {
  // Pelo produto também: a peça renomeada para o SKU não começa mais com PREFIX.
  const units = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM rental_units WHERE code LIKE ${PREFIX + '%'} OR shopify_product_id LIKE ${'gid://shopify/Product/' + RUN + '%'}
  `;
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
  const events = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM webhook_events WHERE shopify_webhook_id LIKE ${WEBHOOK_PREFIX + '%'}`;
  if (events.length) {
    await prisma.$executeRaw`DELETE FROM reservation_events WHERE webhook_event_id = ANY(${events.map((e) => e.id)}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM webhook_events WHERE shopify_webhook_id LIKE ${WEBHOOK_PREFIX + '%'}`;
  }
  await prisma.$executeRaw`DELETE FROM admin_sessions WHERE admin_user_id IN (SELECT id FROM admin_users WHERE phone LIKE ${PHONE_TAG + '%'})`;
  await prisma.$executeRaw`DELETE FROM admin_users WHERE phone LIKE ${PHONE_TAG + '%'}`;
}

beforeAll(async () => {
  process.env.SHOPIFY_CLIENT_SECRET = SECRET;
  await cleanup();
});
afterEach(() => {
  fake.variants = [];
  fake.failuresLeft = 0;
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  if (originalSecret === undefined) delete process.env.SHOPIFY_CLIENT_SECRET;
  else process.env.SHOPIFY_CLIENT_SECRET = originalSecret;
});

describe('SKU Shopify → ClosetAdmin, vinculado por shopifyVariantId (Postgres de teste, Shopify simulada)', () => {
  test('1) variante sem SKU recebe SKU: aparece na peça, auditado como SKU cadastrado', async () => {
    const { productId, units: [piece] } = await fixture([null]);
    fake.variants = [variant(piece.shopifyVariantId!, productId, sku('VS-SOB-PRETO'))];

    const report = await reconcile([piece.id]);

    expect(report.divergences).toEqual([expect.objectContaining({ kind: 'sku_changed', applied: true, previousSku: null, shopifySku: sku('VS-SOB-PRETO') })]);
    expect(await unit(piece.id)).toMatchObject({ shopifySku: sku('VS-SOB-PRETO'), active: true, shopifyVariantMissingAt: null });
    const [audit] = await skuAudits(piece.id);
    expect(audit).toMatchObject({ adminUserName: 'Sistema (sincronização de catálogo)', before: { shopifySku: null }, after: { shopifySku: sku('VS-SOB-PRETO') } });
    expect(audit.detail).toMatchObject({ origin: 'shopify_catalog_sync', reason: 'shopify_sku_added', shopifyVariantId: piece.shopifyVariantId });
    expect(JSON.stringify(audit)).not.toMatch(/token|secret|password/i);

    const [item] = (await catalog.list()).filter((v) => v.id === piece.shopifyVariantId);
    expect(item.skuStatus).toBe('synced');
  });

  test('2) variante com SKU altera o SKU: a peça passa a mostrar o novo, sem recadastro', async () => {
    const { productId, units: [piece] } = await fixture([sku('SKU-ANTIGO')]);
    fake.variants = [variant(piece.shopifyVariantId!, productId, sku('SKU-NOVO'))];

    const [item] = (await catalog.list()).filter((v) => v.id === piece.shopifyVariantId);
    expect(item.skuStatus).toBe('pending'); // antes da sincronização o painel avisa

    await reconcile([piece.id]);

    expect(await unit(piece.id)).toMatchObject({ shopifySku: sku('SKU-NOVO'), code: sku('SKU-NOVO'), active: true }); // o código acompanha o SKU
    const [audit] = await skuAudits(piece.id);
    expect(audit).toMatchObject({ before: { shopifySku: sku('SKU-ANTIGO') }, after: { shopifySku: sku('SKU-NOVO') } });
    expect(audit.detail).toMatchObject({ reason: 'shopify_sku_changed' });
    const [synced] = (await catalog.list()).filter((v) => v.id === piece.shopifyVariantId);
    expect(synced.skuStatus).toBe('synced');
  });

  test('3) SKU removido na Shopify: SKU ausente, vínculo e peça preservados, nada apagado', async () => {
    const { productId, units: [piece] } = await fixture([sku('SKU-QUE-SAI')]);
    fake.variants = [variant(piece.shopifyVariantId!, productId, null)]; // o client já normaliza SKU vazio para null

    await reconcile([piece.id]);

    expect(await unit(piece.id)).toMatchObject({
      shopifySku: null,
      shopifyVariantId: piece.shopifyVariantId,
      shopifyProductId: productId,
      active: true,
      shopifyVariantMissingAt: null,
    });
    const [audit] = await skuAudits(piece.id);
    expect(audit).toMatchObject({ before: { shopifySku: sku('SKU-QUE-SAI') }, after: { shopifySku: null } });
    expect(audit.detail).toMatchObject({ reason: 'shopify_sku_removed' });
    const [item] = (await catalog.list()).filter((v) => v.id === piece.shopifyVariantId);
    expect(item.skuStatus).toBe('missing');
  });

  test('4) duas variantes do mesmo produto mantêm SKUs independentes; cada peça fica com o código do próprio SKU', async () => {
    const { productId, units: [p, g] } = await fixture([sku('SOB-P'), sku('SOB-G')]);
    fake.variants = [variant(p.shopifyVariantId!, productId, sku('SOB-P-2026')), variant(g.shopifyVariantId!, productId, sku('SOB-G'))];

    await reconcile([p.id, g.id]);

    expect(await unit(p.id)).toMatchObject({ shopifySku: sku('SOB-P-2026'), code: sku('SOB-P-2026') });
    expect(await unit(g.id)).toMatchObject({ shopifySku: sku('SOB-G'), code: sku('SOB-G') }); // SKU igual, só o código acompanhou
    const [gAudit] = await skuAudits(g.id);
    expect(gAudit.detail).toMatchObject({ reason: 'code_follows_sku' });
  });

  test('5) webhook repetido é idempotente; SKU do corpo é ignorado, vale o da Admin API', async () => {
    const { number, productId, units: [piece] } = await fixture([sku('SKU-V1')]);
    fake.variants = [variant(piece.shopifyVariantId!, productId, sku('SKU-V2'))];
    const webhookId = nextWebhookId();
    // Corpo com um SKU forjado: o payload só diz QUAL produto mudou.
    const payload = { id: Number(number), variants: [{ id: Number(`${number}0`), sku: sku('SKU-FORJADO') }] };

    const first = await webhooks.handleIncoming({ topic: 'products/update', shopifyWebhookId: webhookId, payload });
    const again = await webhooks.handleIncoming({ topic: 'products/update', shopifyWebhookId: webhookId, payload });
    const otherDelivery = await webhooks.handleIncoming({ topic: 'products/update', shopifyWebhookId: nextWebhookId(), payload });

    expect([first.outcome, again.outcome, otherDelivery.outcome]).toEqual(['processed', 'duplicate', 'processed']);
    expect(await unit(piece.id)).toMatchObject({ shopifySku: sku('SKU-V2') });
    expect(await skuAudits(piece.id)).toHaveLength(1);
    const rows = await prisma.webhookEvent.findMany({ where: { shopifyWebhookId: webhookId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'processed', attemptCount: 2 });
    expect(await prisma.rentalUnit.count({ where: { shopifyVariantId: piece.shopifyVariantId } })).toBe(1);
  });

  test('5b) products/create também sincroniza pelo mesmo caminho', async () => {
    const { number, productId, units: [piece] } = await fixture([null]);
    fake.variants = [variant(piece.shopifyVariantId!, productId, sku('SKU-NOVO-PRODUTO'))];

    const res = await webhooks.handleIncoming({ topic: 'products/create', shopifyWebhookId: nextWebhookId(), payload: { id: Number(number) } });

    expect(res.outcome).toBe('processed');
    expect(await unit(piece.id)).toMatchObject({ shopifySku: sku('SKU-NOVO-PRODUTO') });
  });

  test('6) webhook inválido (assinatura errada ou outra loja) é rejeitado e não muda nada', async () => {
    const { number, productId, units: [piece] } = await fixture([sku('SKU-ORIGINAL')]);
    fake.variants = [variant(piece.shopifyVariantId!, productId, sku('SKU-ATACANTE'))];
    const body = JSON.stringify({ id: Number(number) });
    const webhookId = nextWebhookId();
    const valid = createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('base64');
    const forged = createHmac('sha256', 'segredo-errado').update(Buffer.from(body, 'utf8')).digest('base64');

    await expect(controller.receive({ rawBody: Buffer.from(body) }, forged, 'products/update', webhookId, 'dev-store.myshopify.com')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.receive({ rawBody: Buffer.from(body) }, undefined, 'products/update', webhookId, 'dev-store.myshopify.com')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.receive({ rawBody: Buffer.from(body) }, valid, 'products/update', webhookId, 'outra-loja.myshopify.com')).rejects.toBeInstanceOf(UnauthorizedException);

    expect(await unit(piece.id)).toMatchObject({ shopifySku: sku('SKU-ORIGINAL') });
    expect(await prisma.webhookEvent.count({ where: { shopifyWebhookId: webhookId } })).toBe(0);
    expect(await skuAudits(piece.id)).toHaveLength(0);

    // A mesma entrega com assinatura correta passa (prova que o teste não recusa tudo).
    await controller.receive({ rawBody: Buffer.from(body) }, valid, 'products/update', webhookId, 'dev-store.myshopify.com');
    expect(await unit(piece.id)).toMatchObject({ shopifySku: sku('SKU-ATACANTE') });
  });

  test('7) produto arquivado mantém o arquivamento lógico e preserva o histórico de SKU', async () => {
    const { productId, units: [piece] } = await fixture([sku('SKU-1')]);
    const reservationId = await createFutureReservation(piece.id);
    fake.variants = [variant(piece.shopifyVariantId!, productId, sku('SKU-2'))];
    await reconcile([piece.id]);
    const before = await snapshotReservation(reservationId);

    fake.variants = [variant(piece.shopifyVariantId!, productId, sku('SKU-2'), { product: { id: productId, title: 'Sobretudo', handle: 'sobretudo', productType: '', status: 'ARCHIVED' } })];
    await reconcile([piece.id]);
    // Arquivada: nenhuma nova troca de SKU é aplicada enquanto estiver assim.
    fake.variants = [variant(piece.shopifyVariantId!, productId, sku('SKU-3'), { product: { id: productId, title: 'Sobretudo', handle: 'sobretudo', productType: '', status: 'ARCHIVED' } })];
    const report = await reconcile([piece.id]);

    expect(report.divergences).toHaveLength(0);
    expect(await unit(piece.id)).toMatchObject({ active: false, shopifySku: null, shopifyVariantId: piece.shopifyVariantId });
    expect((await unit(piece.id)).shopifyVariantMissingAt).not.toBeNull();
    expect(await skuAudits(piece.id)).toHaveLength(1); // o histórico da troca SKU-1 → SKU-2 continua lá
    const after = await snapshotReservation(reservationId);
    expect(after.status).toBe(before.status);
    expect(after.items).toEqual(before.items);
    expect(after.events.slice(0, before.events.length)).toEqual(before.events); // nada apagado; só o alerta de revisão se soma
  });

  test('8) nenhuma peça física é criada automaticamente, mesmo com estoque na Shopify', async () => {
    const number = productNumber();
    const productId = `gid://shopify/Product/${number}`;
    const variantId = `gid://shopify/ProductVariant/${number}0`;
    fake.variants = [variant(variantId, productId, sku('SKU-SEM-PECA'), { inventoryQuantity: 7 })];

    await webhooks.handleIncoming({ topic: 'products/create', shopifyWebhookId: nextWebhookId(), payload: { id: Number(number) } });
    await webhooks.handleIncoming({ topic: 'products/update', shopifyWebhookId: nextWebhookId(), payload: { id: Number(number) } });

    expect(await prisma.rentalUnit.count({ where: { shopifyVariantId: variantId } })).toBe(0);
    const [item] = (await catalog.list()).filter((v) => v.id === variantId);
    expect(item).toMatchObject({ sku: sku('SKU-SEM-PECA'), skuStatus: 'synced', physicalUnitsTotal: 0, inventoryQuantity: 7 });
  });

  test('9) troca de SKU não toca reservas, itens nem histórico', async () => {
    const { productId, units: [piece] } = await fixture([sku('SKU-A')]);
    const reservationId = await createFutureReservation(piece.id);
    const before = await snapshotReservation(reservationId);
    fake.variants = [variant(piece.shopifyVariantId!, productId, sku('SKU-B'))];

    await reconcile([piece.id]);

    expect(await snapshotReservation(reservationId)).toEqual(before);
    expect(await unit(piece.id)).toMatchObject({ shopifySku: sku('SKU-B'), active: true, reservableOnline: true, code: sku('SKU-B') });
  });

  test('10) reconciliação corrige SKU divergente (webhook perdido) e depois não faz mais nada', async () => {
    const { productId, units: [piece] } = await fixture([sku('SKU-CERTO')]);
    fake.variants = [variant(piece.shopifyVariantId!, productId, sku('SKU-CERTO'))];
    await prisma.rentalUnit.update({ where: { id: piece.id }, data: { shopifySku: sku('SKU-DESATUALIZADO') } });

    const preview = await sync.reconcile({ apply: false, rentalUnitIds: [piece.id] });
    expect(preview.divergences).toEqual([expect.objectContaining({ kind: 'sku_changed', applied: false })]);
    expect(await unit(piece.id)).toMatchObject({ shopifySku: sku('SKU-DESATUALIZADO') }); // relatório não escreve

    await reconcile([piece.id]);
    expect(await unit(piece.id)).toMatchObject({ shopifySku: sku('SKU-CERTO') });
    const rerun = await reconcile([piece.id]);
    expect(rerun.divergences).toHaveLength(0);
    expect(await skuAudits(piece.id)).toHaveLength(1);
  });

  test('11) falha temporária da Shopify: webhook responde 503, fica "failed" e a reentrega aplica', async () => {
    const { number, productId, units: [piece] } = await fixture([sku('SKU-OLD')]);
    fake.variants = [variant(piece.shopifyVariantId!, productId, sku('SKU-NEW'))];
    fake.failuresLeft = 1;
    const webhookId = nextWebhookId();

    await expect(webhooks.handleIncoming({ topic: 'products/update', shopifyWebhookId: webhookId, payload: { id: Number(number) } })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(await unit(piece.id)).toMatchObject({ shopifySku: sku('SKU-OLD') });
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { shopifyWebhookId: webhookId } })).toMatchObject({ status: 'failed' });

    const retry = await webhooks.handleIncoming({ topic: 'products/update', shopifyWebhookId: webhookId, payload: { id: Number(number) } });
    expect(retry.outcome).toBe('processed');
    expect(await unit(piece.id)).toMatchObject({ shopifySku: sku('SKU-NEW') });
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { shopifyWebhookId: webhookId } })).toMatchObject({ status: 'processed' });
  });
});

describe('12) permissão da sincronização (guard real sobre os metadados do controller)', () => {
  const guard = new AdminRoleGuard(prisma, new Reflector());
  let users = 0;

  async function session(role: AdminRole, moduleAccess: AdminModule[]) {
    const user = await prisma.adminUser.create({
      data: { name: 'SKU Sync Teste', phone: `${PHONE_TAG}${users++}`, pinHash: await hashPin('1234'), role, active: true, moduleAccess },
    });
    const token = generateSessionToken();
    await prisma.adminSession.create({ data: { adminUserId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60_000) } });
    return { user, token };
  }

  function context(handler: (...args: never[]) => unknown, token: string, adminUserId: string): ExecutionContext {
    const request = { headers: { 'x-admin-session': token }, query: { adminUserId }, body: {} };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => handler,
      getClass: () => ShopifyCatalogSyncController,
    } as unknown as ExecutionContext;
  }

  const syncHandler = ShopifyCatalogSyncController.prototype.sync;
  const reportHandler = ShopifyCatalogSyncController.prototype.reconciliation;

  test('STAFF com módulo PIECES vê o relatório, mas não sincroniza', async () => {
    const { user, token } = await session('STAFF', ['PIECES']);
    await expect(guard.canActivate(context(reportHandler, token, user.id))).resolves.toBe(true);
    await expect(guard.canActivate(context(syncHandler, token, user.id))).rejects.toBeInstanceOf(ForbiddenException);
  });

  test('sem o módulo PIECES nem o relatório abre; sem sessão é 401', async () => {
    const { user, token } = await session('ADMIN', []);
    await expect(guard.canActivate(context(reportHandler, token, user.id))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(context(syncHandler, 'sessao-invalida', user.id))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  test('ADMIN com PIECES sincroniza', async () => {
    const { user, token } = await session('ADMIN', ['PIECES']);
    await expect(guard.canActivate(context(syncHandler, token, user.id))).resolves.toBe(true);
  });
});

describe('Código da peça acompanha o SKU da Shopify', () => {
  test('caso relatado: SKU já "02" e código "0002" → o código vira "02"; reservas intactas', async () => {
    const tag = sku('02');
    const { productId, units: [piece] } = await fixture([tag]);
    await prisma.rentalUnit.update({ where: { id: piece.id }, data: { code: `${PREFIX}-0002` } });
    const reservationId = await createFutureReservation(piece.id);
    const before = await snapshotReservation(reservationId);
    fake.variants = [variant(piece.shopifyVariantId!, productId, tag)];

    const report = await reconcile([piece.id]);

    expect(report.divergences).toEqual([expect.objectContaining({ kind: 'sku_changed', applied: true, previousCode: `${PREFIX}-0002`, newCode: tag })]);
    expect(await unit(piece.id)).toMatchObject({ code: tag, shopifySku: tag });
    const [audit] = await skuAudits(piece.id);
    expect(audit).toMatchObject({ before: { code: `${PREFIX}-0002`, shopifySku: tag }, after: { code: tag, shopifySku: tag } });
    expect(audit.detail).toMatchObject({ reason: 'code_follows_sku' });
    expect(await snapshotReservation(reservationId)).toEqual(before); // reserva aponta para a peça pelo id, não pelo código
    expect((await reconcile([piece.id])).divergences).toHaveLength(0); // idempotente
  });

  test('variante com VÁRIAS peças: só o SKU acompanha; os códigos continuam distintos', async () => {
    const { productId, units: [a] } = await fixture([sku('PAR-A')]);
    const b = await prisma.rentalUnit.create({
      data: { code: `${PREFIX}-par-b-${RUN}`, name: 'Sobretudo par', shopifyProductId: productId, shopifyVariantId: a.shopifyVariantId, shopifySku: sku('PAR-A'), active: true, reservableOnline: true, countsTowardRentalDuration: true },
    });
    fake.variants = [variant(a.shopifyVariantId!, productId, sku('PAR-NOVO'))];

    await reconcile([a.id, b.id]);

    expect(await unit(a.id)).toMatchObject({ shopifySku: sku('PAR-NOVO'), code: a.code });
    expect(await unit(b.id)).toMatchObject({ shopifySku: sku('PAR-NOVO'), code: b.code });
  });

  test('código já usado por OUTRA peça: não renomeia, não dá erro, SKU segue sincronizado', async () => {
    const taken = sku('OCUPADO');
    const { units: [other] } = await fixture([sku('OUTRA')]);
    await prisma.rentalUnit.update({ where: { id: other.id }, data: { code: taken } });
    const { productId, units: [piece] } = await fixture([sku('ANTES')]);
    fake.variants = [variant(piece.shopifyVariantId!, productId, taken)];

    await expect(reconcile([piece.id])).resolves.toBeDefined();

    expect(await unit(piece.id)).toMatchObject({ shopifySku: taken, code: piece.code });
    expect(await unit(other.id)).toMatchObject({ code: taken });
    expect((await reconcile([piece.id])).divergences).toHaveLength(0); // nada pendente para repetir
  });

  test('SKU removido: a peça mantém o código (nunca fica sem código)', async () => {
    const { productId, units: [piece] } = await fixture([sku('VAI-SAIR')]);
    fake.variants = [variant(piece.shopifyVariantId!, productId, sku('VAI-SAIR'))];
    await reconcile([piece.id]);
    const codeBefore = (await unit(piece.id)).code;
    fake.variants = [variant(piece.shopifyVariantId!, productId, null)];

    await reconcile([piece.id]);

    expect(await unit(piece.id)).toMatchObject({ shopifySku: null, code: codeBefore });
  });
});
