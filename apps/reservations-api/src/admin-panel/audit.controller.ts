import { Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireRole } from '../admin/require-role.decorator';
import { AdminAuditService } from './audit.service';

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string };
}

/** Auditoria completa é exclusiva de ADMIN. */
@Controller('admin/audit')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireRole('ADMIN')
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @Get()
  list(@Query('limit') limit?: string) {
    return this.audit.list({ limit: limit ? Number(limit) : undefined });
  }

  @Post('clear')
  clear(@Req() req: RequestWithAdminUser) {
    return this.audit.clear(req.adminUser!.id, req.adminUser!.name);
  }
}
