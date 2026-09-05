import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AdminRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REQUIRE_ROLE_KEY } from './require-role.decorator';

interface RequestWithAdminUser {
  query: Record<string, unknown>;
  body: Record<string, unknown> | undefined;
  adminUser?: { id: string; name: string; role: AdminRole; active: boolean };
}

/**
 * Item 15 da Fase 9: "Backend precisa validar role em TODA ação
 * protegida" — nunca confiar que o apps/marketing já escondeu o botão.
 * Este guard roda DEPOIS do `AdminAuthGuard` (bearer — confirma que quem
 * chama é o servidor do apps/marketing, nunca o navegador direto) e
 * re-verifica o `adminUserId` recebido contra o banco NA HORA — nunca
 * confia num "role" que o chamador afirme, só no que está gravado agora
 * em `admin_users` (fail closed se o usuário foi desativado entre a
 * criação da sessão e esta chamada).
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

    const adminUser = await this.prisma.adminUser.findUnique({ where: { id: adminUserId } });
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
