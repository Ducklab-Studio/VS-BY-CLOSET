import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AdminRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REQUIRE_ROLE_KEY } from './require-role.decorator';
import { hashSessionToken } from './admin-session-token';

interface RequestWithAdminUser {
  headers?: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  body: Record<string, unknown> | undefined;
  adminUser?: { id: string; name: string; role: AdminRole; active: boolean };
}

/**
 * After server authentication, bind the claimed identity to a live session.
 * Active status and role are read from PostgreSQL on every request.
 */
@Injectable()
export class AdminRoleGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithAdminUser>();
    const adminUserId = (request.query?.adminUserId as string | undefined) ?? (request.body?.adminUserId as string | undefined);

    if (!adminUserId || typeof adminUserId !== 'string') {
      throw new UnauthorizedException('adminUserId ausente.');
    }

    const token = request.headers?.['x-admin-session'];
    if (typeof token !== 'string' || !token || token.length > 256) throw new UnauthorizedException('Sessão administrativa inválida.');
    const session = await this.prisma.adminSession.findUnique({ where: { tokenHash: hashSessionToken(token) }, include: { adminUser: true } });
    if (!session || session.adminUserId !== adminUserId || session.revokedAt || session.expiresAt <= new Date()) {
      throw new UnauthorizedException('Sessão administrativa inválida.');
    }
    const adminUser = session.adminUser;
    if (!adminUser || !adminUser.active) {
      throw new UnauthorizedException('Usuário administrativo inválido ou inativo.');
    }

    const requiredRole = this.reflector.get<AdminRole | undefined>(REQUIRE_ROLE_KEY, context.getHandler());
    if (requiredRole && adminUser.role !== requiredRole) {
      throw new ForbiddenException(`Esta ação exige o papel ${requiredRole}.`);
    }

    request.adminUser = { id: adminUser.id, name: adminUser.name, role: adminUser.role, active: adminUser.active };
    return true;
  }
}
