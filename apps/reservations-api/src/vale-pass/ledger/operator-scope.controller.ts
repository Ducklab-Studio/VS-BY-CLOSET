import { Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AdminRole } from '@prisma/client';
import { AdminAuthGuard } from '../../admin/admin-auth.guard';
import { AdminRoleGuard } from '../../admin/admin-role.guard';
import { RequireRole } from '../../admin/require-role.decorator';
import { ValePassOperatorScopeService, type OperatorScopeView } from './operator-scope.service';

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string; role: AdminRole };
}
const actorOf = (req: RequestWithAdminUser) => ({ id: req.adminUser!.id, name: req.adminUser!.name, role: req.adminUser!.role });

const LIMIT = { default: { limit: 30, ttl: 60_000 } };

/**
 * Vínculo operador↔estabelecimento do Valle Pass: SOMENTE o proprietário (SUPER_ADMIN), validado no guard E no serviço. Nada é concedido por padrão;
 * quem opera cada loja é decisão do proprietário/Anderson. Conceder e revogar são idempotentes e auditados (ações críticas).
 */
@Controller('admin/vale-pass/operators')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireRole('SUPER_ADMIN')
export class ValePassOperatorScopeController {
  constructor(private readonly scopes: ValePassOperatorScopeService) {}

  @Get(':adminUserId/companies')
  @Throttle(LIMIT)
  view(@Param('adminUserId') adminUserId: string, @Req() req: RequestWithAdminUser): Promise<OperatorScopeView> {
    return this.scopes.view(adminUserId, actorOf(req));
  }

  @Post(':adminUserId/companies/:company/grant')
  @HttpCode(200)
  @Throttle(LIMIT)
  grant(@Param('adminUserId') adminUserId: string, @Param('company') company: string, @Req() req: RequestWithAdminUser) {
    return this.scopes.grant(adminUserId, company, actorOf(req));
  }

  @Post(':adminUserId/companies/:company/revoke')
  @HttpCode(200)
  @Throttle(LIMIT)
  revoke(@Param('adminUserId') adminUserId: string, @Param('company') company: string, @Req() req: RequestWithAdminUser) {
    return this.scopes.revoke(adminUserId, company, actorOf(req));
  }
}
