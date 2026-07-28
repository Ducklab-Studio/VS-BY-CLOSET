import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@loja/database';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';

@Injectable()
export class CouponsService {
  constructor(private prisma: PrismaService) {}

  async findAll(search?: string) {
    return this.prisma.coupon.findMany({
      where: search ? { code: { contains: search, mode: 'insensitive' } } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const coupon = await this.prisma.coupon.findUnique({ where: { id } });
    if (!coupon) throw new NotFoundException('Cupom não encontrado.');
    return coupon;
  }

  async create(dto: CreateCouponDto) {
    const code = dto.code.toUpperCase().trim();
    await this.ensureCodeAvailable(code);
    const { startsAt, expiresAt, ...rest } = dto;
    return this.prisma.coupon.create({
      data: {
        ...rest,
        code,
        ...(startsAt && { startsAt: new Date(startsAt) }),
        ...(expiresAt && { expiresAt: new Date(expiresAt) }),
      },
    });
  }

  async update(id: string, dto: UpdateCouponDto) {
    await this.findOne(id);
    const code = dto.code ? dto.code.toUpperCase().trim() : undefined;
    if (code) await this.ensureCodeAvailable(code, id);
    const { startsAt, expiresAt, ...rest } = dto;
    return this.prisma.coupon.update({
      where: { id },
      data: {
        ...rest,
        ...(code && { code }),
        ...(startsAt && { startsAt: new Date(startsAt) }),
        ...(expiresAt && { expiresAt: new Date(expiresAt) }),
      },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    try {
      await this.prisma.coupon.delete({ where: { id } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        throw new ConflictException('Este cupom já foi usado em pedidos e não pode ser excluído.');
      }
      throw err;
    }
    return { success: true };
  }

  private async ensureCodeAvailable(code: string, ignoreId?: string) {
    const existing = await this.prisma.coupon.findUnique({ where: { code } });
    if (existing && existing.id !== ignoreId) {
      throw new ConflictException('Já existe um cupom com este código.');
    }
  }
}
