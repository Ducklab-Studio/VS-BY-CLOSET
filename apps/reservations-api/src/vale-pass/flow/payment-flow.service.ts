import { ConflictException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma, ValePassCampaign, ValePassIssuanceHold, ValePassOrder } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { writeAdminAuditEvent } from '../../admin/admin-audit';
import { lockShopifyOrder } from '../../webhooks/shopify-order-lock';
import { extractCustomerEmail, extractCustomerName, extractCustomerPhone, type ShopifyOrderPayload } from '../../webhooks/shopify-order-payload';
import { ValePassEmailOutboxService } from '../email/email-outbox.service';
import { ValePassFinancialGuard, summarizeIssues } from '../financial/financial-guard.service';
import { factsFromWebhookPayload } from '../financial/order-facts';
import { PASS_UNIT_KEY } from '../vale-pass-capacity';
import { ValePassIssuanceService, type IssuanceOrder } from '../vale-pass-issuance.service';
import { financialIssueCodes } from '../vale-pass-lots.service';
import { absorbedUnissuedUnits } from '../refunds/refund.service';
import { envFlowFlags, FLOW_FLAGS_TOKEN, INTEGRATION_DISABLED, type FlowFlags } from './flow-flags';

type Tx = Prisma.TransactionClient;

export interface FlowEvent {
  readonly type: string;
  readonly detail?: Record<string, unknown>;
}

export interface ResumeReport {
  readonly considered: number;
  readonly issued: number;
  readonly reclassified: number;
  readonly skipped: { readonly orderName: string | null; readonly reason: string }[];
}

export const MAX_RESUME_BATCH = 25;

/**
 * Caminho do pagamento confirmado no modelo de DOIS VOUCHERS por unidade (Valle Pass 2027). Roda DENTRO da transação e do lock do pedido do webhook.
 *
 * Regras (todas fail-closed):
 *  - o pagamento NUNCA some: chave desligada, pedido fora do registro, várias campanhas ou validação financeira reprovada viram RETENÇÃO (fila do
 *    ClosetAdmin, alerta, auditoria) — jamais um voucher único do caminho legado e jamais um descarte silencioso;
 *  - a quantidade emitida é a do REGISTRO do pedido; se o payload mostrar outra (ex.: unidade removida), vira retenção;
 *  - com a chave ligada: validação financeira (PR E) → emissão (PR B/capacidade) → uma mensagem na caixa de saída por unidade completa (idempotente);
 *  - reconciliação (payload sem dados financeiros) é recusada pela validação e cai na retenção: nunca emite às cegas.
 */
@Injectable()
export class ValePassPaymentFlowService {
  private readonly logger = new Logger(ValePassPaymentFlowService.name);

  constructor(
    @Optional() @Inject(ValePassFinancialGuard) private readonly guard: ValePassFinancialGuard = new ValePassFinancialGuard(),
    @Optional() @Inject(ValePassIssuanceService) private readonly issuance: ValePassIssuanceService = new ValePassIssuanceService(),
    // Tipos com `| null` perdem o token de injeção do Nest: por isso o `@Inject` explícito (um teste de DI real trava isto).
    @Optional() @Inject(ValePassEmailOutboxService) private readonly outbox: ValePassEmailOutboxService | null = null,
    @Optional() @Inject(FLOW_FLAGS_TOKEN) private readonly flags: FlowFlags = envFlowFlags(),
    @Optional() @Inject(PrismaService) private readonly prisma: PrismaService | null = null,
  ) {}

  enabled(): boolean {
    return this.flags.twoVoucher();
  }

  unitRefundsEnabled(): boolean {
    return this.flags.unitRefunds();
  }

  /** Quantas unidades da campanha o pedido ainda precisa receber: pagas − emitidas (inclui canceladas) − devolvidas por reembolso antes da emissão. */
  async missingUnits(tx: Tx, orderId: string, campaignId: string, units: number): Promise<number> {
    const rows = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(DISTINCT ${PASS_UNIT_KEY})::int AS n FROM vale_passes v WHERE v.shopify_order_id = ${orderId} AND v.campaign_id = ${campaignId}::uuid`;
    return units - (rows[0]?.n ?? 0) - (await absorbedUnissuedUnits(tx, orderId));
  }

  async processPaidOrder(
    tx: Tx,
    input: { payload: ShopifyOrderPayload; registry: ValePassOrder | null; campaigns: readonly ValePassCampaign[]; source: string },
  ): Promise<FlowEvent[]> {
    const { payload, registry, campaigns, source } = input;
    const orderId = String(payload.id);
    const campaign = campaigns[0];
    const order: IssuanceOrder = {
      orderId,
      orderGid: registry?.shopifyOrderGid ?? payload.admin_graphql_api_id ?? null,
      orderName: registry?.shopifyOrderName ?? payload.name ?? null,
      customerName: registry?.customerName ?? extractCustomerName(payload),
      customerPhone: registry?.customerPhone ?? extractCustomerPhone(payload),
      customerEmail: registry?.customerEmail ?? extractCustomerEmail(payload),
    };
    // A quantidade confiável é a do REGISTRO do pedido. Sem registro (nunca deveria acontecer neste ponto) usa-se o payload só para dimensionar a retenção.
    const units = registry?.quantity ?? campaigns.reduce((sum, c) => sum + (payload.line_items ?? []).filter((l) => String(l.variant_id) === c.shopifyVariantId.replace(/^.*\//, '')).reduce((s, l) => s + (l.quantity ?? 0), 0), 0);

    const hold = async (issues: { code: string; detail?: Record<string, unknown> }[], reason: string): Promise<FlowEvent[]> => {
      if (units < 1) return [{ type: 'VALE_PASS_ORDER_WITHOUT_TREATMENT', detail: { orderId, reason: 'sem unidades para reter', issues: issues.map((i) => i.code) } }];
      const missing = await this.missingUnits(tx, orderId, campaign.id, units);
      if (missing <= 0) return [{ type: 'VALE_PASS_ALREADY_ISSUED', detail: { orderId, units } }];
      const held = await this.issuance.holdForFinancialReview(tx, { campaignId: campaign.id, order, units: missing, issues, allowWithExistingVouchers: true });
      this.logger.warn(`Pedido ${orderId} pago retido (${reason}): ${missing} unidade(s) aguardam a fila de resolução.`);
      return [{ type: 'VALE_PASS_ISSUANCE_HELD', detail: { orderId, campaignId: campaign.id, units: missing, reason, issues: issues.map((i) => i.code), holdId: held.holdId, source } }];
    };

    if (campaigns.length !== 1) return hold([{ code: 'MULTIPLE_CAMPAIGNS' }], 'FINANCIAL_MISMATCH');
    if (!registry) return hold([{ code: 'ORDER_NOT_REGISTERED' }], 'FINANCIAL_MISMATCH');
    if (!this.flags.twoVoucher()) return hold([{ code: INTEGRATION_DISABLED }], INTEGRATION_DISABLED);

    const verdict = await this.guard.evaluate(tx, factsFromWebhookPayload(payload));
    const issues = verdict.ok
      ? verdict.units === units
        ? []
        : [{ code: 'QUANTITY_CHANGED', detail: { registryUnits: units, orderUnits: verdict.units } }]
      : summarizeIssues(verdict.issues);
    if (issues.length > 0) return hold(issues, 'FINANCIAL_MISMATCH');

    const outcome = await this.issuance.issueForCampaign(tx, { campaignId: campaign.id, order, units, mode: 'enforce' });
    if (outcome.mode === 'legacy') return [{ type: 'VALE_PASS_FLOW_LEGACY_CAMPAIGN', detail: { orderId, campaignId: campaign.id } }];
    const events: FlowEvent[] = outcome.events.map((event) => ({ type: event.type, detail: event.detail }));
    if (this.outbox) {
      const queued = await this.outbox.enqueueForOrder(tx, orderId);
      if (queued.enqueued > 0) events.push({ type: 'VALE_PASS_EMAIL_ENQUEUED', detail: { orderId, units: queued.enqueued } });
    }
    return events;
  }

  /**
   * Retomada das retenções feitas com a chave DESLIGADA (ação de ADMIN; nunca automática). Só funciona com a chave LIGADA. Processa em ordem de
   * pagamento (as mais antigas primeiro), em lotes pequenos, cada pedido na sua transação e sob o seu lock. Idempotente: pedido já tratado é pulado.
   * O que a validação financeira não aceitar continua retido, agora com os motivos reais. Cancelamento/reembolso nunca passa por aqui.
   */
  async resumeHeldPayments(actor: { id: string; name: string }, options: { limit?: number; note?: string } = {}): Promise<ResumeReport> {
    if (!this.prisma) throw new Error('PrismaService não disponível');
    if (!this.flags.twoVoucher()) {
      throw new ConflictException('A integração dos dois vouchers está desligada. Ligue VALE_PASS_TWO_VOUCHER_FLOW antes de retomar as retenções.');
    }
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 10), 1), MAX_RESUME_BATCH);
    const open = await this.prisma.valePassIssuanceHold.findMany({ where: { status: 'OPEN', reason: 'FINANCIAL_MISMATCH' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 500 });
    const candidates = open.filter((hold) => financialIssueCodes(hold.detail).includes(INTEGRATION_DISABLED)).slice(0, limit);
    const skipped: { orderName: string | null; reason: string }[] = [];
    let issued = 0;
    let reclassified = 0;

    for (const candidate of candidates) {
      const result = await this.prisma.$transaction((tx) => this.resumeOne(tx, candidate, actor), { timeout: 30_000, maxWait: 10_000 });
      if (result.kind === 'ISSUED') issued++;
      else if (result.kind === 'RECLASSIFIED') reclassified++;
      else if (result.kind === 'SKIPPED') skipped.push({ orderName: result.orderName, reason: result.reason });
    }
    await this.prisma.$transaction((tx) =>
      writeAdminAuditEvent(tx, {
        adminUserId: actor.id,
        adminUserName: actor.name,
        action: 'VALE_PASS_HOLDS_RESUMED',
        entityType: 'ValePassIssuanceHold',
        before: { openIntegrationHolds: candidates.length },
        after: { issued, reclassified, skipped: skipped.length },
        detail: { limit, note: options.note ?? null },
      }),
    );
    return { considered: candidates.length, issued, reclassified, skipped };
  }

  private async resumeOne(
    tx: Tx,
    candidate: ValePassIssuanceHold,
    actor: { id: string; name: string },
  ): Promise<{ kind: 'ISSUED' | 'RECLASSIFIED' } | { kind: 'SKIPPED'; orderName: string | null; reason: string }> {
    await lockShopifyOrder(tx, candidate.shopifyOrderId);
    const hold = await tx.valePassIssuanceHold.findUnique({ where: { id: candidate.id } });
    const registry = await tx.valePassOrder.findUnique({ where: { shopifyOrderId: candidate.shopifyOrderId } });
    const skip = (reason: string) => ({ kind: 'SKIPPED' as const, orderName: registry?.shopifyOrderName ?? null, reason });
    if (!hold || hold.status !== 'OPEN' || !financialIssueCodes(hold.detail).includes(INTEGRATION_DISABLED)) return skip('A retenção mudou desde a leitura.');
    if (!registry || registry.status !== 'CONFIRMED' || registry.deletedInShopifyAt) return skip('O pedido não está mais pago (confira na Shopify e descarte a retenção).');
    if (await tx.valePassOrderCancellation.findUnique({ where: { shopifyOrderId: candidate.shopifyOrderId } })) return skip('Pedido cancelado/reembolsado: descarte a retenção.');
    const campaign = await tx.valePassCampaign.findUnique({ where: { id: hold.campaignId } });
    if (!campaign) return skip('Campanha não encontrada.');

    // Estado MAIS RECENTE do pedido que a Shopify enviou. Se o último evento não mostra pagamento integral, não se emite nada.
    const latest = await tx.$queryRaw<{ payload: ShopifyOrderPayload }[]>`
      SELECT payload FROM webhook_events
      WHERE topic IN ('orders/paid', 'orders/updated') AND payload->>'id' = ${candidate.shopifyOrderId}
      ORDER BY processed_at DESC, id DESC LIMIT 1`;
    const payload = latest[0]?.payload;
    if (!payload) return skip('Nenhum evento do pedido guardado: use a emissão excepcional do ADMIN.');
    if (payload.financial_status !== 'paid') return skip('O último evento do pedido não está pago: confira na Shopify.');

    const events = await this.processPaidOrder(tx, { payload, registry, campaigns: [campaign], source: 'resume' });
    const after = await tx.valePassIssuanceHold.findUnique({ where: { id: hold.id } });
    await tx.valePassOrderEvent.create({
      data: { valePassOrderId: registry.id, type: 'HOLD_RESUMED', detail: { source: 'resume', actorId: actor.id, outcome: [...new Set(events.map((event) => event.type))] } as Prisma.InputJsonValue },
    });
    if (after && after.status === 'OPEN') return { kind: 'RECLASSIFIED' };
    return { kind: 'ISSUED' };
  }
}
