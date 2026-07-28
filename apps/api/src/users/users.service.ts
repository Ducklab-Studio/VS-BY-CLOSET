import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@loja/database';
import { PrismaService } from '../prisma/prisma.service';
import { QueryAdminUsersDto } from './dto/query-admin-users.dto';
import { UpdateUserAdminDto } from './dto/update-user-admin.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findAllAdmin(q: QueryAdminUsersDto) {
    const page = q.page ?? 1;
    const limit = Math.min(q.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const where: Prisma.UserWhereInput = {
      ...(q.role && { role: q.role as Role }),
      ...(q.status && { status: q.status as UserStatus }),
      ...(q.search && {
        OR: [
          { name: { contains: q.search, mode: 'insensitive' } },
          { email: { contains: q.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
          _count: { select: { orders: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async findOneAdmin(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        cpf: true,
        role: true,
        status: true,
        createdAt: true,
        lastLoginAt: true,
        orders: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { id: true, number: true, status: true, total: true, createdAt: true },
        },
        addresses: true,
      },
    });
    if (!user) throw new NotFoundException('Usuário não encontrado.');
    return user;
  }

  async updateAdmin(id: string, dto: UpdateUserAdminDto) {
    await this.findOneAdmin(id);
    return this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.role && { role: dto.role as Role }),
        ...(dto.status && { status: dto.status as UserStatus }),
      },
      select: { id: true, name: true, email: true, role: true, status: true },
    });
  }

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        cpf: true,
        role: true,
        status: true,
        avatarUrl: true,
        createdAt: true,
      },
    });
    if (!user) throw new NotFoundException('Usuário não encontrado.');
    return user;
  }

  async updateProfile(id: string, data: { name?: string; phone?: string }) {
    return this.prisma.user.update({
      where: { id },
      data,
      select: { id: true, name: true, email: true, phone: true },
    });
  }
}
