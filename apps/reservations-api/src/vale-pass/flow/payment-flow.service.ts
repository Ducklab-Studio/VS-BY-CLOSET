import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma, ValePassCampaign, ValePassIssuanceHold, ValePassOrder } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { writeAdminAuditEvent } from '../../admin/admin-audit';
import { lockShopifyOrder } from '../../webhooks/shopify-order-lock';
import { extractCustomerEmail, extractCustomerName, extractCustomerPhone, type ShopifyOrderPayload } from '../../webhooks/shopify-order-payload';
import { ValePassEmailOutboxService } from '../email/email-outbox.service';
import { ValePassFinancialGuard, summarizeIssues } from '../financial/financial-guard.service';
import { factsFromWebhookPayload } from '../financial/order-facts';
import { PASS_UNIT_KEY } from '../vale-pass-capacity';
import { numericShopifyId } from '../vale-pass-order-status';
import { ValePassIssuanceService, type IssuanceOrder } from '../vale-pass-issuance.service';
import { financialIssueCodes } from '../vale-pass-lots.service';
import { absorbedUnissuedUnits } from '../refunds/refund.service';
import { ValePassRegularizationService, type RegularizationCandidate, type RegularizationOutcome } from '../refunds/regularization.service';
import { envFlowFlags, FLOW_FLAGS_TOKEN, INTEGRATION_DISABLED, PAYMENT_TIME_UNKNOWN, QUANTITY_INCREASED, QUANTITY_INCREASED_UNPROVEN, RESUMABLE_HOLD_CODES, type FlowFlags } from './flow-flags';

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

interface UnitHistoryEntry {
  readonly at: string;
  readonly from: number;
  readonly to: number;
  readonly proven: boolean;
  readonly source: string;
}
const unitHistoryOf = (detail: unknown): UnitHistoryEntry[] => {
  const raw = detail && typeof detail === 'object' ? (detail as { unitHistory?: unknown }).unitHistory : null;
  return Array.isArray(raw) ? (raw.filter((entry) => entry && typeof entry === 'object') as UnitHistoryEntry[]) : [];
};

export interface FlowOverview {
  readonly heldPayments: number;
  readonly heldUnits: number;
  readonly byCause: { readonly integrationDisabled: number; readonly paymentTimeUnknown: number; readonly quantityIncreased: number; readonly financialMismatch: number; readonly capacityOrCampaign: number };
  /** Pedidos pagos com unidades sem voucher e SEM retenção aberta (ex.: variante sem campanha). Candidatos à regularização. */
  readonly ordersWithoutTreatment: readonly RegularizationCandidate[];
  readonly unitsWithoutTreatment: number;
  /** Mensagens iniciais de e-mail (nada é enviado enquanto o envio estiver desligado). */
  readonly emails: { readonly awaitingSend: number; readonly needsAttention: number; readonly unknownResult: number };
}

export interface RegularizeResult {
  readonly outcome: RegularizationOutcome;
  readonly emailsQueued: number;
}

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
    @Optional() @Inject(ValePassRegularizationService) private readonly regularization: ValePassRegularizationService | null = null,
  ) {}

  enabled(): boolean {
    return this.flags.twoVoucher();
  }

  /** As chaves em vigor (leitura). */
  flagSet(): FlowFlags {
    return this.flags;
  }

  unitRefundsEnabled(): boolean {
    return this.flags.unitRefunds();
  }

  /**
   * Pedido do MODELO NOVO (dois vouchers por unidade): tem voucher de unidade, retenção de pagamento ou linha de campanha com benefícios. Esse pedido NUNCA
   * pode cair no cancelamento integral legado — o reembolso (parcial, só de frete, de outro produto) é sempre tratado POR UNIDADE (trilha idempotente,
   * política ADMIN_CONFIRM: o sistema só propõe, quem cancela é um ADMIN), independentemente das chaves. A chave VALE_PASS_UNIT_REFUNDS só decide o
   * mesmo tratamento para pedidos que ainda não têm nenhum sinal do modelo novo (ex.: campanha legada).
   */
  async usesUnitModel(tx: Tx, orderId: string, variantIds: readonly (string | number | null | undefined)[]): Promise<boolean> {
    // 1) O que foi EMITIDO manda (não a configuração atual da campanha, que pode ter ganhado benefícios depois da compra):
    //    qualquer voucher SEM unidade = pedido legado, mesmo com a chave de reembolso ligada (a mesma regra do ValePassRefundService: LEGACY_ORDER);
    //    vouchers com unidade = modelo novo.
    const issued = await tx.valePass.findMany({ where: { shopifyOrderId: orderId }, select: { groupId: true }, take: 100 });
    if (issued.some((voucher) => voucher.groupId === null)) return false;
    if (issued.length > 0) return true;
    // 2) Nada emitido ainda (pagamento retido, reembolso antes da emissão, evento fora de ordem): sinais do modelo novo.
    if (this.flags.unitRefunds()) return true;
    if (await tx.valePassIssuanceHold.findFirst({ where: { shopifyOrderId: orderId }, select: { id: true } })) return true;
    const wanted = new Set(variantIds.map((id) => numericShopifyId(id)).filter((id): id is string => id !== null));
    if (wanted.size === 0) return false;
    const withBenefits = await tx.valePassCampaign.findMany({ where: { benefits: { some: {} } }, select: { shopifyVariantId: true } });
    return withBenefits.some((campaign) => {
      const variant = numericShopifyId(campaign.shopifyVariantId);
      return variant !== null && wanted.has(variant);
    });
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
    // Prazo de 3 dias = desde o PAGAMENTO real. Sem esse instante (cabeçalho do orders/paid ausente/inválido, ou pagamento só visto por orders/updated ou
    // reconciliação) o pedido NÃO é emitido às cegas nem recebe horário inventado: fica retido, com alerta, para um administrador.
    if (!registry.paymentConfirmedAt) return hold([{ code: PAYMENT_TIME_UNKNOWN }], 'FINANCIAL_MISMATCH');

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
   * A quantidade do pedido mudou depois da emissão/retenção (ex.: pedido editado de 2 para 3 unidades). Nunca emite: só mantém a RETENÇÃO fiel ao que falta.
   *  - sem retenção aberta e com unidades já emitidas: abre a retenção `QUANTITY_INCREASED` (visível na fila e nos alertas);
   *  - com retenção aberta (qualquer motivo, ex.: `CAPACITY_EXCEEDED`): acompanha a quantidade. AUMENTO só entra com o pagamento do acréscimo COMPROVADO (validação
   *    financeira do evento atual: pago integralmente e total que cobre as unidades); sem comprovação a retenção NÃO cresce, ganha o motivo
   *    `QUANTITY_INCREASED_UNPROVEN` e o que sobra continua visível em "pedidos sem tratamento" até a regularização do ADMIN. REDUÇÃO sempre é acompanhada
   *    (nunca se emite o que deixou de ser pago). Cada ajuste é gravado na retenção (`unitHistory`) e na linha do tempo do pedido.
   * Idempotente (reprocessar o mesmo evento não muda nada) e serializado pelo lock do pedido + trava da campanha.
   */
  async holdQuantityIncrease(tx: Tx, input: { registry: ValePassOrder; campaigns: readonly ValePassCampaign[]; payload?: ShopifyOrderPayload }): Promise<FlowEvent[]> {
    const { registry, campaigns } = input;
    if (campaigns.length !== 1 || registry.status !== 'CONFIRMED' || registry.deletedInShopifyAt) return [];
    if (await tx.valePassOrderCancellation.findUnique({ where: { shopifyOrderId: registry.shopifyOrderId } })) return [];
    const campaign = campaigns[0];
    const orderId = registry.shopifyOrderId;
    const required = await this.missingUnits(tx, orderId, campaign.id, registry.quantity);
    const open = await tx.valePassIssuanceHold.findFirst({ where: { shopifyOrderId: orderId, campaignId: campaign.id, status: 'OPEN' } });
    if (open) return this.syncOpenHold(tx, { registry, campaign, hold: open, required, payload: input.payload });

    const issuedGroups = await tx.valePass.findMany({ where: { shopifyOrderId: orderId, campaignId: campaign.id, groupId: { not: null } }, select: { groupId: true }, distinct: ['groupId'] });
    if (issuedGroups.length === 0) return []; // nada emitido ainda: é o caso do pagamento (retenção própria), não de acréscimo
    if (required <= 0) return [];
    const order = this.issuanceOrder(registry);
    const held = await this.issuance.holdForFinancialReview(tx, { campaignId: campaign.id, order, units: required, issues: [{ code: QUANTITY_INCREASED, detail: { registryUnits: registry.quantity, issuedUnits: issuedGroups.length } }], allowWithExistingVouchers: true });
    this.logger.warn(`Pedido ${orderId}: compra cresceu depois da emissão — ${required} unidade(s) retida(s) para regularização.`);
    return [{ type: 'VALE_PASS_QUANTITY_INCREASE_HELD', detail: { orderId, campaignId: campaign.id, units: required, holdId: held.holdId } }];
  }

  private issuanceOrder(registry: ValePassOrder): IssuanceOrder {
    return { orderId: registry.shopifyOrderId, orderGid: registry.shopifyOrderGid, orderName: registry.shopifyOrderName, customerName: registry.customerName, customerPhone: registry.customerPhone, customerEmail: registry.customerEmail };
  }

  private async syncOpenHold(
    tx: Tx,
    input: { registry: ValePassOrder; campaign: ValePassCampaign; hold: ValePassIssuanceHold; required: number; payload?: ShopifyOrderPayload },
  ): Promise<FlowEvent[]> {
    const { registry, campaign, required } = input;
    if (required < 1 || required === input.hold.units) {
      // Em dia (ou o pedido foi todo devolvido: quem decide é o ADMIN, com o descarte). Se a quantidade voltou ao que a retenção já mostra, o aviso de "sem comprovação" cai.
      if (required === input.hold.units && financialIssueCodes(input.hold.detail).includes(QUANTITY_INCREASED_UNPROVEN)) return this.writeHold(tx, input, input.hold.units, { proven: true, resolved: true });
      return [];
    }
    // Mesma trava da emissão e do painel; relê a retenção já sob a trava (outro webhook ou a emissão do ADMIN podem tê-la mudado).
    await tx.$queryRaw`SELECT id FROM vale_pass_campaigns WHERE id = ${campaign.id}::uuid FOR UPDATE`;
    const hold = await tx.valePassIssuanceHold.findUnique({ where: { id: input.hold.id } });
    if (!hold || hold.status !== 'OPEN') return [];
    if (required === hold.units) return [];
    if (required < hold.units) return this.writeHold(tx, { ...input, hold }, required, { proven: true });

    let proven = false;
    if (input.payload) {
      const verdict = await this.guard.evaluate(tx, factsFromWebhookPayload(input.payload));
      proven = verdict.ok && verdict.units === registry.quantity;
    }
    if (proven) return this.writeHold(tx, { ...input, hold }, required, { proven: true });
    // Sem comprovação: não cresce. Registra a tentativa uma vez só (idempotente) e deixa o aviso na retenção.
    const history = unitHistoryOf(hold.detail);
    const last = history[history.length - 1];
    if (last && last.to === required && last.proven === false && financialIssueCodes(hold.detail).includes(QUANTITY_INCREASED_UNPROVEN)) return [];
    return this.writeHold(tx, { ...input, hold }, hold.units, { proven: false, attempted: required });
  }

  private async writeHold(
    tx: Tx,
    input: { registry: ValePassOrder; campaign: ValePassCampaign; hold: ValePassIssuanceHold },
    units: number,
    mode: { proven: boolean; attempted?: number; resolved?: boolean },
  ): Promise<FlowEvent[]> {
    const { hold, registry } = input;
    const detail = ((hold.detail as Record<string, unknown> | null) ?? {}) as { issues?: { code: string; detail?: unknown }[]; unitHistory?: UnitHistoryEntry[] };
    const issues = (detail.issues ?? []).filter((issue) => issue.code !== QUANTITY_INCREASED_UNPROVEN);
    if (!mode.proven) issues.push({ code: QUANTITY_INCREASED_UNPROVEN, detail: { registryUnits: registry.quantity, heldUnits: hold.units } });
    const history = [...unitHistoryOf(hold.detail), { at: new Date().toISOString(), from: hold.units, to: mode.attempted ?? units, proven: mode.proven, source: 'orders/updated' }].slice(-20);
    if (mode.resolved) history.pop(); // só limpa o aviso; não é uma mudança de unidades
    await tx.valePassIssuanceHold.update({ where: { id: hold.id }, data: { units, detail: { ...detail, issues, unitHistory: history } as unknown as Prisma.InputJsonValue } });
    await tx.valePassOrderEvent.create({
      data: { valePassOrderId: registry.id, type: 'HOLD_UNITS_UPDATED', detail: { holdId: hold.id, from: hold.units, to: units, attempted: mode.attempted ?? null, proven: mode.proven, source: 'orders/updated' } as Prisma.InputJsonValue },
    });
    return [{ type: 'VALE_PASS_HOLD_UNITS_UPDATED', detail: { orderId: registry.shopifyOrderId, holdId: hold.id, from: hold.units, to: units, proven: mode.proven } }];
  }

  /** Visão administrativa do que NÃO está resolvido: retenções por causa, unidades pendentes e pedidos pagos sem tratamento nenhum (sem dados pessoais). */
  async overview(): Promise<FlowOverview> {
    if (!this.prisma || !this.regularization) throw new Error('PrismaService/Regularization não disponíveis');
    const holds = await this.prisma.valePassIssuanceHold.findMany({ where: { status: 'OPEN' }, select: { reason: true, units: true, detail: true }, take: 500 });
    const byCause = { integrationDisabled: 0, paymentTimeUnknown: 0, quantityIncreased: 0, financialMismatch: 0, capacityOrCampaign: 0 };
    for (const hold of holds) {
      const codes = financialIssueCodes(hold.detail);
      if (codes.includes(INTEGRATION_DISABLED)) byCause.integrationDisabled++;
      else if (codes.includes(PAYMENT_TIME_UNKNOWN)) byCause.paymentTimeUnknown++;
      else if (codes.includes(QUANTITY_INCREASED)) byCause.quantityIncreased++;
      else if (hold.reason === 'FINANCIAL_MISMATCH') byCause.financialMismatch++;
      else byCause.capacityOrCampaign++;
    }
    const candidates = (await this.regularization.findCandidates(200)).filter((candidate) => !candidate.legacy && !candidate.hasOpenHold);
    const emailRows = await this.prisma.valePassEmailOutbox.groupBy({ by: ['status'], where: { kind: 'INITIAL', status: { in: ['QUEUED', 'NEEDS_ATTENTION', 'UNKNOWN'] } }, _count: { _all: true } });
    const emailCount = (status: string): number => emailRows.find((row) => row.status === status)?._count._all ?? 0;
    return {
      heldPayments: holds.length,
      heldUnits: holds.reduce((sum, hold) => sum + hold.units, 0),
      byCause,
      ordersWithoutTreatment: candidates.slice(0, 50),
      unitsWithoutTreatment: candidates.reduce((sum, candidate) => sum + candidate.missing, 0),
      emails: { awaitingSend: emailCount('QUEUED'), needsAttention: emailCount('NEEDS_ATTENTION'), unknownResult: emailCount('UNKNOWN') },
    };
  }

  /**
   * Regularização administrativa de um pedido PAGO com unidades sem voucher (compra que cresceu, variante sem campanha agora cadastrada, pagamento nunca
   * processado). ADMIN, justificativa, chave LIGADA. Reaproveita a regularização: revalida os fatos financeiros ATUAIS do pedido (último evento guardado,
   * pago integralmente, preço/quantidade/desconto/frete conferem) e só então emite o que falta, mais a mensagem inicial de cada unidade completa na MESMA
   * transação. Qualquer divergência vira retenção; nada é emitido às cegas. Idempotente: a segunda chamada não encontra nada a fazer.
   */
  async regularizeOrder(actor: { id: string; name: string }, input: { orderId: string; note: string }): Promise<RegularizeResult> {
    if (!this.prisma || !this.regularization) throw new Error('PrismaService/Regularization não disponíveis');
    const note = (input.note ?? '').trim();
    if (note.length < 10) throw new UnprocessableEntityException('Informe a justificativa (mínimo de 10 caracteres).');
    if (!this.flags.twoVoucher()) throw new ConflictException('A integração dos dois vouchers está desligada. Ligue VALE_PASS_TWO_VOUCHER_FLOW antes de regularizar pedidos.');
    const regularization = this.regularization;
    return this.prisma.$transaction(
      async (tx) => {
        await lockShopifyOrder(tx, input.orderId);
        const admin = await tx.adminUser.findUnique({ where: { id: actor.id }, select: { role: true, active: true } });
        // SUPER_ADMIN (o proprietário) satisfaz qualquer checagem de ADMIN por hierarquia (ver satisfiesRole em admin-role.guard.ts); STAFF e inativos seguem barrados.
        if (!admin || !admin.active || (admin.role !== 'ADMIN' && admin.role !== 'SUPER_ADMIN')) throw new ForbiddenException('Somente um administrador ativo pode regularizar pedidos.');
        const registry = await tx.valePassOrder.findUnique({ where: { shopifyOrderId: input.orderId } });
        if (!registry) throw new NotFoundException('Pedido não encontrado no registro do Valle Pass.');
        if (!registry.paymentConfirmedAt) throw new ConflictException('O instante real do pagamento é desconhecido: confira na Shopify e use a emissão excepcional da retenção (a base do prazo fica registrada).');
        const latest = await tx.$queryRaw<{ payload: ShopifyOrderPayload }[]>`
          SELECT payload FROM webhook_events
          WHERE topic IN ('orders/paid', 'orders/updated') AND payload->>'id' = ${input.orderId}
          ORDER BY processed_at DESC, id DESC LIMIT 1`;
        const payload = latest[0]?.payload;
        if (!payload) throw new ConflictException('Nenhum evento do pedido guardado: não há fatos financeiros para validar. Use a emissão excepcional da retenção.');
        if (payload.financial_status !== 'paid') throw new ConflictException('O último evento do pedido não mostra pagamento integral: confira na Shopify.');

        const outcome = await regularization.regularize(tx, { orderId: input.orderId, facts: factsFromWebhookPayload(payload) });
        let emailsQueued = 0;
        if (outcome.status === 'ISSUED' || outcome.status === 'HELD') {
          if (this.outbox) emailsQueued = (await this.outbox.enqueueForOrder(tx, input.orderId)).enqueued;
          await tx.valePassOrderEvent.create({ data: { valePassOrderId: registry.id, type: 'REGULARIZED', detail: { source: 'regularize', actorId: actor.id, outcome: outcome.status, emailsQueued } as Prisma.InputJsonValue } });
          await writeAdminAuditEvent(tx, {
            adminUserId: actor.id,
            adminUserName: actor.name,
            action: 'VALE_PASS_ORDER_REGULARIZED',
            entityType: 'ValePassOrder',
            entityId: registry.id,
            before: { quantity: registry.quantity },
            after: { outcome: outcome.status, issuedUnits: outcome.status === 'ISSUED' ? outcome.issuedUnits : 0, vouchersCreated: outcome.status === 'ISSUED' ? outcome.vouchersCreated : 0, emailsQueued },
            detail: { orderId: input.orderId, note },
          });
        }
        return { outcome, emailsQueued };
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
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
    const candidates = open.filter((hold) => financialIssueCodes(hold.detail).some((code) => RESUMABLE_HOLD_CODES.includes(code))).slice(0, limit);
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

  /** Retoma UMA retenção sob o lock do pedido (a mesma validação financeira completa). `actor.id` nulo = o próprio sistema (verificação automática). */
  async resumeOne(
    tx: Tx,
    candidate: ValePassIssuanceHold,
    actor: { id: string | null; name: string },
  ): Promise<{ kind: 'ISSUED' | 'RECLASSIFIED' } | { kind: 'SKIPPED'; orderName: string | null; reason: string }> {
    await lockShopifyOrder(tx, candidate.shopifyOrderId);
    const hold = await tx.valePassIssuanceHold.findUnique({ where: { id: candidate.id } });
    const registry = await tx.valePassOrder.findUnique({ where: { shopifyOrderId: candidate.shopifyOrderId } });
    const skip = (reason: string) => ({ kind: 'SKIPPED' as const, orderName: registry?.shopifyOrderName ?? null, reason });
    if (!hold || hold.status !== 'OPEN' || !financialIssueCodes(hold.detail).some((code) => RESUMABLE_HOLD_CODES.includes(code))) return skip('A retenção mudou desde a leitura.');
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
    // Auditoria na MESMA transação da emissão: ou os dois acontecem, ou nenhum (uma queda no meio nunca deixa voucher emitido sem trilha administrativa).
    const outcome = after && after.status === 'OPEN' ? 'RECLASSIFIED' : 'ISSUED';
    await writeAdminAuditEvent(tx, {
      adminUserId: actor.id,
      adminUserName: actor.name,
      action: 'VALE_PASS_HOLD_RESUMED',
      entityType: 'ValePassIssuanceHold',
      entityId: hold.id,
      before: { status: 'OPEN', units: hold.units, issues: financialIssueCodes(hold.detail) },
      after: { status: after?.status ?? null, outcome, issues: after ? financialIssueCodes(after.detail) : [] },
      detail: { orderId: candidate.shopifyOrderId, events: [...new Set(events.map((event) => event.type))] },
    });
    return { kind: outcome };
  }
}
