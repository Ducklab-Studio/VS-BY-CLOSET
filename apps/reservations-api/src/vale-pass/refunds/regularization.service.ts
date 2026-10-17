import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { lockShopifyOrder } from '../../webhooks/shopify-order-lock';
import type { OrderFinancialFacts } from '../financial/order-facts';
import { ValePassFinancialGuard, summarizeIssues } from '../financial/financial-guard.service';
import { PASS_UNIT_KEY } from '../vale-pass-capacity';
import { ValePassIssuanceService } from '../vale-pass-issuance.service';

type Tx = Prisma.TransactionClient;

export interface RegularizationCandidate {
  readonly orderId: string;
  readonly orderName: string | null;
  /** Unidades pagas segundo o registro do pedido. */
  readonly quantity: number;
  /** Unidades já emitidas (inclui as canceladas por reembolso: unidade devolvida NÃO volta a ser emitida). */
  readonly issuedUnits: number;
  readonly missing: number;
  /** NOT_PROCESSED = nenhuma unidade emitida; QUANTITY_INCREASED = já havia unidades e o pedido cresceu. */
  readonly kind: 'NOT_PROCESSED' | 'QUANTITY_INCREASED';
  readonly hasOpenHold: boolean;
  /** Pedido com vouchers do modelo antigo: não é regularizado por aqui. */
  readonly legacy: boolean;
}

export type RegularizationOutcome =
  | { readonly status: 'NOT_PAID' } // pedido não está pago/ativo: nada a regularizar
  | { readonly status: 'LEGACY_ORDER' }
  | { readonly status: 'NOTHING_TO_DO' }
  | { readonly status: 'CAMPAIGN_UNRESOLVED' } // não foi possível saber a campanha: precisa de uma pessoa
  | { readonly status: 'FACTS_MISMATCH' } // os fatos financeiros recebidos não são deste pedido
  | { readonly status: 'HELD'; readonly holdId: string | null; readonly missing: number; readonly reason: 'FINANCIAL_MISMATCH' | 'CAPACITY_EXCEEDED' | 'CAMPAIGN_NOT_READY' }
  | { readonly status: 'ISSUED'; readonly issuedUnits: number; readonly vouchersCreated: number };

/**
 * Regularização de unidades pagas que ainda não têm os dois vouchers (ex.: a compra cresceu depois do pagamento). ISOLADA: nada a chama.
 * Nunca emite sem antes revalidar os fatos financeiros ATUAIS do pedido (PR E): se algo não fecha, vira retenção administrativa — nunca emissão
 * silenciosa, nunca descarte. Idempotente: usa a emissão do PR B, que completa só o que falta, e unidades devolvidas por reembolso contam como emitidas.
 */
@Injectable()
export class ValePassRegularizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly guard: ValePassFinancialGuard,
    private readonly issuance: ValePassIssuanceService,
  ) {}

  /** Lista (somente leitura) os pedidos pagos com menos unidades emitidas do que o registro diz. */
  async findCandidates(limit = 100): Promise<RegularizationCandidate[]> {
    const rows = await this.prisma.$queryRaw<
      { orderId: string; orderName: string | null; quantity: number; issued: number; legacy: boolean; hasOpenHold: boolean }[]
    >`
      SELECT o.shopify_order_id AS "orderId", o.shopify_order_name AS "orderName", o.quantity,
             count(DISTINCT ${PASS_UNIT_KEY})::int AS issued,
             coalesce(bool_or(v.id IS NOT NULL AND v.group_id IS NULL), false) AS legacy,
             EXISTS (SELECT 1 FROM vale_pass_issuance_holds h WHERE h.shopify_order_id = o.shopify_order_id AND h.status = 'OPEN') AS "hasOpenHold"
      FROM vale_pass_orders o
      LEFT JOIN vale_passes v ON v.shopify_order_id = o.shopify_order_id
      WHERE o.status = 'CONFIRMED' AND o.deleted_in_shopify_at IS NULL
      GROUP BY o.id
      HAVING count(DISTINCT ${PASS_UNIT_KEY}) < o.quantity
      ORDER BY o.order_created_at NULLS LAST, o.id
      LIMIT ${Math.min(limit, 500)}`;
    return rows.map((row) => ({
      orderId: row.orderId,
      orderName: row.orderName,
      quantity: row.quantity,
      issuedUnits: row.issued,
      missing: row.quantity - row.issued,
      kind: row.issued === 0 ? 'NOT_PROCESSED' : 'QUANTITY_INCREASED',
      hasOpenHold: row.hasOpenHold,
      legacy: row.legacy,
    }));
  }

  async regularize(tx: Tx, input: { orderId: string; facts: OrderFinancialFacts }): Promise<RegularizationOutcome> {
    await lockShopifyOrder(tx, input.orderId);
    const order = await tx.valePassOrder.findUnique({ where: { shopifyOrderId: input.orderId } });
    const cancelled = await tx.valePassOrderCancellation.findUnique({ where: { shopifyOrderId: input.orderId } });
    if (!order || order.status !== 'CONFIRMED' || order.deletedInShopifyAt || cancelled) return { status: 'NOT_PAID' };
    if (input.facts.orderId !== null && input.facts.orderId !== input.orderId) return { status: 'FACTS_MISMATCH' };

    const existing = await tx.valePass.findMany({ where: { shopifyOrderId: input.orderId }, select: { groupId: true, campaignId: true } });
    if (existing.some((voucher) => voucher.groupId === null)) return { status: 'LEGACY_ORDER' };
    const unitsExisting = new Set(existing.map((voucher) => voucher.groupId)).size;
    const missing = order.quantity - unitsExisting;
    if (missing <= 0) return { status: 'NOTHING_TO_DO' };

    const verdict = await this.guard.evaluate(tx, input.facts);
    const campaignIds = [...new Set([...existing.map((voucher) => voucher.campaignId), ...verdict.campaignIds])];
    if (campaignIds.length !== 1) return { status: 'CAMPAIGN_UNRESOLVED' };
    const campaignId = campaignIds[0];
    const issuanceOrder = {
      orderId: order.shopifyOrderId, orderGid: order.shopifyOrderGid, orderName: order.shopifyOrderName,
      customerName: order.customerName, customerPhone: order.customerPhone, customerEmail: order.customerEmail,
    };

    // O registro do pedido e o que a Shopify mostra agora precisam concordar na quantidade; senão uma pessoa decide.
    const issues = verdict.ok
      ? verdict.units === order.quantity
        ? []
        : [{ code: 'QUANTITY_CHANGED', detail: { registryUnits: order.quantity, orderUnits: verdict.units } }]
      : summarizeIssues(verdict.issues);
    if (issues.length > 0) {
      const held = await this.issuance.holdForFinancialReview(tx, { campaignId, order: issuanceOrder, units: missing, issues, allowWithExistingVouchers: true });
      return { status: 'HELD', holdId: held.holdId, missing, reason: 'FINANCIAL_MISMATCH' };
    }

    const outcome = await this.issuance.issueForCampaign(tx, { campaignId, order: issuanceOrder, units: order.quantity, mode: 'enforce' });
    if (outcome.mode !== 'benefits') return { status: 'CAMPAIGN_UNRESOLVED' };
    if (outcome.heldUnits > 0) {
      const hold = await tx.valePassIssuanceHold.findUnique({ where: { id: outcome.holdId ?? '' } });
      return { status: 'HELD', holdId: outcome.holdId, missing: outcome.heldUnits, reason: hold?.reason === 'CAMPAIGN_NOT_READY' ? 'CAMPAIGN_NOT_READY' : 'CAPACITY_EXCEEDED' };
    }
    return { status: 'ISSUED', issuedUnits: outcome.issuedUnits, vouchersCreated: outcome.vouchersCreated };
  }
}
