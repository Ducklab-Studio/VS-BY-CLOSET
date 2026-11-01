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
import { ValePassFinancialGuard } from './financial/financial-guard.service';
import { ValePassRefundService } from './refunds/refund.service';
import { ValePassRefundReviewsController } from './refunds/refund-reviews.controller';
import { ValePassRegularizationService } from './refunds/regularization.service';
import { ValePassPaymentFlowService } from './flow/payment-flow.service';
import { ValePassPaymentTimeService } from './flow/payment-time.service';
import { ValePassLedgerService } from './ledger/ledger.service';
import { ValePassLedgerController } from './ledger/ledger.controller';
import { ValePassRedemptionService } from './ledger/redemption.service';
import { ValePassBlockService } from './ledger/block.service';
import { ValePassOperatorScopeService } from './ledger/operator-scope.service';
import { ValePassOperatorScopeController } from './ledger/operator-scope.controller';
import { ValePassValidityExtensionService } from './validity-extension.service';
import { ValePassCancellationAlertsService } from './cancellation-alerts.service';
import { ValePassCancellationAlertsController } from './cancellation-alerts.controller';
import { ValePassValidityExtensionController } from './validity-extension.controller';
import { ValePassAutoVerifyScheduler, ValePassAutoVerifyService } from './flow/auto-verify.service';
import { ValePassAlertsScheduler, ValePassOperationalAlertsService } from './flow/operational-alerts.service';
import { ValePassFlowController } from './flow/flow.controller';
import { ValePassLaunchReadinessController } from './vale-pass-launch-readiness.controller';
import { ValePassLaunchReadinessService } from './vale-pass-launch-readiness.service';
import { envFlowFlags, FLOW_FLAGS_TOKEN } from './flow/flow-flags';
import { ValePassTermsAcceptancePublicController, ValePassTermsEvidenceAdminController } from './flow/terms-acceptance.controller';
import { ValePassTermsAcceptanceService } from './flow/terms-acceptance.service';

/** Sem chave configurada o provedor nunca é chamado (o worker bloqueia antes); se for, devolve resultado desconhecido em vez de fingir sucesso. */
const unconfiguredProvider: EmailProvider = { send: async (): Promise<SendEmailResult> => ({ kind: 'unknown', reason: 'provider_not_configured' }) };

@Module({
  controllers: [ValePassTermsAcceptancePublicController, ValePassTermsEvidenceAdminController, ValePassCampaignsController, ValePassVouchersController, ValePassOrdersController, ValePassHoldsController, ValePassEmailController, ResendWebhookController, ValePassRefundReviewsController, ValePassFlowController, ValePassLedgerController, ValePassOperatorScopeController, ValePassValidityExtensionController, ValePassCancellationAlertsController, ValePassLaunchReadinessController],
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
    ValePassTermsAcceptanceService,
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
    ValePassFinancialGuard,
    ValePassRefundService,
    ValePassRegularizationService,
    { provide: FLOW_FLAGS_TOKEN, useFactory: () => envFlowFlags() },
    ValePassPaymentFlowService,
    ValePassLaunchReadinessService,
    ValePassPaymentTimeService,
    ValePassLedgerService,
    ValePassRedemptionService,
    ValePassBlockService,
    ValePassOperatorScopeService,
    ValePassValidityExtensionService,
    ValePassCancellationAlertsService,
    ValePassAutoVerifyService,
    ValePassAutoVerifyScheduler,
    ValePassOperationalAlertsService,
    ValePassAlertsScheduler,
  ],
  // `ValePassWebhookService` é consumido pelo WebhooksModule (produto
  // totalmente separado do fluxo de aluguel, mas o gancho de emissão
  // do vale mora dentro do MESMO pipeline de webhook — ver comentário
  // em WebhooksService.dispatch()).
  exports: [ValePassWebhookService, ValePassEmailOutboxService],
})
export class ValePassModule {}
