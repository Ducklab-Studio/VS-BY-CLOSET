import { Controller, Get, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireModule } from '../admin/require-module.decorator';
import { ValePassLaunchReadinessService } from './vale-pass-launch-readiness.service';
import type { LaunchChecklist } from './vale-pass-launch-checklist';

/**
 * Painel "Pronta para vender?". Apenas GET: não existe rota para abrir vendas, mexer em estoque ou ligar chaves. Leitura liberada a quem tem o módulo
 * VALLE_PASS (mesmo padrão das demais telas de consulta do Valle Pass); a autenticação administrativa e a sessão continuam obrigatórias.
 */
@Controller('admin/vale-pass/launch-readiness')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireModule('VALLE_PASS')
export class ValePassLaunchReadinessController {
  constructor(private readonly readiness: ValePassLaunchReadinessService) {}

  @Get()
  snapshot(@Query('campaignId', new ParseUUIDPipe({ optional: true })) campaignId?: string): Promise<LaunchChecklist> {
    return this.readiness.snapshot(campaignId);
  }
}
