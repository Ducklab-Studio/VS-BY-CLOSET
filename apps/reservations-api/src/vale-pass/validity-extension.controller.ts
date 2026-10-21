import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AdminRole } from '@prisma/client';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireRole } from '../admin/require-role.decorator';
import { ConfirmValidityExtensionDto, PrepareValidityExtensionDto } from './dto/validity-extension.dto';
import { ValePassValidityExtensionService, type ExtensionPreview, type ExtensionResult, type ExtensionView } from './validity-extension.service';

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string; role: AdminRole };
}
const actorOf = (req: RequestWithAdminUser) => ({ id: req.adminUser!.id, name: req.adminUser!.name, role: req.adminUser!.role });
const LIMIT = { default: { limit: 20, ttl: 60_000 } };

/**
 * Prorrogação coletiva da validade dos vouchers de uma campanha: SOMENTE o proprietário (SUPER_ADMIN), validado no guard E no serviço. Duas etapas (prévia sem gravar e
 * confirmação com justificativa, nova data redigitada e contagem vista). Nenhuma data é sugerida pelo sistema.
 */
@Controller('admin/vale-pass/campaigns/:campaignId/validity-extension')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireRole('SUPER_ADMIN')
export class ValePassValidityExtensionController {
  constructor(private readonly extensions: ValePassValidityExtensionService) {}

  @Post('prepare')
  @HttpCode(200)
  @Throttle(LIMIT)
  prepare(@Param('campaignId') campaignId: string, @Body() dto: PrepareValidityExtensionDto, @Req() req: RequestWithAdminUser): Promise<ExtensionPreview> {
    return this.extensions.prepare(campaignId, dto, actorOf(req));
  }

  @Post()
  @HttpCode(200)
  @Throttle(LIMIT)
  confirm(@Param('campaignId') campaignId: string, @Body() dto: ConfirmValidityExtensionDto, @Req() req: RequestWithAdminUser): Promise<ExtensionResult> {
    return this.extensions.confirm(campaignId, dto, actorOf(req));
  }

  @Get()
  @Throttle(LIMIT)
  history(@Param('campaignId') campaignId: string, @Req() req: RequestWithAdminUser): Promise<ExtensionView[]> {
    return this.extensions.history(campaignId, actorOf(req));
  }
}
