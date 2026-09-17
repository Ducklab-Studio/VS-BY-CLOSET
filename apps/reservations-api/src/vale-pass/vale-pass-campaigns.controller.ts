import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireRole } from '../admin/require-role.decorator';
import { RequireModule } from '../admin/require-module.decorator';
import { ValePassCampaignsService, type ValePassCampaignItem } from './vale-pass-campaigns.service';
import { CreateValePassCampaignDto } from './dto/create-vale-pass-campaign.dto';

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string };
}

/**
 * "Área/aba própria para o Valle Pass" — módulo concedível
 * independente dos outros 6. Configurar campanha (valor/validade/
 * quantidade/variante Shopify) é uma decisão comercial — exige ADMIN
 * (ou SUPER_ADMIN, por hierarquia), mesmo padrão de
 * AdminRulesController.update().
 */
@Controller('admin/vale-pass/campaigns')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireModule('VALLE_PASS')
@RequireRole('ADMIN')
export class ValePassCampaignsController {
  constructor(private readonly campaigns: ValePassCampaignsService) {}

  @Get()
  list(): Promise<ValePassCampaignItem[]> {
    return this.campaigns.list();
  }

  @Post()
  create(@Body() dto: CreateValePassCampaignDto, @Req() req: RequestWithAdminUser): Promise<ValePassCampaignItem> {
    return this.campaigns.create(dto, req.adminUser!.id, req.adminUser!.name);
  }

  @Post(':id/activate')
  activate(@Param('id') id: string, @Req() req: RequestWithAdminUser): Promise<ValePassCampaignItem> {
    return this.campaigns.setActive(id, true, req.adminUser!.id, req.adminUser!.name);
  }

  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @Req() req: RequestWithAdminUser): Promise<ValePassCampaignItem> {
    return this.campaigns.setActive(id, false, req.adminUser!.id, req.adminUser!.name);
  }
}
