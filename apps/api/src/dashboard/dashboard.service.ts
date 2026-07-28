import { Injectable } from '@nestjs/common';
import { OrderStatus, ProductStatus, ReviewStatus } from '@loja/database';
import { PrismaService } from '../prisma/prisma.service';

/** Status que representam uma venda efetivada (contam como receita). */
const REVENUE_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.SEPARATING,
  OrderStatus.INVOICED,
  OrderStatus.SHIPPED,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DELIVERED,
];

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async getStats() {
    const now = new Date();
    const startOf30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const startOfPrev30d = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const [
      revenueAll,
      revenue30d,
      revenuePrev30d,
      ordersTotal,
      orders30d,
      customersTotal,
      customers30d,
      productsActive,
      ordersByStatus,
      pendingReviews,
    ] = await Promise.all([
      this.prisma.order.aggregate({
        where: { status: { in: REVENUE_STATUSES } },
        _sum: { total: true },
      }),
      this.prisma.order.aggregate({
        where: { status: { in: REVENUE_STATUSES }, createdAt: { gte: startOf30d } },
        _sum: { total: true },
        _count: true,
      }),
      this.prisma.order.aggregate({
        where: {
          status: { in: REVENUE_STATUSES },
          createdAt: { gte: startOfPrev30d, lt: startOf30d },
        },
        _sum: { total: true },
      }),
      this.prisma.order.count(),
      this.prisma.order.count({ where: { createdAt: { gte: startOf30d } } }),
      this.prisma.user.count({ where: { role: 'CUSTOMER' } }),
      this.prisma.user.count({ where: { role: 'CUSTOMER', createdAt: { gte: startOf30d } } }),
      this.prisma.product.count({ where: { status: ProductStatus.ACTIVE } }),
      this.prisma.order.groupBy({ by: ['status'], _count: true }),
      this.prisma.review.count({ where: { status: ReviewStatus.PENDING } }),
    ]);

    const current = Number(revenue30d._sum.total ?? 0);
    const previous = Number(revenuePrev30d._sum.total ?? 0);
    const revenueChangePct = previous > 0 ? ((current - previous) / previous) * 100 : null;

    return {
      revenue: {
        total: Number(revenueAll._sum.total ?? 0),
        last30d: current,
        changePct: revenueChangePct,
      },
      orders: {
        total: ordersTotal,
        last30d: orders30d,
        paid30d: revenue30d._count,
        byStatus: ordersByStatus.map((s) => ({ status: s.status, count: s._count })),
      },
      customers: { total: customersTotal, last30d: customers30d },
      products: { active: productsActive },
      pendingReviews,
    };
  }

  /** Série de receita e pedidos por dia nos últimos N dias. */
  async getRevenueSeries(days = 30) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));

    const orders = await this.prisma.order.findMany({
      where: { status: { in: REVENUE_STATUSES }, createdAt: { gte: start } },
      select: { total: true, createdAt: true },
    });

    const buckets = new Map<string, { revenue: number; orders: number }>();
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      buckets.set(d.toISOString().slice(0, 10), { revenue: 0, orders: 0 });
    }

    for (const order of orders) {
      const key = order.createdAt.toISOString().slice(0, 10);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.revenue += Number(order.total);
        bucket.orders += 1;
      }
    }

    return Array.from(buckets.entries()).map(([date, v]) => ({ date, ...v }));
  }

  /** Produtos mais vendidos (por quantidade em pedidos com venda efetivada). */
  async getTopProducts(limit = 5) {
    const grouped = await this.prisma.orderItem.groupBy({
      by: ['productName', 'sku'],
      where: { order: { status: { in: REVENUE_STATUSES } } },
      _sum: { quantity: true, total: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: limit,
    });

    return grouped.map((g) => ({
      name: g.productName,
      sku: g.sku,
      quantity: g._sum.quantity ?? 0,
      revenue: Number(g._sum.total ?? 0),
    }));
  }

  /** Variantes com estoque abaixo do limite de alerta. */
  async getLowStock(limit = 10) {
    const inventories = await this.prisma.inventory.findMany({
      orderBy: { quantity: 'asc' },
      take: limit * 3,
      include: {
        variant: {
          select: {
            sku: true,
            color: true,
            size: true,
            product: { select: { name: true, slug: true } },
          },
        },
      },
    });

    return inventories
      .filter((inv) => inv.quantity <= inv.lowStockAt)
      .slice(0, limit)
      .map((inv) => ({
        sku: inv.variant.sku,
        productName: inv.variant.product.name,
        color: inv.variant.color,
        size: inv.variant.size,
        quantity: inv.quantity,
        lowStockAt: inv.lowStockAt,
      }));
  }

  async getRecentOrders(limit = 8) {
    return this.prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        number: true,
        status: true,
        total: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
      },
    });
  }
}
