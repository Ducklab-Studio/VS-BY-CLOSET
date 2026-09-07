import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import { ShopifyAdminClient, type ShopifyCatalogVariant } from './shopify-admin.client';

export interface ShopifyMappedUnit {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly active: boolean;
  readonly reservableOnline: boolean;
  readonly countsTowardRentalDuration: boolean;
}

export interface ShopifyCatalogItem extends ShopifyCatalogVariant {
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
        },
        orderBy: { code: 'asc' },
      });
    } catch (err) {
      this.logger.error(`Falha ao cruzar catálogo Shopify com RentalUnits: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível carregar o vínculo das peças no momento.');
    }

    const byVariant = new Map<string, ShopifyMappedUnit[]>();
    for (const unit of units) {
      if (!unit.shopifyVariantId) continue;
      const list = byVariant.get(unit.shopifyVariantId) ?? [];
      list.push(stripVariantId(unit));
      byVariant.set(unit.shopifyVariantId, list);
    }

    return variants.map((variant) => {
      const mappedUnits = byVariant.get(variant.id) ?? [];
      return {
        ...variant,
        mappedUnits,
        physicalUnitsTotal: mappedUnits.length,
        physicalUnitsActive: mappedUnits.filter((unit) => unit.active).length,
        physicalUnitsReservableOnline: mappedUnits.filter((unit) => unit.active && unit.reservableOnline).length,
      };
    });
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

    const requestedOnline = input.reservableOnline ?? true;
    if (requestedOnline && variant.product.status !== 'ACTIVE') {
      throw new BadRequestException('Produto não está ativo na Shopify e não pode ser marcado como reservável online.');
    }

    let existingCodes: { code: string }[];
    try {
      existingCodes = await this.prisma.rentalUnit.findMany({
        where: { code: { in: normalizedCodes } },
        select: { code: true },
      });
    } catch (err) {
      this.logger.error(`Falha ao validar códigos de RentalUnit: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível validar as peças no momento.');
    }

    if (existingCodes.length > 0) {
      throw new ConflictException(`Código(s) já cadastrado(s): ${existingCodes.map((item) => item.code).join(', ')}`);
    }

    const name = variantDisplayName(variant);
    try {
      await this.prisma.$transaction(async (tx) => {
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

type ShopifyMappedUnitWithVariant = ShopifyMappedUnit & { readonly shopifyVariantId: string | null };

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
