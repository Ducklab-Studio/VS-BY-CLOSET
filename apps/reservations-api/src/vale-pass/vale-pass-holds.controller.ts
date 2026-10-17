import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireRole } from '../admin/require-role.decorator';
import { RequireModule } from '../admin/require-module.decorator';
import { ValePassHoldsService, type HoldItem, type HoldProjection } from './vale-pass-holds.service';
import { HoldActionDto, IssueHoldDto } from './dto/vale-pass-benefits.dto';

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string };
}

/**
 * Fila de resolução de pagamentos sem emissão. Ver a fila: qualquer perfil com o módulo VALLE_PASS (é um alerta operacional); resolver
 * (emitir excedente aprovado ou descartar): só ADMIN, com justificativa e auditoria. Nada aqui reembolsa ou cancela pedido.
 */
@Controller('admin/vale-pass/holds')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireModule('VALLE_PASS')
export class ValePassHoldsController {
  constructor(private readonly holds: ValePassHoldsService) {}

  @Get()
  list(@Query('includeResolved') includeResolved?: string): Promise<HoldItem[]> {
    return this.holds.list({ includeResolved: includeResolved === 'true' });
  }

  /** Números da confirmação reforçada (limite, consumo de hoje, total projetado). Somente leitura. */
  @Get(':id/preview')
  @RequireRole('ADMIN')
  preview(@Param('id', ParseUUIDPipe) id: string): Promise<HoldProjection> {
    return this.holds.preview(id);
  }

  @Post(':id/issue')
  @RequireRole('ADMIN')
  issue(@Param('id', ParseUUIDPipe) id: string, @Body() dto: IssueHoldDto, @Req() req: RequestWithAdminUser): Promise<HoldItem> {
    return this.holds.issue(id, { note: dto.note, confirmTotal: dto.confirmTotal, expected: dto.expected }, req.adminUser!.id, req.adminUser!.name);
  }

  @Post(':id/dismiss')
  @RequireRole('ADMIN')
  dismiss(@Param('id', ParseUUIDPipe) id: string, @Body() dto: HoldActionDto, @Req() req: RequestWithAdminUser): Promise<HoldItem> {
    return this.holds.dismiss(id, dto.note, req.adminUser!.id, req.adminUser!.name);
  }
}
