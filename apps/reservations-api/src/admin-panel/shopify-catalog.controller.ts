import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireRole } from '../admin/require-role.decorator';
import { RequireModule } from '../admin/require-module.decorator';
import { ImportShopifyUnitsDto } from './dto/import-shopify-units.dto';
import { ShopifyCatalogService, type ShopifyCatalogItem, type ShopifyMappedUnit } from './shopify-catalog.service';

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string };
}

@Controller('admin/shopify')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireModule('PIECES')
export class ShopifyCatalogController {
  constructor(private readonly catalog: ShopifyCatalogService) {}

  /** STAFF pode consultar catálogo/vínculos; é leitura operacional. */
  @Get('catalog')
  list(): Promise<ShopifyCatalogItem[]> {
    return this.catalog.list();
  }

  /**
   * ADMIN escolhe explicitamente quais unidades físicas existem.
   * Não toca inventoryQuantity da Shopify e não cria quantidade sozinho.
   */
  @Post('units')
  @RequireRole('ADMIN')
  importUnits(@Body() dto: ImportShopifyUnitsDto, @Req() req: RequestWithAdminUser): Promise<readonly ShopifyMappedUnit[]> {
    return this.catalog.importUnits(
      {
        shopifyVariantId: dto.shopifyVariantId,
        codes: dto.codes,
        reservableOnline: dto.reservableOnline,
        countsTowardRentalDuration: dto.countsTowardRentalDuration,
      },
      req.adminUser!.id,
      req.adminUser!.name,
    );
  }
}
