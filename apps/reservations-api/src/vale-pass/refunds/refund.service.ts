import { ConflictException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ValePassRefundApplication, ValePassRefundStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { writeAdminAuditEvent } from '../../admin/admin-audit';
import { lockShopifyOrder } from '../../webhooks/shopify-order-lock';
import { KNOWN_VALE_PASS_PRODUCT_ID, KNOWN_VALE_PASS_VARIANT_ID, numericShopifyId } from '../vale-pass-order-status';
import type { RefundFacts, RefundLineFacts } from './refund-facts';
import { planRefund, type IssuedUnitPolicy, type RefundPlan, type UnitState, type VoucherStatus } from './refund-plan';

type Tx = Prisma.TransactionClient;
export const MIN_REVIEW_NOTE = 10;
const TX = { timeout: 20_000, maxWait: 5_000 } as const;

export type RefundOutcome =
  /** O pedido não é de Valle Pass (ou o pedido não está no registro): nada a fazer aqui. */
  | { readonly status: 'NOT_VALE_PASS' }
  /** O pedido tem vouchers LEGADOS (sem unidade): quem chamou deve seguir o caminho legado, que continua exatamente como era. */
  | { readonly status: 'LEGACY_ORDER' }
  /** Este reembolso já foi tratado (reentrega): nada foi feito de novo. */
  | { readonly status: 'DUPLICATE'; readonly application: ValePassRefundApplication }
  | { readonly status: 'APPLIED' | 'NEEDS_REVIEW'; readonly application: ValePassRefundApplication; readonly cancelledVouchers: number };

export interface RefundReviewItem {
  readonly id: string;
  readonly shopifyRefundId: string;
  readonly shopifyOrderId: string;
  readonly shopifyOrderName: string | null;
  readonly classification: string;
  readonly refundedUnits: number;
  readonly cancelledUnits: number;
  readonly unitsNeedingReview: number;
  readonly reasons: readonly string[];
  readonly status: ValePassRefundStatus;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly resolution: string | null;
}

/** Unidades pagas e não emitidas que reembolsos anteriores do pedido já descontaram (a emissão posterior as desconta também). */
export async function absorbedUnissuedUnits(tx: Pick<Tx, 'valePassRefundApplication'>, orderId: string): Promise<number> {
  const rows = await tx.valePassRefundApplication.findMany({ where: { shopifyOrderId: orderId }, select: { detail: true } });
  return rows.reduce((sum, row) => sum + Number((row.detail as { unissuedAbsorbed?: unknown } | null)?.unissuedAbsorbed ?? 0), 0);
}

const asStringArray = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);

/**
 * Tratamento de reembolsos do Valle Pass POR UNIDADE (PR G). ISOLADO: nada do fluxo ativo o chama — o webhook continua cancelando tudo pelo caminho
 * legado até a integração (PR F) ser autorizada.
 *
 * PONTO DE INTEGRAÇÃO FUTURO: `WebhooksService.handleRefundCreated` e `ValePassWebhookService.handleOrderWebhook('refunds/create')`, sob o lock do pedido:
 *   const outcome = await this.refunds.apply(tx, factsFromRefundWebhook(payload));
 *   if (outcome.status === 'LEGACY_ORDER' || outcome.status === 'NOT_VALE_PASS') → caminho de sempre (`handleOrderCancelledOrRefunded`).
 */
@Injectable()
export class ValePassRefundService {
  private readonly logger = new Logger(ValePassRefundService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Aplica um reembolso dentro de uma transação que o chamador abriu (o lock do pedido é tomado aqui também; é reentrante). */
  async apply(tx: Tx, refund: RefundFacts, options: { policy?: IssuedUnitPolicy } = {}): Promise<RefundOutcome> {
    if (!refund.orderId || !refund.refundId) {
      // Sem identidade não há idempotência possível: não age. O chamador registra o evento recebido e segue o caminho de sempre.
      return { status: 'NOT_VALE_PASS' };
    }
    await lockShopifyOrder(tx, refund.orderId);

    const duplicate = await tx.valePassRefundApplication.findUnique({ where: { shopifyRefundId: refund.refundId } });
    if (duplicate) return { status: 'DUPLICATE', application: duplicate };

    const campaigns = await tx.valePassCampaign.findMany({ select: { id: true, shopifyVariantId: true, amountCents: true } });
    const unitPriceByVariant = new Map<string, number>();
    const campaignByVariant = new Map<string, string>();
    for (const campaign of campaigns) {
      const variant = numericShopifyId(campaign.shopifyVariantId);
      if (variant) {
        unitPriceByVariant.set(variant, campaign.amountCents);
        campaignByVariant.set(variant, campaign.id);
      }
    }
    const isValePassLine = (line: RefundLineFacts): boolean => {
      const variant = numericShopifyId(line.variantId);
      const product = numericShopifyId(line.productId);
      return (variant !== null && (unitPriceByVariant.has(variant) || variant === KNOWN_VALE_PASS_VARIANT_ID)) || product === KNOWN_VALE_PASS_PRODUCT_ID;
    };
    const valeLines = refund.lines.filter(isValePassLine);
    const valeQuantity = valeLines.reduce((sum, line) => sum + (line.quantity ?? 0), 0);

    // Webhook FORA DE ORDEM: o reembolso pode chegar antes de o pedido existir no registro. Se ele traz linha de Valle Pass, o fato é gravado na mesma
    // trilha (assumindo que as unidades reembolsadas ainda não foram emitidas) e a emissão posterior as desconta; sem linha de Valle Pass, não é conosco.
    const order = await tx.valePassOrder.findUnique({ where: { shopifyOrderId: refund.orderId } });
    if (!order && valeQuantity === 0) return { status: 'NOT_VALE_PASS' };
    const vouchers = await tx.valePass.findMany({ where: { shopifyOrderId: refund.orderId }, orderBy: { createdAt: 'asc' } });
    if (vouchers.some((voucher) => voucher.groupId === null)) return { status: 'LEGACY_ORDER' };

    const byGroup = new Map<string, { createdAt: Date; vouchers: { id: string; status: VoucherStatus }[] }>();
    for (const voucher of vouchers) {
      const entry = byGroup.get(voucher.groupId as string) ?? { createdAt: voucher.createdAt, vouchers: [] };
      entry.vouchers.push({ id: voucher.id, status: voucher.status });
      if (voucher.createdAt < entry.createdAt) entry.createdAt = voucher.createdAt;
      byGroup.set(voucher.groupId as string, entry);
    }
    const units: UnitState[] = [...byGroup.entries()].map(([groupId, entry]) => ({ groupId, createdAt: entry.createdAt, vouchers: entry.vouchers }));
    const previous = await tx.valePassRefundApplication.aggregate({ where: { shopifyOrderId: refund.orderId }, _sum: { refundedUnits: true } });
    const absorbedBefore = await absorbedUnissuedUnits(tx, refund.orderId);
    const paidUnits = order?.quantity ?? Number.MAX_SAFE_INTEGER;
    const unissuedUnits = order ? Math.max(0, order.quantity - byGroup.size - absorbedBefore) : valeQuantity;

    const plan = planRefund({
      refund,
      isValePassLine,
      unitPriceByVariant,
      units,
      alreadyRefundedUnits: previous._sum.refundedUnits ?? 0,
      paidUnits,
      unissuedUnits,
      policy: options.policy,
    });

    // Cancela as unidades escolhidas (os DOIS vouchers de cada uma, juntos). Voucher que deixou de estar ACTIVE entre a leitura e a escrita é impossível
    // sob o lock do pedido; se acontecer, aborta a transação inteira (a Shopify reentrega) em vez de deixar uma unidade cancelada pela metade.
    let cancelledVouchers = 0;
    for (const groupId of plan.cancelGroupIds) {
      const expected = byGroup.get(groupId)?.vouchers.length ?? 0;
      const changed = await tx.valePass.updateMany({
        where: { groupId, shopifyOrderId: refund.orderId, status: 'ACTIVE' },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: null, cancelReason: `refund:${refund.refundId}` },
      });
      if (changed.count !== expected) throw new ConflictException('Unidade mudou de estado durante o reembolso; a transação foi desfeita para reprocessar.');
      cancelledVouchers += changed.count;
      for (const voucher of byGroup.get(groupId)?.vouchers ?? []) {
        await tx.valePassEvent.create({ data: { valePassId: voucher.id, type: 'CANCELLED', detail: { orderId: refund.orderId, reason: 'refund', refundId: refund.refundId, source: 'shopify', groupId } } });
      }
    }

    const status: ValePassRefundStatus = plan.reviewReasons.length > 0 ? 'NEEDS_REVIEW' : 'APPLIED';
    const firstLine = valeLines[0];
    const campaignId = vouchers[0]?.campaignId ?? (firstLine?.variantId ? campaignByVariant.get(numericShopifyId(firstLine.variantId) ?? '') ?? null : null);
    const application = await tx.valePassRefundApplication.create({
      data: {
        shopifyRefundId: refund.refundId,
        shopifyOrderId: refund.orderId,
        campaignId,
        classification: plan.classification,
        refundedUnits: plan.refundedUnits,
        cancelledGroupIds: plan.cancelGroupIds as unknown as Prisma.InputJsonValue,
        status,
        reviewReasons: plan.reviewReasons as unknown as Prisma.InputJsonValue,
        shippingRefundCents: refund.shippingRefundCents,
        transactionsCents: refund.transactionsCents,
        detail: this.detailOf(plan, refund, order?.quantity ?? null) as unknown as Prisma.InputJsonValue,
      },
    });
    return { status, application, cancelledVouchers };
  }

  private detailOf(plan: RefundPlan, refund: RefundFacts, paidUnits: number | null): Record<string, unknown> {
    return {
      paidUnits,
      reviewGroupIds: plan.reviewGroupIds,
      unitsNeedingReview: plan.unitsNeedingReview,
      unissuedAbsorbed: plan.unissuedAbsorbed,
      unissuedProposed: plan.unissuedProposed,
      orderKnown: paidUnits !== null,
      orderFullyRefunded: plan.orderFullyRefunded,
      lines: refund.lines.map((line) => ({ quantity: line.quantity, subtotalCents: line.subtotalCents, unitPriceCents: line.unitPriceCents, restockType: line.restockType })),
      transactionCount: refund.transactionCount,
      orderAdjustments: refund.orderAdjustmentCount,
    };
  }

  async listReviews(options: { status?: ValePassRefundStatus; limit?: number } = {}): Promise<RefundReviewItem[]> {
    const rows = await this.prisma.valePassRefundApplication.findMany({
      where: { status: options.status ?? 'NEEDS_REVIEW' },
      orderBy: { createdAt: 'asc' },
      take: Math.min(options.limit ?? 100, 200),
    });
    if (rows.length === 0) return [];
    const orders = await this.prisma.valePassOrder.findMany({ where: { shopifyOrderId: { in: [...new Set(rows.map((row) => row.shopifyOrderId))] } }, select: { shopifyOrderId: true, shopifyOrderName: true } });
    const names = new Map(orders.map((order) => [order.shopifyOrderId, order.shopifyOrderName]));
    return rows.map((row) => ({
      id: row.id,
      shopifyRefundId: row.shopifyRefundId,
      shopifyOrderId: row.shopifyOrderId,
      shopifyOrderName: names.get(row.shopifyOrderId) ?? null,
      classification: row.classification,
      refundedUnits: row.refundedUnits,
      cancelledUnits: asStringArray(row.cancelledGroupIds).length,
      unitsNeedingReview: Number((row.detail as { unitsNeedingReview?: unknown } | null)?.unitsNeedingReview ?? 0),
      reasons: asStringArray(row.reviewReasons),
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolution: row.resolution,
    }));
  }

  /**
   * Decisão administrativa sobre uma revisão (somente ADMIN, justificativa ≥ 10, auditoria crítica):
   *  - KEEP_VOUCHERS: mantém tudo como está (ex.: política comercial = voucher usado não se desfaz);
   *  - CANCEL_ACTIVE_VOUCHERS: cancela os vouchers AINDA ATIVOS das unidades que o sistema propôs (`detail.reviewGroupIds`, lidas do banco — o cliente
   *    da API não escolhe unidades). Voucher já usado NUNCA é alterado.
   */
  async resolveReview(
    id: string,
    input: { action: 'KEEP_VOUCHERS' | 'CANCEL_ACTIVE_VOUCHERS'; note: string },
    actor: { id: string; name: string },
  ): Promise<RefundReviewItem & { vouchersCancelled: number; unissuedUnitsApplied: number }> {
    const note = (input.note ?? '').trim();
    if (note.length < MIN_REVIEW_NOTE) throw new UnprocessableEntityException(`Informe a justificativa (mínimo de ${MIN_REVIEW_NOTE} caracteres).`);
    if (input.action !== 'KEEP_VOUCHERS' && input.action !== 'CANCEL_ACTIVE_VOUCHERS') throw new UnprocessableEntityException('Ação inválida.');
    let outcome = { vouchersCancelled: 0, unissuedUnitsApplied: 0 };
    try {
      await this.prisma.$transaction(async (tx) => {
        const located = await tx.valePassRefundApplication.findUnique({ where: { id } });
        if (!located) throw new NotFoundException('Revisão de reembolso não encontrada.');
        await lockShopifyOrder(tx, located.shopifyOrderId);
        const admin = await tx.adminUser.findUnique({ where: { id: actor.id }, select: { role: true, active: true } });
        if (!admin || !admin.active || admin.role !== 'ADMIN') throw new ForbiddenException('Somente um administrador pode resolver reembolsos em revisão.');
        const row = await tx.valePassRefundApplication.findUniqueOrThrow({ where: { id } });
        if (row.status !== 'NEEDS_REVIEW') throw new ConflictException('Esta revisão já foi resolvida.');

        let cancelled = 0;
        const proposedUnissued = Number((row.detail as { unissuedProposed?: unknown } | null)?.unissuedProposed ?? 0);
        const groups = asStringArray((row.detail as { reviewGroupIds?: unknown } | null)?.reviewGroupIds);
        if (input.action === 'CANCEL_ACTIVE_VOUCHERS') {
          if (groups.length === 0 && proposedUnissued === 0) throw new ConflictException('Não há unidades propostas para cancelar nesta revisão. Use "manter".');
          for (const groupId of groups) {
            const active = await tx.valePass.findMany({ where: { groupId, shopifyOrderId: row.shopifyOrderId, status: 'ACTIVE' }, select: { id: true } });
            if (active.length === 0) continue;
            await tx.valePass.updateMany({
              where: { groupId, shopifyOrderId: row.shopifyOrderId, status: 'ACTIVE' },
              data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: actor.id, cancelReason: `refund-review:${row.shopifyRefundId}` },
            });
            for (const voucher of active) {
              await tx.valePassEvent.create({ data: { valePassId: voucher.id, type: 'CANCELLED', detail: { orderId: row.shopifyOrderId, reason: 'refund-review', refundId: row.shopifyRefundId, source: 'admin', actorId: actor.id, groupId } } });
            }
            cancelled += active.length;
          }
        }
        // Confirmar o reembolso sobre unidades pagas e ainda NÃO emitidas: a emissão posterior passa a descontá-las.
        const appliedUnissued = input.action === 'CANCEL_ACTIVE_VOUCHERS' ? proposedUnissued : 0;
        const detail = { ...((row.detail as Record<string, unknown> | null) ?? {}), unissuedAbsorbed: Number((row.detail as { unissuedAbsorbed?: unknown } | null)?.unissuedAbsorbed ?? 0) + appliedUnissued, unissuedProposed: 0 };
        outcome = { vouchersCancelled: cancelled, unissuedUnitsApplied: appliedUnissued };
        await tx.valePassRefundApplication.update({
          where: { id },
          data: { detail: detail as unknown as Prisma.InputJsonValue, status: 'RESOLVED', resolution: input.action, resolvedAt: new Date(), resolvedBy: actor.id, resolutionNote: note },
        });
        await writeAdminAuditEvent(tx, {
          adminUserId: actor.id,
          adminUserName: actor.name,
          action: 'VALE_PASS_REFUND_REVIEW_RESOLVED',
          entityType: 'ValePassRefundApplication',
          entityId: row.id,
          before: { status: 'NEEDS_REVIEW', reasons: asStringArray(row.reviewReasons), refundedUnits: row.refundedUnits },
          after: { status: 'RESOLVED', resolution: input.action, vouchersCancelled: cancelled, unissuedUnitsApplied: appliedUnissued },
          detail: { orderId: row.shopifyOrderId, refundId: row.shopifyRefundId, note },
        });
      }, TX);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`Falha ao resolver revisão de reembolso: ${err instanceof Error ? err.name : 'unknown'}`);
      throw new ServiceUnavailableException('Não foi possível resolver a revisão no momento.');
    }
    const [item] = (await this.listReviews({ status: 'RESOLVED', limit: 200 })).filter((entry) => entry.id === id);
    if (!item) throw new NotFoundException('Revisão de reembolso não encontrada.');
    return { ...item, ...outcome };
  }
}
