import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { AvailabilityService } from '../availability/availability.service';
import { AdminPiecesService } from './pieces.service';
import { ShopifyCatalogSyncService } from './shopify-catalog-sync.service';
import type { ShopifyAdminClient, ShopifyCatalogVariant } from './shopify-admin.client';
import { addDays, civilDateToISO, isSunday } from '../rental-rules/civil-date';
import { isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';

/**
 * Cenários exatos pedidos na correção da UI de /closetadmin/pecas — a tela
 * é uma leitura "burra" de `PieceListItem.active`/`currentlyOccupied`
 * (Livre/Ocupada/Desativada), então a garantia real está nos dados que
 * `AdminPiecesService.list()` devolve e no que `AvailabilityService`
 * calcula — não numa asserção de string de tela (este repo não tem
 * harness de teste de componente React; testes de UI aqui são sempre
 * pelos dados que a alimentam). `ShopifyAdminClient` é FALSO — nenhuma
 * chamada de rede.
 */
const prisma = new PrismaService();
const pieces = new AdminPiecesService(prisma);
const rules = new RentalRuleConfigService(prisma);
const availability = new AvailabilityService(prisma, rules);

const PREFIX = `pieces-status-${Date.now()}`;
const ACTOR = { id: '55555555-5555-4555-8555-555555555555', name: 'Admin sintético' };

class FakeShopifyAdminClient {
  variants: ShopifyCatalogVariant[] = [];
  async listVariants(): Promise<ShopifyCatalogVariant[]> {
    return this.variants;
  }
  async getVariant(): Promise<ShopifyCatalogVariant | null> {
    throw new Error('não usado neste teste');
  }
}
function variant(id: string): ShopifyCatalogVariant {
  return {
    id,
    title: 'Default Title',
    sku: null,
    inventoryQuantity: null,
    imageUrl: null,
    imageAlt: null,
    selectedOptions: [],
    product: { id: `${id}-product`, title: 'Produto', handle: 'produto', productType: '', status: 'ACTIVE' },
  };
}
const DECOY_VARIANT = 'gid://shopify/ProductVariant/decoy-nao-relacionada';

let unitCounter = 0;
async function createUnit() {
  const code = `${PREFIX}-u${unitCounter++}`;
  return prisma.rentalUnit.create({
    data: {
      code,
      name: 'Peça 02',
      shopifyProductId: `${code}-product`,
      shopifyVariantId: `${code}-variant`,
      shopifySku: `${code}-sku`,
      active: true,
      reservableOnline: true,
      countsTowardRentalDuration: true,
    },
  });
}

// Procura nas duas listas: a principal e a das arquivadas pela sincronização
// (quem está em qual é verificado explicitamente no teste 2).
async function pieceItem(id: string) {
  const all = [...(await pieces.list()), ...(await pieces.list({ archived: true }))];
  const item = all.find((p) => p.id === id);
  if (!item) throw new Error('peça não encontrada em AdminPiecesService.list()');
  return item;
}

async function cleanup() {
  const units = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
  const unitIds = units.map((u) => u.id);
  if (unitIds.length) {
    await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE entity_id = ANY(${unitIds})`;
    await prisma.$executeRaw`DELETE FROM rental_units WHERE id = ANY(${unitIds}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE admin_user_id = ${ACTOR.id}::uuid`;
}

describe('Situação da peça em /closetadmin/pecas — Livre/Ocupada/Desativada (PostgreSQL isolado)', () => {
  let fake: FakeShopifyAdminClient;
  let sync: ShopifyCatalogSyncService;

  beforeAll(async () => {
    await cleanup();
    await prisma.adminUser.upsert({
      where: { id: ACTOR.id },
      create: { id: ACTOR.id, name: ACTOR.name, phone: `9${Date.now()}0`, pinHash: 'x:y', role: 'ADMIN', active: true },
      update: {},
    });
  });
  beforeEach(() => {
    fake = new FakeShopifyAdminClient();
    sync = new ShopifyCatalogSyncService(prisma, fake as unknown as ShopifyAdminClient);
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  }, 60_000);

  test('1) peça ativa sem reserva → active=true, currentlyOccupied=false (o dado por trás de "Livre")', async () => {
    const unit = await createUnit();
    const item = await pieceItem(unit.id);
    expect(item.active).toBe(true);
    expect(item.currentlyOccupied).toBe(false);
    expect(item.shopifyVariantMissingAt).toBeNull();
  });

  test('2) peça inativa por variante ausente na Shopify → active=false + motivo (o dado por trás de "Desativada")', async () => {
    const unit = await createUnit();
    fake.variants = [variant(DECOY_VARIANT)]; // Shopify tem outras variantes — só a desta peça sumiu
    await sync.reconcile({ apply: true, actor: ACTOR, rentalUnitIds: [unit.id] });

    const item = await pieceItem(unit.id);
    expect(item.active).toBe(false);
    expect(item.shopifyVariantMissingAt).not.toBeNull();
    // Arquivada: sai da lista principal de Peças físicas e fica só na consulta separada.
    expect((await pieces.list()).some((p) => p.id === unit.id)).toBe(false);
    expect((await pieces.list({ archived: true })).some((p) => p.id === unit.id)).toBe(true);
  });

  test('3) peça inativa nunca aparece na disponibilidade (mesmo cálculo do site/calendário — não só o campo `active`)', async () => {
    const unit = await createUnit();
    const variantId = unit.shopifyVariantId as string;
    let bookableDate = addDays(engineToday(DEFAULT_RENTAL_RULE_CONFIG), 60);
    while (!isOnlineReservationAllowed(bookableDate, DEFAULT_RENTAL_RULE_CONFIG) || isSunday(bookableDate)) {
      bookableDate = addDays(bookableDate, 1);
    }
    const from = civilDateToISO(bookableDate);
    const to = from;

    const before = await availability.getAvailability({ shopifyVariantId: variantId, countedPieces: 1, from, to });
    expect(before.days[0].quantityAvailable).toBe(1);

    fake.variants = [variant(DECOY_VARIANT)];
    await sync.reconcile({ apply: true, actor: ACTOR, rentalUnitIds: [unit.id] });

    // Sem unidade ATIVA pra essa variante, AvailabilityService recusa com 404
    // — a mesma checagem `active = true` que HoldsService/AdminReservationsService
    // usam. Não sobra quantidade disponível "0 escondido"; a variante inteira
    // some da disponibilidade.
    await expect(availability.getAvailability({ shopifyVariantId: variantId, countedPieces: 1, from, to })).rejects.toBeInstanceOf(NotFoundException);
  });

  test('4) sincronização continua idempotente: rodar de novo não muda nada nem duplica evento', async () => {
    const unit = await createUnit();
    fake.variants = [variant(DECOY_VARIANT)];

    await sync.reconcile({ apply: true, actor: ACTOR, rentalUnitIds: [unit.id] });
    const itemAfterFirst = await pieceItem(unit.id);

    await sync.reconcile({ apply: true, actor: ACTOR, rentalUnitIds: [unit.id] });
    await sync.reconcile({ apply: true, actor: ACTOR, rentalUnitIds: [unit.id] });
    const itemAfterMore = await pieceItem(unit.id);

    expect(itemAfterMore).toEqual(itemAfterFirst);
    const deactivations = await prisma.adminAuditEvent.count({ where: { entityId: unit.id, action: 'CATALOG_UNIT_DEACTIVATED' } });
    expect(deactivations).toBe(1);
  });
});
