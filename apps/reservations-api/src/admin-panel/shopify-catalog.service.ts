import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import { KNOWN_VALE_PASS_PRODUCT_ID, KNOWN_VALE_PASS_VARIANT_ID, numericShopifyId } from '../vale-pass/vale-pass-order-status';
import { ShopifyAdminClient, type ShopifyCatalogVariant } from './shopify-admin.client';

export interface ShopifyMappedUnit {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly active: boolean;
  readonly reservableOnline: boolean;
  readonly countsTowardRentalDuration: boolean;
}

/**
 * SKU da variante no painel. A Shopify é a fonte; as peças guardam uma cópia
 * vinculada pelo `shopifyVariantId`, atualizada pela sincronização de catálogo
 * (webhook de produto + reconciliação periódica).
 *  - `synced`: a variante tem SKU e toda peça vinculada (não arquivada) já tem o mesmo;
 *  - `missing`: a variante está sem SKU na Shopify;
 *  - `pending`: alguma peça ainda guarda outro SKU — a próxima sincronização corrige.
 */
export type SkuSyncStatus = 'synced' | 'missing' | 'pending';

export interface ShopifyCatalogItem extends ShopifyCatalogVariant {
  readonly skuStatus: SkuSyncStatus;
  readonly mappedUnits: readonly ShopifyMappedUnit[];
  readonly physicalUnitsTotal: number;
  readonly physicalUnitsActive: number;
  readonly physicalUnitsReservableOnline: number;
}

export interface ImportShopifyUnitsInput {
  readonly shopifyVariantId: string;
  readonly codes: readonly string[];
  readonly reservableOnline?: boolean;
  readonly countsTowardRentalDuration?: boolean;
}

@Injectable()
export class ShopifyCatalogService {
  private readonly logger = new Logger(ShopifyCatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopify: ShopifyAdminClient,
  ) {}

  /**
   * Une catálogo COMERCIAL da Shopify com as unidades FÍSICAS do Postgres.
   * `inventoryQuantity` é só informativo: nunca vira RentalUnit automaticamente.
   * Uma variante pode representar N peças físicas e a operação escolhe N de
   * forma explícita pelo endpoint de importação.
   */
  async list(): Promise<ShopifyCatalogItem[]> {
    const variants = await this.shopify.listVariants();
    if (variants.length === 0) return [];

    let units: ShopifyMappedUnitWithVariant[];
    try {
      units = await this.prisma.rentalUnit.findMany({
        where: { shopifyVariantId: { in: variants.map((variant) => variant.id) } },
        select: {
          id: true,
          code: true,
          name: true,
          active: true,
          reservableOnline: true,
          countsTowardRentalDuration: true,
          shopifyVariantId: true,
          shopifySku: true,
          shopifyVariantMissingAt: true,
        },
        orderBy: { code: 'asc' },
      });
    } catch (err) {
      this.logger.error(`Falha ao cruzar catálogo Shopify com RentalUnits: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível carregar o vínculo das peças no momento.');
    }

    const byVariant = new Map<string, ShopifyMappedUnit[]>();
    // SKUs gravados nas peças não arquivadas de cada variante.
    const storedSkus = new Map<string, Set<string | null>>();
    for (const unit of units) {
      if (!unit.shopifyVariantId) continue;
      const list = byVariant.get(unit.shopifyVariantId) ?? [];
      list.push(stripVariantId(unit));
      byVariant.set(unit.shopifyVariantId, list);
      if (!unit.shopifyVariantMissingAt) {
        const skus = storedSkus.get(unit.shopifyVariantId) ?? new Set<string | null>();
        skus.add(unit.shopifySku?.trim() || null);
        storedSkus.set(unit.shopifyVariantId, skus);
      }
    }

    return variants.map((variant) => {
      const mappedUnits = byVariant.get(variant.id) ?? [];
      const pending = [...(storedSkus.get(variant.id) ?? [])].some((sku) => sku !== variant.sku);
      return {
        ...variant,
        skuStatus: !variant.sku ? 'missing' : pending ? 'pending' : 'synced',
        mappedUnits,
        physicalUnitsTotal: mappedUnits.length,
        physicalUnitsActive: mappedUnits.filter((unit) => unit.active).length,
        physicalUnitsReservableOnline: mappedUnits.filter((unit) => unit.active && unit.reservableOnline).length,
      };
    });
  }

  /** Variantes (só os dígitos) das campanhas de Valle Pass. */
  private async valePassCampaignVariantIds(): Promise<Set<string>> {
    try {
      const campaigns = await this.prisma.valePassCampaign.findMany({ select: { shopifyVariantId: true } });
      return new Set(campaigns.flatMap((c) => numericShopifyId(c.shopifyVariantId) ?? []));
    } catch (err) {
      this.logger.error(`Falha ao consultar campanhas de Valle Pass: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível validar as peças no momento.');
    }
  }

  async importUnits(
    input: ImportShopifyUnitsInput,
    adminUserId: string,
    adminUserName: string,
  ): Promise<readonly ShopifyMappedUnit[]> {
    const normalizedCodes = input.codes.map((code) => code.trim().toUpperCase());
    if (new Set(normalizedCodes).size !== normalizedCodes.length) {
      throw new BadRequestException('Há códigos de peça repetidos na mesma importação.');
    }

    const variant = await this.shopify.getVariant(input.shopifyVariantId);
    if (!variant) {
      throw new NotFoundException('Variante não encontrada na Shopify.');
    }

    // Valle Pass é compra direta: não tem peça física nem entra no aluguel — vale para o produto/variante
    // conhecidos e para as variantes de campanha cadastradas no módulo Valle Pass.
    const campaignVariants = await this.valePassCampaignVariantIds();
    if (
      numericShopifyId(variant.id) === KNOWN_VALE_PASS_VARIANT_ID ||
      numericShopifyId(variant.product.id) === KNOWN_VALE_PASS_PRODUCT_ID ||
      campaignVariants.has(numericShopifyId(variant.id) ?? '')
    ) {
      throw new BadRequestException('O Valle Pass é compra direta e não tem peças físicas. Cadastre peças apenas nos produtos de aluguel.');
    }

    const requestedOnline = input.reservableOnline ?? true;
    if (requestedOnline && variant.product.status !== 'ACTIVE') {
      throw new BadRequestException('Produto não está ativo na Shopify e não pode ser marcado como reservável online.');
    }

    const name = variantDisplayName(variant);
    try {
      await this.prisma.$transaction(async (tx) => {
        // Quem já usa o código? O código é único no banco. Peça ARQUIVADA pela
        // sincronização (fora de operação, só histórico) libera o código — como
        // a própria sincronização já faz ao seguir o SKU. Qualquer outra peça
        // continua dona do código: aí o cadastro é recusado dizendo QUEM é.
        const holders = await tx.rentalUnit.findMany({
          where: { code: { in: normalizedCodes } },
          select: { id: true, code: true, name: true, active: true, shopifyVariantId: true, shopifyVariantMissingAt: true },
        });
        const blocking = holders.filter((holder) => !holder.shopifyVariantMissingAt);
        if (blocking.length > 0) throw new ConflictException(conflictMessage(blocking, variant.id));
        for (const holder of holders) await releaseArchivedCode(tx, holder, adminUserId, adminUserName, variant.id);

        await tx.rentalUnit.createMany({
          data: normalizedCodes.map((code) => ({
            code,
            name,
            shopifyProductId: variant.product.id,
            shopifyVariantId: variant.id,
            shopifySku: variant.sku,
            active: true,
            reservableOnline: requestedOnline,
            countsTowardRentalDuration: input.countsTowardRentalDuration ?? true,
          })),
        });

        await writeAdminAuditEvent(tx, {
          adminUserId,
          adminUserName,
          action: 'SHOPIFY_UNITS_IMPORTED',
          entityType: 'ProductVariant',
          entityId: variant.id,
          detail: {
            productId: variant.product.id,
            productTitle: variant.product.title,
            variantTitle: variant.title,
            sku: variant.sku,
            codes: normalizedCodes,
            count: normalizedCodes.length,
          },
        });
      });
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      if (isPrismaUniqueViolation(err)) {
        throw new ConflictException('Um dos códigos foi cadastrado por outra operação. Atualize a página e tente novamente.');
      }
      this.logger.error(`Falha ao importar RentalUnits da Shopify: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível cadastrar as peças no momento.');
    }

    return this.prisma.rentalUnit.findMany({
      where: { code: { in: normalizedCodes } },
      select: {
        id: true,
        code: true,
        name: true,
        active: true,
        reservableOnline: true,
        countsTowardRentalDuration: true,
      },
      orderBy: { code: 'asc' },
    });
  }
}

type ShopifyMappedUnitWithVariant = ShopifyMappedUnit & {
  readonly shopifyVariantId: string | null;
  readonly shopifySku: string | null;
  readonly shopifyVariantMissingAt: Date | null;
};

function stripVariantId(unit: ShopifyMappedUnitWithVariant): ShopifyMappedUnit {
  return {
    id: unit.id,
    code: unit.code,
    name: unit.name,
    active: unit.active,
    reservableOnline: unit.reservableOnline,
    countsTowardRentalDuration: unit.countsTowardRentalDuration,
  };
}

interface CodeHolder {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly active: boolean;
  readonly shopifyVariantId: string | null;
}

/**
 * Recusa de código já usado. A mensagem diz que NADA foi cadastrado e quem é o
 * dono do código — antes só dizia "já cadastrado(s)", o que parecia sucesso.
 */
function conflictMessage(holders: readonly CodeHolder[], variantId: string): string {
  const parts = holders.map((holder) => {
    const where =
      holder.shopifyVariantId === variantId
        ? 'já cadastrada para esta mesma variante'
        : holder.shopifyVariantId
          ? 'vinculada a outra variante da Shopify'
          : 'sem vínculo com a Shopify';
    return `${holder.code} (peça «${holder.name}», ${holder.active ? 'ativa' : 'desativada'}, ${where})`;
  });
  return `Nada foi cadastrado: ${parts.length > 1 ? 'os códigos' : 'o código'} ${parts.join('; ')} já ${parts.length > 1 ? 'pertencem' : 'pertence'} a outra peça física. Use um código diferente ou ajuste a peça existente em Peças físicas.`;
}

/** Libera o código de uma peça ARQUIVADA pela sincronização: passa a `<código>-ARQ` (ou `-ARQ-2`…). Auditado. */
async function releaseArchivedCode(
  tx: Prisma.TransactionClient,
  holder: { id: string; code: string },
  adminUserId: string,
  adminUserName: string,
  variantId: string,
): Promise<void> {
  let freed = `${holder.code}-ARQ`;
  for (let n = 2; await tx.rentalUnit.findUnique({ where: { code: freed }, select: { id: true } }); n++) freed = `${holder.code}-ARQ-${n}`;
  const moved = await tx.rentalUnit.updateMany({
    where: { id: holder.id, code: holder.code, shopifyVariantMissingAt: { not: null } },
    data: { code: freed },
  });
  if (moved.count !== 1) throw new ConflictException('O código foi alterado por outra operação. Atualize a página e tente novamente.');
  await writeAdminAuditEvent(tx, {
    adminUserId,
    adminUserName,
    action: 'CATALOG_UNIT_CODE_RELEASED',
    entityType: 'RentalUnit',
    entityId: holder.id,
    before: { code: holder.code },
    after: { code: freed },
    detail: { origin: 'manual_units_import', reason: 'code_released_to_active_piece', code: holder.code, takenForVariant: variantId },
  });
}

function variantDisplayName(variant: ShopifyCatalogVariant): string {
  const variantTitle = variant.title.trim();
  return !variantTitle || variantTitle === 'Default Title'
    ? variant.product.title
    : `${variant.product.title} — ${variantTitle}`;
}

function isPrismaUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
