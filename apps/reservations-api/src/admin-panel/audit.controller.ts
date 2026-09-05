import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireRole } from '../admin/require-role.decorator';
import { AdminAuditService } from './audit.service';

/** Item 14 — "auditoria completa" é exclusiva de ADMIN no RBAC da Fase 9. */
@Controller('admin/audit')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireRole('ADMIN')
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @Get()
  list(@Query('limit') limit?: string) {
    return this.audit.list({ limit: limit ? Number(limit) : undefined });
  }
}
