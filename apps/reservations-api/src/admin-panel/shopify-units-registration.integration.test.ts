import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { AvailabilityController } from '../availability/availability.controller';
import { AvailabilityService } from '../availability/availability.service';
import { KNOWN_VALE_PASS_VARIANT_ID } from '../vale-pass/vale-pass-order-status';
import { civilDateToISO, addDays } from '../rental-rules/civil-date';
import { today } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';
import { AdminPiecesService } from './pieces.service';
import type { ShopifyAdminClient, ShopifyCatalogVariant } from './shopify-admin.client';
import { ShopifyCatalogService } from './shopify-catalog.service';
import { ShopifyCatalogSyncService } from './shopify-catalog-sync.service';

/**
 * Do SKU da Shopify até o calendário, etapa por etapa (Postgres de TESTE real,
 * Shopify simulada — nenhuma chamada de rede):
 *
 *   SKU na Shopify → catálogo do ClosetAdmin → cadastro da peça física
 *   → banco (ativa + reservável) → contadores → disponibilidade → lista pública.
 *
 * Caso real que motivou a suíte (produto "Blazer Star", SKU 03, estoque 1): SKU
 * sincronizado NÃO é peça física cadastrada, e um cadastro recusado por código
 * em uso parecia sucesso ("Código(s) já cadastrado(s)").
 */
const prisma = new PrismaService();
const RUN = Date.now();
const PREFIX = `reg-${RUN}`;
const admin = { id: '', name: `Admin ${PREFIX}` };
let seq = 0;
const next = () => `${RUN}${String(seq++).padStart(3, '0')}`;
const code = (label: string) => `${label}-${RUN}`.toUpperCase();

class FakeShopify {
  variants: ShopifyCatalogVariant[] = [];
  async listVariants() {
    return this.variants;
  }
  async getVariant(id: string) {
    return this.variants.find((v) => v.id === id) ?? null;
  }
}
const fake = new FakeShopify();
const asClient = fake as unknown as ShopifyAdminClient;
const catalog = new ShopifyCatalogService(prisma, asClient);
const sync = new ShopifyCatalogSyncService(prisma, asClient);
const pieces = new AdminPiecesService(prisma);
const availability = new AvailabilityService(prisma, new RentalRuleConfigService(prisma));
const publicApi = new AvailabilityController(availability, prisma);

function shopifyVariant(sku: string | null, overrides: Partial<ShopifyCatalogVariant> = {}, productStatus = 'ACTIVE'): ShopifyCatalogVariant {
  const n = next();
  const v: ShopifyCatalogVariant = {
    id: `gid://shopify/ProductVariant/${n}`,
    title: 'Default Title',
    sku,
    inventoryQuantity: 1,
    imageUrl: null,
    imageAlt: null,
    selectedOptions: [],
    product: { id: `gid://shopify/Product/${n}`, title: 'Blazer Star', handle: `blazer-star-${n}`, productType: 'Blazer', status: productStatus },
    ...overrides,
  };
  fake.variants.push(v);
  return v;
}

const item = async (variantId: string) => (await catalog.list()).find((entry) => entry.id === variantId)!;
const units = (variantId: string) => prisma.rentalUnit.findMany({ where: { shopifyVariantId: variantId }, orderBy: { code: 'asc' } });
const rentable = async () => (await publicApi.getCatalogVariants()).variantIds;
const dayRange = () => {
  const start = today(DEFAULT_RENTAL_RULE_CONFIG);
  return { from: civilDateToISO(start), to: civilDateToISO(addDays(start, 5)) };
};

beforeAll(async () => {
  const row = await prisma.adminUser.create({ data: { name: admin.name, phone: `${RUN}7`, pinHash: 'sintetico', role: 'ADMIN', moduleAccess: [] } });
  admin.id = row.id;
}, 30_000);

afterAll(async () => {
  const mine = await prisma.rentalUnit.findMany({ where: { OR: [{ code: { contains: String(RUN) } }, { name: { contains: 'Blazer Star' }, shopifyVariantId: { in: fake.variants.map((v) => v.id) } }] }, select: { id: true } });
  const ids = mine.map((u) => u.id);
  if (ids.length) {
    await prisma.adminAuditEvent.deleteMany({ where: { OR: [{ entityId: { in: ids } }, { adminUserId: admin.id }] } });
    await prisma.rentalUnit.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.adminUser.delete({ where: { id: admin.id } }).catch(() => undefined);
  await prisma.$disconnect();
}, 60_000);

describe('SKU sincronizado ≠ peça física cadastrada', () => {
  test('produto sem peça física: SKU sincronizado, 0 peças, fora da lista pública e sem disponibilidade (404)', async () => {
    const v = shopifyVariant(code('03'));
    const entry = await item(v.id);
    expect([entry.sku, entry.inventoryQuantity]).toEqual([code('03'), 1]);
    expect([entry.physicalUnitsTotal, entry.physicalUnitsActive, entry.physicalUnitsReservableOnline]).toEqual([0, 0, 0]);
    expect(await rentable()).not.toContain(v.id);
    await expect(availability.getAvailability({ shopifyVariantId: v.id, countedPieces: 1, ...dayRange() })).rejects.toBeInstanceOf(NotFoundException);
    // O estoque da Shopify nunca vira peça física sozinho, nem depois de sincronizar.
    await sync.reconcile({ apply: true, rentalUnitIds: [] });
    expect(await units(v.id)).toHaveLength(0);
  });

  test('cadastrar o código: persiste ATIVA e reservável, vinculada à variante, com o SKU; contadores e lista pública atualizam', async () => {
    const v = shopifyVariant(code('03'));
    const created = await catalog.importUnits({ shopifyVariantId: v.id, codes: [v.sku as string] }, admin.id, admin.name);
    expect(created.map((u) => [u.code, u.active, u.reservableOnline, u.countsTowardRentalDuration])).toEqual([[v.sku, true, true, true]]);

    const rows = await units(v.id);
    expect(rows).toHaveLength(1);
    expect([rows[0].active, rows[0].reservableOnline, rows[0].shopifySku, rows[0].shopifyProductId, rows[0].shopifyVariantMissingAt]).toEqual([true, true, v.sku, v.product.id, null]);

    const entry = await item(v.id);
    expect([entry.skuStatus, entry.physicalUnitsTotal, entry.physicalUnitsActive, entry.physicalUnitsReservableOnline]).toEqual(['synced', 1, 1, 1]);
    expect(await rentable()).toContain(v.id);
    const res = await availability.getAvailability({ shopifyVariantId: v.id, countedPieces: 1, ...dayRange() });
    expect(res.unitsTotal).toBe(1);
    expect(res.days.length).toBeGreaterThan(0);

    const audit = await prisma.adminAuditEvent.findMany({ where: { entityId: v.id, action: 'SHOPIFY_UNITS_IMPORTED' } });
    expect(audit).toHaveLength(1);
  });

  test('"reinício" da API: com serviços e conexão novos o cadastro continua lá (está no banco, não na memória)', async () => {
    const v = shopifyVariant(code('RST'));
    await catalog.importUnits({ shopifyVariantId: v.id, codes: [v.sku as string] }, admin.id, admin.name);

    const restarted = new PrismaService();
    try {
      const catalogAfter = new ShopifyCatalogService(restarted, asClient);
      const publicAfter = new AvailabilityController(new AvailabilityService(restarted, new RentalRuleConfigService(restarted)), restarted);
      const entry = (await catalogAfter.list()).find((e) => e.id === v.id)!;
      expect([entry.physicalUnitsTotal, entry.physicalUnitsReservableOnline]).toEqual([1, 1]);
      expect((await publicAfter.getCatalogVariants()).variantIds).toContain(v.id);
    } finally {
      await restarted.$disconnect();
    }
  });
});

describe('cadastro duplicado e códigos em uso', () => {
  test('mesmo código de novo: recusa (409) dizendo que NADA foi cadastrado e quem usa o código; nada muda', async () => {
    const v = shopifyVariant(code('DUP'));
    await catalog.importUnits({ shopifyVariantId: v.id, codes: [v.sku as string] }, admin.id, admin.name);
    const error = await catalog.importUnits({ shopifyVariantId: v.id, codes: [v.sku as string] }, admin.id, admin.name).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toMatch(/^Nada foi cadastrado:/);
    expect(error.message).toContain(v.sku);
    expect(error.message).toContain('já cadastrada para esta mesma variante');
    expect(await units(v.id)).toHaveLength(1);
  });

  test('código já usado por peça ATIVA de outra variante (o caso do "03"): recusa explicando, não toca na outra peça', async () => {
    const other = shopifyVariant(code('OUTRA'));
    await catalog.importUnits({ shopifyVariantId: other.id, codes: [other.sku as string] }, admin.id, admin.name);
    const blazer = shopifyVariant(code('BLZ'));
    const error = await catalog.importUnits({ shopifyVariantId: blazer.id, codes: [other.sku as string] }, admin.id, admin.name).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toContain('vinculada a outra variante da Shopify');
    expect(error.message).toContain('ativa');
    expect(await units(blazer.id)).toHaveLength(0);
    const holder = await units(other.id);
    expect([holder[0].code, holder[0].active]).toEqual([other.sku, true]);
    // o Blazer continua sem peça: fora da lista pública, e o contador diz 0 (não "sucesso")
    expect((await item(blazer.id)).physicalUnitsTotal).toBe(0);
    expect(await rentable()).not.toContain(blazer.id);
  });

  test('código usado por peça sem vínculo com a Shopify também é recusado, dizendo isso', async () => {
    const legacy = await prisma.rentalUnit.create({ data: { code: code('LEGADO'), name: 'Peça antiga', active: true, reservableOnline: true } });
    const v = shopifyVariant(code('NOVO'));
    const error = await catalog.importUnits({ shopifyVariantId: v.id, codes: [legacy.code] }, admin.id, admin.name).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toContain('sem vínculo com a Shopify');
  });

  test('código usado por peça ARQUIVADA pela sincronização: é liberado (<código>-ARQ, depois -ARQ-2) e a peça nova nasce ativa; histórico e auditoria preservados', async () => {
    const old = shopifyVariant(code('ARQ'), {}, 'ARCHIVED');
    const archived = await prisma.rentalUnit.create({
      data: { code: code('ARQ'), name: 'Blazer antigo', shopifyVariantId: old.id, shopifyProductId: old.product.id, shopifySku: null, active: false, reservableOnline: true, shopifyVariantMissingAt: new Date() },
    });
    const fresh = shopifyVariant(code('ARQ'));
    const created = await catalog.importUnits({ shopifyVariantId: fresh.id, codes: [code('ARQ')] }, admin.id, admin.name);
    expect(created.map((u) => [u.code, u.active, u.reservableOnline])).toEqual([[code('ARQ'), true, true]]);

    const moved = await prisma.rentalUnit.findUniqueOrThrow({ where: { id: archived.id } });
    expect([moved.code, moved.active, moved.shopifyVariantMissingAt !== null]).toEqual([`${code('ARQ')}-ARQ`, false, true]);
    const released = await prisma.adminAuditEvent.findMany({ where: { entityId: archived.id, action: 'CATALOG_UNIT_CODE_RELEASED' } });
    expect(released).toHaveLength(1);

  });

  test('se <código>-ARQ já existe, a peça arquivada vira <código>-ARQ-2 (nunca sobrescreve outra)', async () => {
    const c = code('ARQX');
    await prisma.rentalUnit.create({ data: { code: `${c}-ARQ`, name: 'arquivada antes', active: false, reservableOnline: true, shopifyVariantMissingAt: new Date() } });
    const holder = await prisma.rentalUnit.create({ data: { code: c, name: 'arquivada agora', active: false, reservableOnline: true, shopifyVariantMissingAt: new Date() } });
    const v = shopifyVariant(c);
    await catalog.importUnits({ shopifyVariantId: v.id, codes: [c] }, admin.id, admin.name);
    expect((await prisma.rentalUnit.findUniqueOrThrow({ where: { id: holder.id } })).code).toBe(`${c}-ARQ-2`);
  });

  test('código repetido na mesma importação e código inválido: 400, nada gravado', async () => {
    const v = shopifyVariant(code('REP'));
    await expect(catalog.importUnits({ shopifyVariantId: v.id, codes: ['ab1', 'AB1'] }, admin.id, admin.name)).rejects.toBeInstanceOf(BadRequestException);
    expect(await units(v.id)).toHaveLength(0);
  });

  test('importação concorrente do mesmo código: uma vence, a outra recebe 409; nunca duplica', async () => {
    const v = shopifyVariant(code('RACE'));
    const results = await Promise.allSettled([
      catalog.importUnits({ shopifyVariantId: v.id, codes: [v.sku as string] }, admin.id, admin.name),
      catalog.importUnits({ shopifyVariantId: v.id, codes: [v.sku as string] }, admin.id, admin.name),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(ConflictException);
    expect(await units(v.id)).toHaveLength(1);
  });
});

describe('Valle Pass fica fora do aluguel', () => {
  test('não aceita cadastro de peça física para a variante nem para o produto do Valle Pass', async () => {
    const byVariant = shopifyVariant(code('VP'), { id: `gid://shopify/ProductVariant/${KNOWN_VALE_PASS_VARIANT_ID}` });
    await expect(catalog.importUnits({ shopifyVariantId: byVariant.id, codes: [code('VPCODE')] }, admin.id, admin.name)).rejects.toBeInstanceOf(BadRequestException);
    expect(await prisma.rentalUnit.count({ where: { code: code('VPCODE') } })).toBe(0);
  });

  test('variante de CAMPANHA do Valle Pass: cadastro recusado e peça antiga nunca entra na lista pública', async () => {
    const campaignVariant = shopifyVariant(code('CAMP'));
    const campaign = await prisma.valePassCampaign.create({ data: { name: `Campanha ${PREFIX}`, amountCents: 10000, validityDays: 30, shopifyVariantId: campaignVariant.id, active: true } });
    let legacyId: string | null = null;
    try {
      await expect(catalog.importUnits({ shopifyVariantId: campaignVariant.id, codes: [code('CAMPCODE')] }, admin.id, admin.name)).rejects.toBeInstanceOf(BadRequestException);
      expect(await units(campaignVariant.id)).toHaveLength(0);
      const legacy = await prisma.rentalUnit.create({ data: { code: code('CAMPLEG'), name: 'Campanha (legado)', shopifyVariantId: campaignVariant.id, active: true, reservableOnline: true } });
      legacyId = legacy.id;
      expect(await rentable()).not.toContain(campaignVariant.id);
    } finally {
      if (legacyId) await prisma.rentalUnit.delete({ where: { id: legacyId } }).catch(() => undefined);
      await prisma.valePassCampaign.delete({ where: { id: campaign.id } }).catch(() => undefined);
    }
  });

  test('mesmo que exista peça ligada à variante do Valle Pass (dado antigo), ela nunca entra na lista pública do aluguel', async () => {
    const vpGid = `gid://shopify/ProductVariant/${KNOWN_VALE_PASS_VARIANT_ID}`;
    const before = await prisma.rentalUnit.count({ where: { shopifyVariantId: vpGid } });
    const legacy = await prisma.rentalUnit.create({ data: { code: code('VPLEG'), name: 'Valle Pass (legado)', shopifyVariantId: vpGid, active: true, reservableOnline: true } });
    try {
      expect(await rentable()).not.toContain(vpGid);
    } finally {
      await prisma.rentalUnit.delete({ where: { id: legacy.id } });
      expect(await prisma.rentalUnit.count({ where: { shopifyVariantId: vpGid } })).toBe(before);
    }
  });
});

describe('peça ativada/desativada, reservável ou não', () => {
  test('desativar tira da lista pública e zera os contadores "ativas/online"; reativar volta — a disponibilidade acompanha', async () => {
    const v = shopifyVariant(code('TOG'));
    const [piece] = await catalog.importUnits({ shopifyVariantId: v.id, codes: [v.sku as string] }, admin.id, admin.name);
    expect(await rentable()).toContain(v.id);

    await pieces.update(piece.id, { active: false, reason: 'teste' }, admin.id, admin.name);
    let entry = await item(v.id);
    expect([entry.physicalUnitsTotal, entry.physicalUnitsActive, entry.physicalUnitsReservableOnline]).toEqual([1, 0, 0]);
    expect(await rentable()).not.toContain(v.id);
    await expect(availability.getAvailability({ shopifyVariantId: v.id, countedPieces: 1, ...dayRange() })).rejects.toBeInstanceOf(NotFoundException);

    await pieces.update(piece.id, { active: true }, admin.id, admin.name);
    entry = await item(v.id);
    expect([entry.physicalUnitsActive, entry.physicalUnitsReservableOnline]).toEqual([1, 1]);
    expect(await rentable()).toContain(v.id);
  });

  test('peça ativa mas NÃO reservável online: conta como ativa, não aparece na lista pública e a disponibilidade recusa (422)', async () => {
    const v = shopifyVariant(code('OFF'));
    await catalog.importUnits({ shopifyVariantId: v.id, codes: [v.sku as string], reservableOnline: false }, admin.id, admin.name);
    const entry = await item(v.id);
    expect([entry.physicalUnitsTotal, entry.physicalUnitsActive, entry.physicalUnitsReservableOnline]).toEqual([1, 1, 0]);
    expect(await rentable()).not.toContain(v.id);
    await expect(availability.getAvailability({ shopifyVariantId: v.id, countedPieces: 1, ...dayRange() })).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  test('produto ainda não ativo na Shopify não pode ser marcado como reservável online', async () => {
    const v = shopifyVariant(code('DRAFT'), {}, 'DRAFT');
    await expect(catalog.importUnits({ shopifyVariantId: v.id, codes: [v.sku as string] }, admin.id, admin.name)).rejects.toBeInstanceOf(BadRequestException);
    expect(await units(v.id)).toHaveLength(0);
  });
});

describe('SKU criado e alterado na Shopify', () => {
  test('SKU novo/alterado: o catálogo mostra "pending" até a sincronização; depois o SKU e o código da peça única acompanham, sem criar nem apagar peça', async () => {
    const v = shopifyVariant(code('S1'));
    const [piece] = await catalog.importUnits({ shopifyVariantId: v.id, codes: [v.sku as string] }, admin.id, admin.name);

    const changed = { ...v, sku: code('S2') };
    fake.variants[fake.variants.findIndex((x) => x.id === v.id)] = changed;
    expect((await item(v.id)).skuStatus).toBe('pending');

    await sync.reconcile({ apply: true, rentalUnitIds: [piece.id] });
    const row = await prisma.rentalUnit.findUniqueOrThrow({ where: { id: piece.id } });
    expect([row.shopifySku, row.code, row.active]).toEqual([code('S2'), code('S2'), true]);
    expect((await item(v.id)).skuStatus).toBe('synced');
    expect(await units(v.id)).toHaveLength(1);

    // rodar de novo é idempotente
    await sync.reconcile({ apply: true, rentalUnitIds: [piece.id] });
    expect(await prisma.adminAuditEvent.count({ where: { entityId: piece.id, action: 'CATALOG_UNIT_SKU_SYNCED' } })).toBe(1);
  });
});
