import { Module } from '@nestjs/common';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { ShopifyAdminClient } from '../admin-panel/shopify-admin.client';
import { ValePassWebhookService } from './vale-pass-webhook.service';
import { ValePassCampaignsService } from './vale-pass-campaigns.service';
import { ValePassCampaignsController } from './vale-pass-campaigns.controller';
import { ValePassLotsService } from './vale-pass-lots.service';
import { ValePassBenefitsService } from './vale-pass-benefits.service';
import { ValePassIssuanceService } from './vale-pass-issuance.service';
import { ValePassHoldsService } from './vale-pass-holds.service';
import { ValePassHoldsController } from './vale-pass-holds.controller';
import { ValePassVouchersService } from './vale-pass-vouchers.service';
import { ValePassVouchersController } from './vale-pass-vouchers.controller';
import { ValePassOrdersService } from './vale-pass-orders.service';
import { ValePassOrdersController } from './vale-pass-orders.controller';
import { ValePassOrdersScheduler } from './vale-pass-orders.scheduler';

@Module({
  controllers: [ValePassCampaignsController, ValePassVouchersController, ValePassOrdersController, ValePassHoldsController],
  providers: [
    AdminRoleGuard,
    ShopifyAdminClient,
    ValePassWebhookService,
    ValePassCampaignsService,
    ValePassLotsService,
    ValePassBenefitsService,
    ValePassIssuanceService,
    ValePassHoldsService,
    ValePassVouchersService,
    ValePassOrdersService,
    ValePassOrdersScheduler,
  ],
  // `ValePassWebhookService` é consumido pelo WebhooksModule (produto
  // totalmente separado do fluxo de aluguel, mas o gancho de emissão
  // do vale mora dentro do MESMO pipeline de webhook — ver comentário
  // em WebhooksService.dispatch()).
  exports: [ValePassWebhookService],
})
export class ValePassModule {}
