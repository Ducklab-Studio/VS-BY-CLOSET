import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireRole } from '../admin/require-role.decorator';
import { RequireModule } from '../admin/require-module.decorator';
import { ValePassCampaignsService, type ValePassCampaignItem } from './vale-pass-campaigns.service';
import { CreateValePassCampaignDto } from './dto/create-vale-pass-campaign.dto';
import { UpdateValePassCampaignDto } from './dto/update-vale-pass-campaign.dto';
import { CreateValePassLotDto, UpdateValePassLotDto, ValePassLotActionDto } from './dto/vale-pass-lot.dto';
import { ValePassLotsService, type CampaignCapacity } from './vale-pass-lots.service';
import type { LotView } from './vale-pass-capacity';

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string };
}

/**
 * "Área/aba própria para o Valle Pass" — módulo concedível
 * independente dos outros 6. Configurar campanha (valor/validade/
 * quantidade/variante Shopify) é uma decisão comercial — exige ADMIN
 * (ou SUPER_ADMIN, por hierarquia), mesmo padrão de
 * AdminRulesController.update().
 *
 * `@RequireRole('ADMIN')` fica em cada handler que ESCREVE, nunca na
 * classe: a tela do Valle Pass é aberta a quem tem o módulo (STAFF
 * incluso, em modo leitura — ver `canManageCampaigns` na página), e é
 * este mesmo GET que ela usa pra listar. Na classe, o papel bloquearia a
 * tela inteira pra STAFF.
 */
@Controller('admin/vale-pass/campaigns')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireModule('VALLE_PASS')
export class ValePassCampaignsController {
  constructor(
    private readonly campaigns: ValePassCampaignsService,
    private readonly lots: ValePassLotsService,
  ) {}

  @Get()
  list(): Promise<ValePassCampaignItem[]> {
    return this.campaigns.list();
  }

  @Post()
  @RequireRole('ADMIN')
  create(@Body() dto: CreateValePassCampaignDto, @Req() req: RequestWithAdminUser): Promise<ValePassCampaignItem> {
    return this.campaigns.create(dto, req.adminUser!.id, req.adminUser!.name);
  }

  @Post(':id/activate')
  @RequireRole('ADMIN')
  activate(@Param('id', ParseUUIDPipe) id: string, @Req() req: RequestWithAdminUser): Promise<ValePassCampaignItem> {
    return this.campaigns.setActive(id, true, req.adminUser!.id, req.adminUser!.name);
  }

  @Post(':id/deactivate')
  @RequireRole('ADMIN')
  deactivate(@Param('id', ParseUUIDPipe) id: string, @Req() req: RequestWithAdminUser): Promise<ValePassCampaignItem> {
    return this.campaigns.setActive(id, false, req.adminUser!.id, req.adminUser!.name);
  }

  /** Edição da configuração (ADMIN). Não altera passes já emitidos; vale só para emissões futuras. */
  @Patch(':id')
  @RequireRole('ADMIN')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateValePassCampaignDto, @Req() req: RequestWithAdminUser): Promise<ValePassCampaignItem> {
    const { adminUserId: _adminUserId, ...input } = dto;
    void _adminUserId;
    return this.campaigns.update(id, input, req.adminUser!.id, req.adminUser!.name);
  }

  /** Totais, saldo do limite global, lotes e alertas (leitura, qualquer perfil com o módulo). */
  @Get(':id/capacity')
  capacity(@Param('id', ParseUUIDPipe) id: string): Promise<CampaignCapacity> {
    return this.lots.getCapacity(id);
  }

  @Post(':id/lots')
  @RequireRole('ADMIN')
  createLot(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateValePassLotDto, @Req() req: RequestWithAdminUser): Promise<LotView> {
    return this.lots.create(id, { name: dto.name, quantity: dto.quantity }, req.adminUser!.id, req.adminUser!.name);
  }

  @Patch(':id/lots/:lotId')
  @RequireRole('ADMIN')
  updateLot(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @Body() dto: UpdateValePassLotDto,
    @Req() req: RequestWithAdminUser,
  ): Promise<LotView> {
    return this.lots.update(id, lotId, { expectedUpdatedAt: dto.expectedUpdatedAt, name: dto.name, quantity: dto.quantity }, req.adminUser!.id, req.adminUser!.name);
  }

  @Post(':id/lots/:lotId/open')
  @RequireRole('ADMIN')
  openLot(@Param('id', ParseUUIDPipe) id: string, @Param('lotId', ParseUUIDPipe) lotId: string, @Body() dto: ValePassLotActionDto, @Req() req: RequestWithAdminUser): Promise<LotView> {
    return this.lots.open(id, lotId, dto.expectedUpdatedAt, req.adminUser!.id, req.adminUser!.name);
  }

  @Post(':id/lots/:lotId/close')
  @RequireRole('ADMIN')
  closeLot(@Param('id', ParseUUIDPipe) id: string, @Param('lotId', ParseUUIDPipe) lotId: string, @Body() dto: ValePassLotActionDto, @Req() req: RequestWithAdminUser): Promise<LotView> {
    return this.lots.close(id, lotId, dto.expectedUpdatedAt, req.adminUser!.id, req.adminUser!.name);
  }

  @Post(':id/lots/:lotId/cancel')
  @RequireRole('ADMIN')
  cancelLot(@Param('id', ParseUUIDPipe) id: string, @Param('lotId', ParseUUIDPipe) lotId: string, @Body() dto: ValePassLotActionDto, @Req() req: RequestWithAdminUser): Promise<LotView> {
    return this.lots.cancel(id, lotId, dto.expectedUpdatedAt, req.adminUser!.id, req.adminUser!.name);
  }
}
