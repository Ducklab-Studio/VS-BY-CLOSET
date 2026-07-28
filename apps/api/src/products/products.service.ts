import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProductStatus } from '@loja/database';
import { PrismaService } from '../prisma/prisma.service';
import { QueryProductsDto } from './dto/query-products.dto';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  /** Catálogo público com busca, filtros, ordenação e paginação. */
  async findAll(q: QueryProductsDto) {
    const page = q.page ?? 1;
    const limit = Math.min(q.limit ?? 12, 48);
    const skip = (page - 1) * limit;

    const where: Prisma.ProductWhereInput = {
      status: ProductStatus.ACTIVE,
      ...(q.search && {
        OR: [
          { name: { contains: q.search, mode: 'insensitive' } },
          { description: { contains: q.search, mode: 'insensitive' } },
          { sku: { contains: q.search, mode: 'insensitive' } },
        ],
      }),
      ...(q.category && { categories: { some: { category: { slug: q.category } } } }),
      ...(q.brand && { brand: { slug: q.brand } }),
      ...(q.color && { variants: { some: { color: { contains: q.color, mode: 'insensitive' } } } }),
      ...(q.size && { variants: { some: { size: q.size } } }),
      ...((q.minPrice != null || q.maxPrice != null) && {
        price: {
          ...(q.minPrice != null && { gte: q.minPrice }),
          ...(q.maxPrice != null && { lte: q.maxPrice }),
        },
      }),
      ...(q.onSale === 'true' && { promoPrice: { not: null } }),
    };

    const orderBy = this.buildOrderBy(q.sort);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        include: {
          brand: { select: { name: true, slug: true } },
          media: { orderBy: { position: 'asc' }, take: 1 },
        },
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      items,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Página individual do produto (com variações, mídia, relacionados, avaliações). */
  async findBySlug(slug: string) {
    const product = await this.prisma.product.findUnique({
      where: { slug },
      include: {
        brand: true,
        categories: { include: { category: true } },
        media: { orderBy: { position: 'asc' } },
        variants: { where: { isActive: true }, include: { inventory: true } },
        reviews: {
          where: { status: 'APPROVED' },
          include: { user: { select: { name: true } } },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        related: { include: { related: { include: { media: { take: 1 } } } } },
      },
    });
    if (!product || product.status !== ProductStatus.ACTIVE) {
      throw new NotFoundException('Produto não encontrado.');
    }
    return product;
  }

  /** Autocomplete da busca. */
  async autocomplete(term: string) {
    if (!term || term.length < 2) return [];
    return this.prisma.product.findMany({
      where: {
        status: ProductStatus.ACTIVE,
        name: { contains: term, mode: 'insensitive' },
      },
      select: { name: true, slug: true },
      take: 8,
    });
  }

  private buildOrderBy(sort?: string): Prisma.ProductOrderByWithRelationInput {
    switch (sort) {
      case 'price_asc':
        return { price: 'asc' };
      case 'price_desc':
        return { price: 'desc' };
      case 'best_selling':
        return { soldCount: 'desc' };
      case 'rating':
        return { ratingAvg: 'desc' };
      default:
        return { createdAt: 'desc' };
    }
  }
}
