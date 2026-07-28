import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InventoryMovementType, Prisma, ProductStatus } from '@loja/database';
import { PrismaService } from '../prisma/prisma.service';
import { slugify } from '../common/utils/slugify';
import { QueryAdminProductsDto } from './dto/query-admin-products.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { CreateVariantDto, UpdateVariantDto } from './dto/variant.dto';
import { CreateMediaDto } from './dto/media.dto';
import { AdjustInventoryDto } from './dto/adjust-inventory.dto';

@Injectable()
export class AdminProductsService {
  constructor(private prisma: PrismaService) {}

  async findAll(q: QueryAdminProductsDto) {
    const page = q.page ?? 1;
    const limit = Math.min(q.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const where: Prisma.ProductWhereInput = {
      ...(q.status && { status: q.status as ProductStatus }),
      ...(q.search && {
        OR: [
          { name: { contains: q.search, mode: 'insensitive' } },
          { sku: { contains: q.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          brand: { select: { name: true } },
          media: { orderBy: { position: 'asc' }, take: 1 },
          variants: { include: { inventory: true } },
        },
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        brand: true,
        categories: { include: { category: true } },
        media: { orderBy: { position: 'asc' } },
        variants: { include: { inventory: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!product) throw new NotFoundException('Produto não encontrado.');
    return product;
  }

  async create(dto: CreateProductDto) {
    const slug = dto.slug ? slugify(dto.slug) : slugify(dto.name);
    await this.ensureUnique({ slug, sku: dto.sku });

    const { categoryIds, ...data } = dto;
    return this.prisma.product.create({
      data: {
        ...data,
        slug,
        ...(categoryIds && {
          categories: { create: categoryIds.map((categoryId) => ({ categoryId })) },
        }),
      },
      include: { media: true, variants: true, categories: true },
    });
  }

  async update(id: string, dto: UpdateProductDto) {
    await this.findOne(id);
    const slug = dto.slug ? slugify(dto.slug) : undefined;
    await this.ensureUnique({ slug, sku: dto.sku, ignoreId: id });

    const { categoryIds, ...data } = dto;
    return this.prisma.product.update({
      where: { id },
      data: {
        ...data,
        ...(slug && { slug }),
        ...(categoryIds && {
          categories: {
            deleteMany: {},
            create: categoryIds.map((categoryId) => ({ categoryId })),
          },
        }),
      },
      include: { media: true, variants: { include: { inventory: true } }, categories: true },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.product.delete({ where: { id } });
    return { success: true };
  }

  // ── Variantes ────────────────────────────────────────────────────────────

  async addVariant(productId: string, dto: CreateVariantDto) {
    await this.findOne(productId);
    const existingSku = await this.prisma.productVariant.findUnique({ where: { sku: dto.sku } });
    if (existingSku) throw new ConflictException('Já existe uma variante com este SKU.');

    const { initialQuantity, lowStockAt, ...data } = dto;
    return this.prisma.productVariant.create({
      data: {
        ...data,
        productId,
        inventory: {
          create: { quantity: initialQuantity ?? 0, lowStockAt: lowStockAt ?? 5 },
        },
      },
      include: { inventory: true },
    });
  }

  async updateVariant(productId: string, variantId: string, dto: UpdateVariantDto) {
    const variant = await this.getVariant(productId, variantId);
    if (dto.sku && dto.sku !== variant.sku) {
      const existingSku = await this.prisma.productVariant.findUnique({ where: { sku: dto.sku } });
      if (existingSku) throw new ConflictException('Já existe uma variante com este SKU.');
    }
    return this.prisma.productVariant.update({
      where: { id: variantId },
      data: dto,
      include: { inventory: true },
    });
  }

  async removeVariant(productId: string, variantId: string) {
    await this.getVariant(productId, variantId);
    await this.prisma.productVariant.delete({ where: { id: variantId } });
    return { success: true };
  }

  // ── Estoque ──────────────────────────────────────────────────────────────

  async adjustInventory(productId: string, variantId: string, dto: AdjustInventoryDto) {
    const variant = await this.getVariant(productId, variantId);
    const current = variant.inventory?.quantity ?? 0;
    const delta = dto.quantity - current;

    const [, movement] = await this.prisma.$transaction([
      this.prisma.inventory.upsert({
        where: { variantId },
        create: { variantId, quantity: dto.quantity, lowStockAt: dto.lowStockAt ?? 5 },
        update: { quantity: dto.quantity, ...(dto.lowStockAt != null && { lowStockAt: dto.lowStockAt }) },
      }),
      this.prisma.inventoryMovement.create({
        data: {
          variantId,
          type: InventoryMovementType.ADJUSTMENT,
          quantity: delta,
          reason: dto.reason ?? 'Ajuste manual (admin)',
        },
      }),
    ]);

    return { inventory: await this.prisma.inventory.findUnique({ where: { variantId } }), movement };
  }

  // ── Mídia ────────────────────────────────────────────────────────────────

  async addMedia(productId: string, dto: CreateMediaDto) {
    await this.findOne(productId);
    return this.prisma.productMedia.create({
      data: { ...dto, productId },
    });
  }

  async removeMedia(productId: string, mediaId: string) {
    const media = await this.prisma.productMedia.findUnique({ where: { id: mediaId } });
    if (!media || media.productId !== productId) {
      throw new NotFoundException('Mídia não encontrada.');
    }
    await this.prisma.productMedia.delete({ where: { id: mediaId } });
    return { success: true };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async getVariant(productId: string, variantId: string) {
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      include: { inventory: true },
    });
    if (!variant || variant.productId !== productId) {
      throw new NotFoundException('Variante não encontrada.');
    }
    return variant;
  }

  private async ensureUnique(params: { slug?: string; sku?: string; ignoreId?: string }) {
    const { slug, sku, ignoreId } = params;
    if (slug) {
      const existing = await this.prisma.product.findUnique({ where: { slug } });
      if (existing && existing.id !== ignoreId) {
        throw new ConflictException('Já existe um produto com este slug.');
      }
    }
    if (sku) {
      const existing = await this.prisma.product.findUnique({ where: { sku } });
      if (existing && existing.id !== ignoreId) {
        throw new ConflictException('Já existe um produto com este SKU.');
      }
    }
  }
}
