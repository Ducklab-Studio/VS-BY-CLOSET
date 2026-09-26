import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { AdminCalendarController } from './calendar.controller';
import { AdminCalendarService } from './calendar.service';
import { AdminPiecesController } from './pieces.controller';
import { AdminPiecesService } from './pieces.service';
import { AdminRulesController } from './rules.controller';
import { AdminRulesService } from './rules.service';
import { AdminBlocksController } from './blocks.controller';
import { AdminBlocksService } from './blocks.service';
import { AdminAuditController } from './audit.controller';
import { AdminAuditService } from './audit.service';
import { ShopifyAdminClient } from './shopify-admin.client';
import { ShopifyCatalogController } from './shopify-catalog.controller';
import { ShopifyCatalogService } from './shopify-catalog.service';
import { ShopifyCatalogSyncController } from './shopify-catalog-sync.controller';
import { ShopifyCatalogSyncService } from './shopify-catalog-sync.service';
import { CatalogSyncSchedulerService } from './catalog-sync-scheduler.service';

@Module({
  imports: [PrismaModule],
  controllers: [
    AdminCalendarController,
    AdminPiecesController,
    AdminRulesController,
    AdminBlocksController,
    AdminAuditController,
    ShopifyCatalogController,
    ShopifyCatalogSyncController,
  ],
  providers: [
    AdminRoleGuard,
    AdminCalendarService,
    AdminPiecesService,
    AdminRulesService,
    AdminBlocksService,
    AdminAuditService,
    ShopifyAdminClient,
    ShopifyCatalogService,
    ShopifyCatalogSyncService,
    CatalogSyncSchedulerService,
  ],
  exports: [AdminCalendarService, ShopifyCatalogSyncService],
})
export class AdminPanelModule {}
