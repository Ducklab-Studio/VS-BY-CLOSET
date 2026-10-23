import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, ValePassCampaign, ValePassCampaignBenefit, ValePassIssuanceHold } from '@prisma/client';
import { generateValePassCode } from './vale-pass-code';
import { configuredCapacityLimit, loadCapacity } from './vale-pass-capacity';
import { formatIsoDate } from './vale-pass-capacity';
import { resolveValidityTimezone, voucherWindow } from './vale-pass-validity';

/**
 * Emissão do Valle Pass no modelo de VÁRIOS VOUCHERS por unidade comercial (Valle Pass 2027: um voucher da Valle Showroom + um da
 * VS BY CLOSET por unidade, consumindo UMA unidade do limite global).
 *
 * ESTE SERVIÇO NÃO ESTÁ LIGADO AO WEBHOOK. Ele só é chamado pelos testes e pela resolução administrativa da fila de retenções; ligá-lo à
 * emissão do webhook de pagamento é a etapa seguinte e exige autorização própria (ver docs/VALLE-PASS-2027-DESENHO.md, seção 9). Enquanto isso,
 * o comportamento financeiro ativo (`ValePassWebhookService.handleOrderPaid`) é exatamente o de antes.
 *
 * Contrato (o chamador já está DENTRO de uma transação e já tomou o lock do pedido — `lockShopifyOrder`; aqui só se trava a campanha):
 *  - só emite para pedido com pagamento confirmado: quem chama garante isso (o webhook, ou a resolução, que relê o pedido);
 *  - campanha SEM nenhum benefício cadastrado → devolve `{ mode: 'legacy' }` e não faz nada: o chamador segue o caminho legado;
 *  - campanha COM benefícios sem capacidade configurada, sem voucher ativo ou sem janela de validade → NÃO cai no legado: retém o pedido;
 *  - idempotente e recuperável: reentrega ou reprocessamento nunca duplica; unidade com voucher faltando é completada sem consumir capacidade;
 *  - sem limite de capacidade configurado para uma campanha com benefícios, ou sem saldo → retém o pedido INTEIRO (tudo ou nada), com alerta e fila;
 *  - limite de LOTE nunca bloqueia emissão; o limite LEGADO (`quantity_limit`) não vale neste modelo;
 *  - nunca cancela, reembolsa nem emite dinheiro: só cria vouchers e registra a retenção.
 */

export interface IssuanceOrder {
  readonly orderId: string;
  readonly orderGid: string | null;
  readonly orderName: string | null;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly customerEmail: string | null;
}

export interface IssuanceEvent {
  readonly type: string;
  readonly detail?: Record<string, unknown>;
}

export type IssuanceMode = 'enforce' | 'override';

export interface IssueInput {
  readonly campaignId: string;
  readonly order: IssuanceOrder;
  /** Unidades comerciais compradas neste pedido para esta campanha. */
  readonly units: number;
  /** `enforce`: emissão automática. `override`: resolução administrativa; nenhum modo ultrapassa o teto configurado da campanha. */
  readonly mode: IssuanceMode;
  readonly actor?: { readonly id: string; readonly name: string };
  /** Justificativa gravada na retenção quando esta emissão a resolve (resolução administrativa). */
  readonly resolutionNote?: string;
  readonly now?: Date;
}

export type IssuanceOutcome =
  | { readonly mode: 'legacy' }
  | {
      readonly mode: 'benefits';
      /** Unidades novas emitidas agora (2 vouchers cada). */
      readonly issuedUnits: number;
      /** Unidades que já existiam incompletas e foram completadas. */
      readonly completedUnits: number;
      /** Unidades que ficaram sem emissão (retenção aberta). */
      readonly heldUnits: number;
      readonly holdId: string | null;
      readonly vouchersCreated: number;
      readonly events: readonly IssuanceEvent[];
    };

type Tx = Prisma.TransactionClient;

@Injectable()
export class ValePassIssuanceService {
  private readonly logger = new Logger(ValePassIssuanceService.name);

  async issueForCampaign(tx: Tx, input: IssueInput): Promise<IssuanceOutcome> {
    const { campaignId, order, units } = input;
    if (!Number.isInteger(units) || units < 1) throw new RangeError('units deve ser um inteiro ≥ 1');
    const now = input.now ?? new Date();

    // Trava da campanha: a MESMA do painel (PR A). Ordem fixa de locks: operacional → webhook → pedido → campanha.
    await tx.$queryRaw`SELECT id FROM vale_pass_campaigns WHERE id = ${campaignId}::uuid FOR UPDATE`;
    const campaign = await tx.valePassCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new Error(`campanha ${campaignId} não encontrada`);

    const allBenefits = await tx.valePassCampaignBenefit.findMany({ where: { campaignId }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] });
    if (allBenefits.length === 0) return { mode: 'legacy' };
    const benefits = allBenefits.filter((benefit) => benefit.active && benefit.kind === 'VOUCHER');

    const events: IssuanceEvent[] = [];
    const existing = await tx.valePass.findMany({
      where: { shopifyOrderId: order.orderId, campaignId },
      select: { id: true, groupId: true, benefitId: true, status: true },
    });
    const legacyUnits = existing.filter((voucher) => voucher.groupId === null);
    const groups = new Map<string, { benefitIds: Set<string>; consumes: boolean }>();
    for (const voucher of existing) {
      if (voucher.groupId === null) continue;
      const group = groups.get(voucher.groupId) ?? { benefitIds: new Set<string>(), consumes: false };
      if (voucher.benefitId) group.benefitIds.add(voucher.benefitId);
      if (voucher.status !== 'CANCELLED') group.consumes = true;
      groups.set(voucher.groupId, group);
    }
    const unitsExisting = legacyUnits.length + groups.size;
    const consumingExisting = legacyUnits.filter((voucher) => voucher.status !== 'CANCELLED').length + [...groups.values()].filter((group) => group.consumes).length;
    // Reembolso já registrado (PR G) de unidades pagas e ainda NÃO emitidas: não se emite voucher para elas. Sem linhas na trilha o desconto é 0.
    const refundedUnissued = await this.refundedUnissuedUnits(tx, order.orderId);
    const toCreate = Math.max(0, units - unitsExisting - refundedUnissued);
    const incomplete = [...groups.entries()].filter(([, group]) => benefits.some((benefit) => !group.benefitIds.has(benefit.id)));

    const openHold = await tx.valePassIssuanceHold.findFirst({ where: { shopifyOrderId: order.orderId, campaignId, status: 'OPEN' } });

    // Nada a fazer (reentrega do mesmo pedido já emitido): idempotente.
    if (toCreate === 0 && incomplete.length === 0) {
      if (openHold) await this.closeHold(tx, openHold, 'DISMISSED', input, 'nenhuma unidade faltando: já emitido', null, now);
      events.push({ type: 'VALE_PASS_ALREADY_ISSUED', detail: { orderId: order.orderId, units: unitsExisting } });
      return { mode: 'benefits', issuedUnits: 0, completedUnits: 0, heldUnits: 0, holdId: null, vouchersCreated: 0, events };
    }

    // Prontidão: campanha com benefícios sem limite configurado, sem voucher ativo ou sem validade NÃO emite nem cai no legado — retém.
    const notReady = this.notReadyReason(campaign, benefits);
    if (notReady) {
      const heldUnits = Math.max(toCreate, incomplete.length);
      const hold = await this.upsertHold(tx, order.orderId, campaign, heldUnits, 'CAMPAIGN_NOT_READY', { reason: notReady });
      events.push({ type: 'VALE_PASS_ISSUANCE_HELD', detail: { orderId: order.orderId, campaignId, units: heldUnits, reason: 'CAMPAIGN_NOT_READY', note: notReady } });
      return { mode: 'benefits', issuedUnits: 0, completedUnits: 0, heldUnits, holdId: hold.id, vouchersCreated: 0, events };
    }

    const priorCancellation = await tx.valePassOrderCancellation.findUnique({ where: { shopifyOrderId: order.orderId } });

    // Reembolso deste pedido aguardando decisão de um ADMIN: não dá para saber quais unidades foram devolvidas, então NÃO se emite o que falta
    // (retenção administrativa, sem presumir cancelamento integral). A resolução ADMIN segue sujeita ao mesmo teto de capacidade.
    if (toCreate > 0 && input.mode === 'enforce' && (await tx.valePassRefundApplication.count({ where: { shopifyOrderId: order.orderId, status: 'NEEDS_REVIEW' } })) > 0) {
      const hold = await this.upsertHold(tx, order.orderId, campaign, toCreate, 'FINANCIAL_MISMATCH', { issues: [{ code: 'REFUND_PENDING_REVIEW' }] as unknown as Prisma.InputJsonValue });
      events.push({ type: 'VALE_PASS_ISSUANCE_HELD', detail: { orderId: order.orderId, campaignId, units: toCreate, reason: 'FINANCIAL_MISMATCH', note: 'reembolso aguardando decisão administrativa' } });
      return { mode: 'benefits', issuedUnits: 0, completedUnits: 0, heldUnits: toCreate, holdId: hold.id, vouchersCreated: 0, events };
    }

    // Capacidade: todos os modos respeitam o teto configurado (globalLimit, ou quantityLimit legado quando globalLimit é nulo).
    // Só unidades NOVAS consomem; completar uma unidade existente não consome capacidade. Pedido já cancelado/reembolsado é criado e
    // cancelado na mesma transação, portanto não permanece consumindo capacidade.
    const capacityLimit = configuredCapacityLimit(campaign.globalLimit, campaign.quantityLimit);
    if (toCreate > 0 && capacityLimit !== null && !priorCancellation) {
      const { totals } = await loadCapacity(tx, campaignId, order.orderId);
      const allowed = Math.max(0, capacityLimit - totals.consumed - consumingExisting);
      if (toCreate > allowed) {
        const hold = await this.upsertHold(tx, order.orderId, campaign, toCreate, 'CAPACITY_EXCEEDED', {
          globalLimit: campaign.globalLimit,
          capacityLimit,
          consumedWithoutThisOrder: totals.consumed,
          alreadyConsumingInThisOrder: consumingExisting,
          allowedUnits: allowed,
        });
        events.push({
          type: 'VALE_PASS_ISSUANCE_HELD',
          detail: { orderId: order.orderId, campaignId, units: toCreate, reason: 'CAPACITY_EXCEEDED', globalLimit: campaign.globalLimit, capacityLimit, allowedUnits: allowed },
        });
        // Completar o que já existe não depende de capacidade: faz mesmo assim.
        const completed = await this.completeGroups(tx, incomplete, benefits, campaign, order, now, events);
        return { mode: 'benefits', issuedUnits: 0, completedUnits: completed.units, heldUnits: toCreate, holdId: hold.id, vouchersCreated: completed.vouchers, events };
      }
    }

    const completed = await this.completeGroups(tx, incomplete, benefits, campaign, order, now, events, priorCancellation?.topic);
    let created = 0;
    for (let unit = 0; unit < toCreate; unit++) {
      const groupId = randomUUID();
      for (const benefit of benefits) {
        await this.createVoucher(tx, { campaign, benefit, groupId, order, now, events, cancelWithTopic: priorCancellation?.topic });
        created++;
      }
    }

    if (openHold) {
      await this.closeHold(tx, openHold, 'ISSUED', input, input.resolutionNote ?? (input.actor ? 'emitido pela resolução administrativa' : 'emitido automaticamente em reprocessamento'), toCreate + completed.units, now);
    }
    events.push({
      type: 'VALE_PASS_UNITS_ISSUED',
      detail: { orderId: order.orderId, campaignId, units: toCreate, completedUnits: completed.units, vouchers: created + completed.vouchers, mode: input.mode, benefits: benefits.map((benefit) => benefit.code) },
    });
    return { mode: 'benefits', issuedUnits: toCreate, completedUnits: completed.units, heldUnits: 0, holdId: null, vouchersCreated: created + completed.vouchers, events };
  }

  /**
   * Retém um pedido PAGO cuja validação financeira (valor, moeda, quantidade, desconto) deu problema. Não emite, não cancela e não reembolsa: abre
   * (ou atualiza) UMA retenção aberta por pedido e campanha para um ADMIN resolver dentro da capacidade configurada, ou descartar depois de
   * reembolsar na Shopify. A unidade retida continua contando como consumida. Idempotente: reentrega não duplica; se o
   * pedido já tem vouchers da campanha, não abre retenção (já foi tratado). ISOLADO: nenhum fluxo ativo chama este método.
   */
  /** Soma, na trilha de reembolsos, das unidades pagas e não emitidas já descontadas. Pedido sem reembolso registrado: 0. */
  private async refundedUnissuedUnits(tx: Tx, orderId: string): Promise<number> {
    const rows = await tx.valePassRefundApplication.findMany({ where: { shopifyOrderId: orderId }, select: { detail: true } });
    return rows.reduce((sum, row) => sum + Math.max(0, Number((row.detail as { unissuedAbsorbed?: unknown } | null)?.unissuedAbsorbed ?? 0) || 0), 0);
  }

  async holdForFinancialReview(
    tx: Tx,
    input: { campaignId: string; order: IssuanceOrder; units: number; issues: readonly { code: string; detail?: Record<string, unknown> }[]; allowWithExistingVouchers?: boolean },
  ): Promise<{ holdId: string | null; created: boolean }> {
    if (!Number.isInteger(input.units) || input.units < 1) throw new RangeError('units deve ser um inteiro ≥ 1');
    await tx.$queryRaw`SELECT id FROM vale_pass_campaigns WHERE id = ${input.campaignId}::uuid FOR UPDATE`; // mesma trava da emissão e do painel
    const campaign = await tx.valePassCampaign.findUnique({ where: { id: input.campaignId } });
    if (!campaign) throw new Error(`campanha ${input.campaignId} não encontrada`);
    const alreadyIssued = await tx.valePass.count({ where: { shopifyOrderId: input.order.orderId, campaignId: input.campaignId } });
    // `allowWithExistingVouchers` (regularização de unidades adicionais): o pedido já tem vouchers, mas faltam unidades pagas — a retenção é o registro durável.
    if (alreadyIssued > 0 && !input.allowWithExistingVouchers) return { holdId: null, created: false };
    const open = await tx.valePassIssuanceHold.findFirst({ where: { shopifyOrderId: input.order.orderId, campaignId: input.campaignId, status: 'OPEN' } });
    const hold = await this.upsertHold(tx, input.order.orderId, campaign, input.units, 'FINANCIAL_MISMATCH', { issues: input.issues as unknown as Prisma.InputJsonValue });
    return { holdId: hold.id, created: open === null };
  }

  private notReadyReason(campaign: ValePassCampaign, benefits: readonly ValePassCampaignBenefit[]): string | null {
    if (benefits.length === 0) return 'a campanha tem benefícios cadastrados, mas nenhum voucher ativo';
    if (configuredCapacityLimit(campaign.globalLimit, campaign.quantityLimit) === null) return 'a campanha com benefícios não tem limite de capacidade configurado';
    if (!campaign.voucherValidFrom || !campaign.voucherValidUntil) return 'a campanha não tem a validade dos vouchers configurada (início e fim)';
    return null;
  }

  private async completeGroups(
    tx: Tx,
    incomplete: readonly (readonly [string, { benefitIds: Set<string> }])[],
    benefits: readonly ValePassCampaignBenefit[],
    campaign: ValePassCampaign,
    order: IssuanceOrder,
    now: Date,
    events: IssuanceEvent[],
    cancelWithTopic?: string,
  ): Promise<{ units: number; vouchers: number }> {
    let vouchers = 0;
    for (const [groupId, group] of incomplete) {
      for (const benefit of benefits) {
        if (group.benefitIds.has(benefit.id)) continue;
        await this.createVoucher(tx, { campaign, benefit, groupId, order, now, events, cancelWithTopic });
        vouchers++;
      }
    }
    return { units: incomplete.length, vouchers };
  }

  private async createVoucher(
    tx: Tx,
    args: { campaign: ValePassCampaign; benefit: ValePassCampaignBenefit; groupId: string; order: IssuanceOrder; now: Date; events: IssuanceEvent[]; cancelWithTopic?: string },
  ): Promise<void> {
    const { campaign, benefit, groupId, order, now, events } = args;
    const window = voucherWindow(formatIsoDate(campaign.voucherValidFrom) as string, formatIsoDate(campaign.voucherValidUntil) as string, resolveValidityTimezone());
    if (benefit.company === null || benefit.amountCents === null) throw new Error(`benefício ${benefit.code} sem empresa ou valor`);
    const code = await this.generateUniqueCode(tx);
    const created = await tx.valePass.create({
      data: {
        code,
        campaignId: campaign.id,
        amountCents: benefit.amountCents,
        status: 'ACTIVE',
        purchasedAt: now,
        validFrom: window.validFrom,
        expiresAt: window.expiresAt,
        company: benefit.company,
        groupId,
        benefitId: benefit.id,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        customerEmail: order.customerEmail,
        shopifyOrderId: order.orderId,
        shopifyOrderGid: order.orderGid,
        shopifyOrderName: order.orderName,
      },
    });
    await tx.valePassEvent.create({
      data: { valePassId: created.id, type: 'CREATED', detail: { orderId: order.orderId, campaignId: campaign.id, groupId, company: benefit.company, benefit: benefit.code } },
    });
    // Sem o código no evento: o código só existe no voucher (e, depois, no e-mail ao cliente).
    events.push({ type: 'VALE_PASS_CREATED', detail: { valePassId: created.id, groupId, company: benefit.company, benefit: benefit.code, orderId: order.orderId, campaignId: campaign.id } });

    if (args.cancelWithTopic) {
      // Mesmo comportamento do legado: pedido já cancelado/reembolsado antes da emissão → emitido e cancelado na mesma transação.
      const changed = await tx.valePass.updateMany({
        where: { id: created.id, status: 'ACTIVE' },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: null, cancelReason: args.cancelWithTopic },
      });
      if (changed.count === 1) {
        await tx.valePassEvent.create({
          data: { valePassId: created.id, type: 'CANCELLED', detail: { orderId: order.orderId, reason: args.cancelWithTopic, source: 'shopify', note: 'pedido já confirmado como cancelado/reembolsado antes da emissão' } },
        });
        events.push({ type: 'VALE_PASS_CANCELLED', detail: { valePassId: created.id, orderId: order.orderId, reason: args.cancelWithTopic } });
      }
    }
  }

  private async upsertHold(
    tx: Tx,
    orderId: string,
    campaign: ValePassCampaign,
    units: number,
    reason: 'CAPACITY_EXCEEDED' | 'CAMPAIGN_NOT_READY' | 'FINANCIAL_MISMATCH',
    detail: Record<string, unknown>,
  ): Promise<ValePassIssuanceHold> {
    const open = await tx.valePassIssuanceHold.findFirst({ where: { shopifyOrderId: orderId, campaignId: campaign.id, status: 'OPEN' } });
    if (open) return tx.valePassIssuanceHold.update({ where: { id: open.id }, data: { units, reason, detail: detail as Prisma.InputJsonValue } });
    return tx.valePassIssuanceHold.create({
      data: { shopifyOrderId: orderId, campaignId: campaign.id, units, reason, status: 'OPEN', openFlag: true, detail: detail as Prisma.InputJsonValue },
    });
  }

  private async closeHold(tx: Tx, hold: ValePassIssuanceHold, status: 'ISSUED' | 'DISMISSED', input: IssueInput, note: string, issuedUnits: number | null, now: Date): Promise<void> {
    await tx.valePassIssuanceHold.update({
      where: { id: hold.id },
      data: { status, openFlag: null, resolvedAt: now, resolvedBy: input.actor?.id ?? null, resolutionNote: note, issuedUnits },
    });
  }

  private async generateUniqueCode(tx: Tx): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateValePassCode();
      const existing = await tx.valePass.findUnique({ where: { code }, select: { id: true } });
      if (!existing) return code;
    }
    throw new Error('Não foi possível gerar um código único para o Valle Pass após 5 tentativas.');
  }
}
