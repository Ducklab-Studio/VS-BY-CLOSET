import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { ShopifyAdminClient } from '../admin-panel/shopify-admin.client';
import { ShopifyOrderSyncService } from '../webhooks/shopify-order-sync.service';
import { ShopifyReconciliationController } from './shopify-reconciliation.controller';
import { ShopifyReconciliationService } from './shopify-reconciliation.service';
import { ShopifyOrderDeletionScheduler } from './shopify-order-deletion.scheduler';

@Module({
  imports: [PrismaModule],
  controllers: [ShopifyReconciliationController],
  providers: [ShopifyReconciliationService, ShopifyAdminClient, ShopifyOrderSyncService, AdminRoleGuard, ShopifyOrderDeletionScheduler],
})
export class ShopifyReconciliationModule {}
