import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReviewStatus } from '@loja/database';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReviewsService {
  constructor(private prisma: PrismaService) {}

  async findAllAdmin(params: { status?: string; page?: number; limit?: number }) {
    const page = params.page ?? 1;
    const limit = Math.min(params.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const where: Prisma.ReviewWhereInput = {
      ...(params.status && { status: params.status as ReviewStatus }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.review.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          user: { select: { name: true, email: true } },
          product: { select: { name: true, slug: true } },
        },
      }),
      this.prisma.review.count({ where }),
    ]);

    return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async moderate(id: string, status: ReviewStatus, storeReply?: string) {
    const review = await this.prisma.review.findUnique({ where: { id } });
    if (!review) throw new NotFoundException('Avaliação não encontrada.');

    const updated = await this.prisma.review.update({
      where: { id },
      data: { status, ...(storeReply !== undefined && { storeReply }) },
    });

    await this.recalculateProductRating(review.productId);
    return updated;
  }

  /** Recalcula média e contagem do produto a partir das avaliações aprovadas. */
  private async recalculateProductRating(productId: string) {
    const stats = await this.prisma.review.aggregate({
      where: { productId, status: ReviewStatus.APPROVED },
      _avg: { rating: true },
      _count: true,
    });

    await this.prisma.product.update({
      where: { id: productId },
      data: {
        ratingAvg: stats._avg.rating ?? 0,
        ratingCount: stats._count,
      },
    });
  }
}
