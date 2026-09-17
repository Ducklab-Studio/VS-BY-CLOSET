import { Module } from '@nestjs/common';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { ValePassWebhookService } from './vale-pass-webhook.service';
import { ValePassCampaignsService } from './vale-pass-campaigns.service';
import { ValePassCampaignsController } from './vale-pass-campaigns.controller';
import { ValePassVouchersService } from './vale-pass-vouchers.service';
import { ValePassVouchersController } from './vale-pass-vouchers.controller';

@Module({
  controllers: [ValePassCampaignsController, ValePassVouchersController],
  providers: [AdminRoleGuard, ValePassWebhookService, ValePassCampaignsService, ValePassVouchersService],
  // `ValePassWebhookService` é consumido pelo WebhooksModule (produto
  // totalmente separado do fluxo de aluguel, mas o gancho de emissão
  // do vale mora dentro do MESMO pipeline de webhook — ver comentário
  // em WebhooksService.dispatch()).
  exports: [ValePassWebhookService],
})
export class ValePassModule {}
