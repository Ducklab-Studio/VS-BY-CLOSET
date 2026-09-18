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
  constructor(private readonly campaigns: ValePassCampaignsService) {}

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
  activate(@Param('id') id: string, @Req() req: RequestWithAdminUser): Promise<ValePassCampaignItem> {
    return this.campaigns.setActive(id, true, req.adminUser!.id, req.adminUser!.name);
  }

  @Post(':id/deactivate')
  @RequireRole('ADMIN')
  deactivate(@Param('id') id: string, @Req() req: RequestWithAdminUser): Promise<ValePassCampaignItem> {
    return this.campaigns.setActive(id, false, req.adminUser!.id, req.adminUser!.name);
  }
}
