import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AdminModule, AdminRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REQUIRE_ROLE_KEY } from './require-role.decorator';
import { REQUIRE_MODULE_KEY } from './require-module.decorator';
import { hashSessionToken } from './admin-session-token';

interface RequestWithAdminUser {
  headers?: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  body: Record<string, unknown> | undefined;
  adminUser?: { id: string; name: string; role: AdminRole; active: boolean; isTechnical: boolean; moduleAccess: AdminModule[] };
}

/** SUPER_ADMIN (o proprietário) satisfaz qualquer `@RequireRole` mais
 *  abaixo na hierarquia — nunca o inverso. Único papel que passa por
 *  `@RequireRole('SUPER_ADMIN')`. */
function satisfiesRole(actual: AdminRole, required: AdminRole): boolean {
  if (actual === required) return true;
  return actual === 'SUPER_ADMIN' && required !== 'SUPER_ADMIN';
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

    // Handler primeiro, classe como fallback — MESMA resolução do módulo
    // logo abaixo. Sem o fallback de classe, `@RequireRole` declarado no
    // controller (admin-employees, blocks, reservation-archive) era
    // silenciosamente ignorado: `reflector.get` no handler devolve
    // undefined pra metadata que o SetMetadata gravou na classe, e o
    // guard seguia sem checar papel nenhum — um STAFF chegava a criar
    // funcionário ADMIN. Handler continua vencendo quando declara o seu.
    const requiredRole =
      this.reflector.get<AdminRole | undefined>(REQUIRE_ROLE_KEY, context.getHandler()) ??
      this.reflector.get<AdminRole | undefined>(REQUIRE_ROLE_KEY, context.getClass());
    if (requiredRole && !satisfiesRole(adminUser.role, requiredRole)) {
      throw new ForbiddenException(`Esta ação exige o papel ${requiredRole}.`);
    }

    // Módulo: verificado a nível de handler OU de controller (metadata
    // de classe também é lida pelo Reflector quando o handler não tem a
    // própria). SUPER_ADMIN nunca consulta moduleAccess — acesso total
    // by design (item do pedido: "Ele poderá criar, autorizar,
    // bloquear... funcionários" pressupõe visibilidade de tudo).
    const requiredModule =
      this.reflector.get<AdminModule | undefined>(REQUIRE_MODULE_KEY, context.getHandler()) ??
      this.reflector.get<AdminModule | undefined>(REQUIRE_MODULE_KEY, context.getClass());
    if (requiredModule && adminUser.role !== 'SUPER_ADMIN' && !adminUser.moduleAccess.includes(requiredModule)) {
      throw new ForbiddenException(`Esta ação exige acesso ao módulo ${requiredModule}.`);
    }

    request.adminUser = {
      id: adminUser.id,
      name: adminUser.name,
      role: adminUser.role,
      active: adminUser.active,
      isTechnical: adminUser.isTechnical,
      moduleAccess: adminUser.moduleAccess,
    };
    return true;
  }
}
