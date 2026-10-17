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
import { EMAIL_CONFIG_TOKEN } from './email/email-tokens';
import { loadEmailConfig, type EmailConfig } from './email/email-config';
import { EMAIL_PROVIDER, ResendEmailProvider, type EmailProvider, type SendEmailResult } from './email/email-provider';
import { ValePassEmailOutboxService } from './email/email-outbox.service';
import { ValePassEmailScheduler, ValePassEmailWorkerService } from './email/email-worker.service';
import { ValePassEmailController } from './email/email.controller';
import { ResendWebhookController } from './email/resend-webhook.controller';

/** Sem chave configurada o provedor nunca é chamado (o worker bloqueia antes); se for, devolve resultado desconhecido em vez de fingir sucesso. */
const unconfiguredProvider: EmailProvider = { send: async (): Promise<SendEmailResult> => ({ kind: 'unknown', reason: 'provider_not_configured' }) };

@Module({
  controllers: [ValePassCampaignsController, ValePassVouchersController, ValePassOrdersController, ValePassHoldsController, ValePassEmailController, ResendWebhookController],
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
    { provide: EMAIL_CONFIG_TOKEN, useFactory: (): EmailConfig => loadEmailConfig() },
    {
      provide: EMAIL_PROVIDER,
      inject: [EMAIL_CONFIG_TOKEN],
      useFactory: (config: EmailConfig): EmailProvider => (config.apiKey ? new ResendEmailProvider({ apiKey: config.apiKey, timeoutMs: config.requestTimeoutMs }) : unconfiguredProvider),
    },
    ValePassEmailOutboxService,
    ValePassEmailWorkerService,
    ValePassEmailScheduler,
  ],
  // `ValePassWebhookService` é consumido pelo WebhooksModule (produto
  // totalmente separado do fluxo de aluguel, mas o gancho de emissão
  // do vale mora dentro do MESMO pipeline de webhook — ver comentário
  // em WebhooksService.dispatch()).
  exports: [ValePassWebhookService, ValePassEmailOutboxService],
})
export class ValePassModule {}
