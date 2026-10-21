import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AdminRole } from '@prisma/client';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireModule } from '../admin/require-module.decorator';
import { RequireRole } from '../admin/require-role.decorator';
import { ValePassCancellationAlertsService, type CancellationAlertView } from './cancellation-alerts.service';

class AcknowledgeAlertDto {
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  note!: string;
}

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string; role: AdminRole };
}

const LIMIT = { default: { limit: 30, ttl: 60_000 } };

/** Alertas de pedido cancelado/reembolsado com crédito já utilizado. Consulta: módulo Valle Pass; conferência: ADMIN (só registra a conferência — nada mais muda). */
@Controller('admin/vale-pass/cancellation-alerts')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireModule('VALLE_PASS')
export class ValePassCancellationAlertsController {
  constructor(private readonly alerts: ValePassCancellationAlertsService) {}

  @Get()
  @Throttle(LIMIT)
  list(@Query('status') status?: string, @Query('campaignId') campaignId?: string): Promise<CancellationAlertView[]> {
    return this.alerts.list(status === 'ACKNOWLEDGED' || status === 'ALL' ? status : 'OPEN', campaignId && /^[0-9a-f-]{36}$/i.test(campaignId) ? campaignId : undefined);
  }

  @Post(':id/acknowledge')
  @HttpCode(200)
  @RequireRole('ADMIN')
  @Throttle(LIMIT)
  acknowledge(@Param('id') id: string, @Body() dto: AcknowledgeAlertDto, @Req() req: RequestWithAdminUser): Promise<CancellationAlertView> {
    const user = req.adminUser!;
    return this.alerts.acknowledge(id, dto.note, { id: user.id, name: user.name, role: user.role });
  }
}
