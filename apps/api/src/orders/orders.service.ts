import { Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma } from '@loja/database';
import { PrismaService } from '../prisma/prisma.service';
import { QueryAdminOrdersDto } from './dto/query-admin-orders.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';

@Injectable()
export class OrdersService {
  constructor(private prisma: PrismaService) {}

  async findAllAdmin(q: QueryAdminOrdersDto) {
    const page = q.page ?? 1;
    const limit = Math.min(q.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const where: Prisma.OrderWhereInput = {
      ...(q.status && { status: q.status as OrderStatus }),
      ...(q.search && {
        OR: [
          { number: { contains: q.search, mode: 'insensitive' } },
          { user: { name: { contains: q.search, mode: 'insensitive' } } },
          { user: { email: { contains: q.search, mode: 'insensitive' } } },
        ],
      }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          user: { select: { name: true, email: true } },
          _count: { select: { items: true } },
        },
      }),
      this.prisma.order.count({ where }),
    ]);

    return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async findOneAdmin(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true } },
        items: true,
        payments: true,
        shippingAddress: true,
        billingAddress: true,
        coupon: { select: { code: true, type: true, value: true } },
        statusHistory: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!order) throw new NotFoundException('Pedido não encontrado.');
    return order;
  }

  async updateStatus(id: string, dto: UpdateOrderStatusDto, changedBy: string) {
    await this.findOneAdmin(id);

    const [order] = await this.prisma.$transaction([
      this.prisma.order.update({
        where: { id },
        data: {
          status: dto.status as OrderStatus,
          ...(dto.trackingCode && { trackingCode: dto.trackingCode }),
          ...(dto.shippingCarrier && { shippingCarrier: dto.shippingCarrier }),
          ...(dto.estimatedAt && { estimatedAt: new Date(dto.estimatedAt) }),
        },
      }),
      this.prisma.orderStatusHistory.create({
        data: {
          orderId: id,
          status: dto.status as OrderStatus,
          note: dto.note,
          changedBy,
        },
      }),
    ]);

    return order;
  }
}
