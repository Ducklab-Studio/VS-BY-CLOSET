import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireModule } from '../admin/require-module.decorator';
import { RequireRole } from '../admin/require-role.decorator';
import { CatalogSyncDto } from './dto/catalog-sync.dto';
import { ShopifyCatalogSyncService, type CatalogSyncReport } from './shopify-catalog-sync.service';

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string };
}

/**
 * Item 10/11 do pedido: relatório somente-leitura (STAFF, mesmo padrão de
 * `GET /admin/shopify/catalog`) + ação administrativa protegida (ADMIN,
 * mesmo padrão de `POST /admin/shopify/units`). Nunca cria pedido,
 * pagamento, reserva ou HOLD — só lê a Shopify e ativa/desativa RentalUnit.
 */
@Controller('admin/catalog')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireModule('PIECES')
export class ShopifyCatalogSyncController {
  constructor(private readonly catalogSync: ShopifyCatalogSyncService) {}

  @Get('reconciliation')
  reconciliation(): Promise<CatalogSyncReport> {
    return this.catalogSync.reconcile({ apply: false });
  }

  @Post('sync')
  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  sync(@Body() _dto: CatalogSyncDto, @Req() req: RequestWithAdminUser): Promise<CatalogSyncReport> {
    return this.catalogSync.reconcile({ apply: true, actor: { id: req.adminUser!.id, name: req.adminUser!.name } });
  }
}
