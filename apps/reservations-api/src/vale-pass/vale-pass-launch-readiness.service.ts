import { Injectable, NotFoundException } from '@nestjs/common';
import { ValePassBenefitsService } from './vale-pass-benefits.service';
import { ValePassCampaignsService, type ValePassCampaignItem } from './vale-pass-campaigns.service';
import { ValePassLotsService } from './vale-pass-lots.service';
import { ValePassPaymentFlowService } from './flow/payment-flow.service';
import { alertsConfigFromEnv } from './flow/alerts-notifier';
import { loadEmailConfig } from './email/email-config';
import { buildLaunchChecklist, emptyChecklist, type LaunchChecklist } from './vale-pass-launch-checklist';

/**
 * "Pronta para vender?" (ClosetAdmin). SOMENTE LEITURA: lê campanha, benefícios, capacidade e o estado das chaves; não grava nada, não consulta a Shopify e não
 * devolve segredos (só o modo de cada chave). Escolhe a campanha ativa mais recente (ou a mais recente, se nenhuma estiver ativa) quando não recebe um id.
 */
@Injectable()
export class ValePassLaunchReadinessService {
  constructor(
    private readonly campaigns: ValePassCampaignsService,
    private readonly benefits: ValePassBenefitsService,
    private readonly lots: ValePassLotsService,
    private readonly flow: ValePassPaymentFlowService,
  ) {}

  async snapshot(campaignId?: string): Promise<LaunchChecklist> {
    const all = await this.campaigns.list(); // mais recentes primeiro
    let campaign: ValePassCampaignItem | undefined;
    if (campaignId) {
      campaign = all.find((c) => c.id === campaignId);
      if (!campaign) throw new NotFoundException('Campanha não encontrada.');
    } else {
      campaign = all.find((c) => c.active) ?? all[0];
    }
    if (!campaign) return emptyChecklist();

    const [benefits, capacity] = await Promise.all([this.benefits.list(campaign.id), this.lots.getCapacity(campaign.id)]);
    const email = loadEmailConfig();
    const flags = this.flow.flagSet();

    return buildLaunchChecklist(
      { id: campaign.id, name: campaign.name },
      {
        campaign: {
          amountCents: campaign.amountCents,
          active: campaign.active,
          quantityLimit: campaign.quantityLimit,
          globalLimit: campaign.globalLimit,
          voucherValidFrom: campaign.voucherValidFrom,
          voucherValidUntil: campaign.voucherValidUntil,
          salesEndDate: campaign.salesEndDate,
        },
        benefits: benefits.map((b) => ({ kind: b.kind, company: b.company, amountCents: b.amountCents, discountPercent: b.discountPercent, terms: b.terms, active: b.active })),
        hasOpenLot: capacity.openLot !== null,
        shopifyStock: null, // a API não lê a Shopify
        capacity: {
          openHolds: capacity.holds.length,
          refundReviews: capacity.refundReviews.length,
          cancellationAlerts: capacity.cancellationAlerts.length,
          paidOrdersWithoutVoucher: capacity.paidOrdersWithoutVoucher.length,
        },
        flags: {
          twoVoucher: flags.twoVoucher(),
          autoVerify: flags.autoVerify?.() ?? false,
          emailMode: email.mode,
          emailDomainVerified: email.domainVerified,
          alertsMode: alertsConfigFromEnv().mode,
        },
      },
    );
  }
}
