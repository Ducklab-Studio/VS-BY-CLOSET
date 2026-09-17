import { Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { AdminRole } from '@prisma/client';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireRole } from '../admin/require-role.decorator';
import { RequireModule } from '../admin/require-module.decorator';
import { AdminAuditService } from './audit.service';

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string; role: AdminRole };
}

/**
 * Sistema de autorização de funcionários — "auditoria" (@RequireModule)
 * é um módulo concedível a qualquer funcionário, mas o CONTEÚDO que ele
 * vê é filtrado por papel dentro de AdminAuditService.list(): ações
 * críticas (alteração/cancelamento/permissões/exclusão) e ações do
 * proprietário/perfil técnico nunca aparecem pra quem não é
 * SUPER_ADMIN — nunca escondidas do SUPER_ADMIN, nunca apagadas do
 * banco, só fora da resposta pra quem não pode ver.
 *
 * "Limpar logs" (clear) passa a ser exclusivo de SUPER_ADMIN — do
 * contrário um funcionário com o módulo concedido poderia esconder
 * eventos do próprio proprietário (o marcador AUDIT_CLEARED valia pra
 * todo mundo antes deste sistema existir).
 */
@Controller('admin/audit')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireModule('AUDIT')
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @Get()
  list(@Query('limit') limit?: string, @Req() req?: RequestWithAdminUser) {
    return this.audit.list({ limit: limit ? Number(limit) : undefined }, req!.adminUser!.role);
  }

  @Post('clear')
  @RequireRole('SUPER_ADMIN')
  clear(@Req() req: RequestWithAdminUser) {
    return this.audit.clear(req.adminUser!.id, req.adminUser!.name);
  }
}
