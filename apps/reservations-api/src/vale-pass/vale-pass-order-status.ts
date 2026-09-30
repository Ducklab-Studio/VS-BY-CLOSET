import type { ValePassOrderStatus } from '@prisma/client';

/**
 * Regras puras do pedido de Valle Pass (sem banco): o que é um pedido de Valle
 * Pass, qual o status dele a partir do estado da Shopify, e quando um estado
 * novo pode substituir o gravado. Webhook e reconciliação usam as MESMAS.
 */

/** Parte numérica de um id da Shopify — aceita o número cru ou o GID. */
export function numericShopifyId(raw: string | number | null | undefined): string | null {
  if (raw == null) return null;
  const match = String(raw).trim().match(/(\d+)$/);
  return match ? match[1] : null;
}

function lastDigits(raw: string): string {
  const match = raw.match(/(\d+)\s*$/);
  return match ? match[1] : raw;
}

/** Mesmo produto/variante reais do frontend (apps/marketing/src/lib/vale-pass-product.ts);
 *  configuráveis por ambiente pelo mesmo motivo (produto recriado sem rebuild).
 *  Único lugar que resolve "qual é o Valle Pass real" — o webhook e
 *  scripts/backfill-vale-pass-voucher.ts reusam daqui. */
export const KNOWN_VALE_PASS_VARIANT_ID = lastDigits(process.env.VALE_PASS_VARIANT_ID?.trim() || '49174518595684');
export const KNOWN_VALE_PASS_PRODUCT_ID = lastDigits(process.env.VALE_PASS_PRODUCT_ID?.trim() || '8723909804132');

export interface OrderLine {
  readonly variantId: string | number | null | undefined;
  readonly productId?: string | number | null | undefined;
  readonly quantity: number;
}

/**
 * Unidades de Valle Pass no pedido. Linha é de Valle Pass se o produto for o
 * do Valle Pass ou a variante for a conhecida ou a de alguma campanha. Zero =
 * não é pedido de Valle Pass (pedido de aluguel ou de outro produto): nunca é
 * importado.
 */
export function valePassUnits(lines: readonly OrderLine[], campaignVariantIds: Iterable<string>): number {
  const variants = new Set<string>([KNOWN_VALE_PASS_VARIANT_ID]);
  for (const id of campaignVariantIds) {
    const numeric = numericShopifyId(id);
    if (numeric) variants.add(numeric);
  }
  let units = 0;
  for (const line of lines) {
    const variant = numericShopifyId(line.variantId);
    const product = numericShopifyId(line.productId);
    const isValePass = (variant !== null && variants.has(variant)) || product === KNOWN_VALE_PASS_PRODUCT_ID;
    if (isValePass && Number.isFinite(line.quantity) && line.quantity > 0) units += line.quantity;
  }
  return units;
}

export interface ShopifyPaymentState {
  readonly financialStatus: string | null | undefined;
  readonly cancelledAt: string | null | undefined;
  readonly cancelReason: string | null | undefined;
}

/**
 * Status do pedido a partir da Shopify. Só `paid` confirma: pendente,
 * autorizado ou parcialmente pago continuam PENDING (nunca tratados como pagos).
 * Cancelado pela Shopify: expirado continua EXPIRED (é o que a loja vê),
 * pagamento recusado vira DECLINED, o resto CANCELLED.
 */
export function deriveValePassOrderStatus(state: ShopifyPaymentState): ValePassOrderStatus {
  const financial = state.financialStatus?.trim().toLowerCase() ?? '';
  if (state.cancelledAt) {
    if (financial === 'expired') return 'EXPIRED';
    if (state.cancelReason?.trim().toLowerCase() === 'declined' || financial === 'voided') return 'DECLINED';
    return 'CANCELLED';
  }
  if (financial === 'refunded' || financial === 'partially_refunded') return 'REFUNDED';
  if (financial === 'expired') return 'EXPIRED';
  if (financial === 'voided') return 'DECLINED';
  if (financial === 'paid') return 'CONFIRMED';
  return 'PENDING';
}

/**
 * Contador do menu ("pedidos para ver"): pedidos que ainda pedem ação do
 * operador — pendente de pagamento ou pago — e que ninguém viu NESTE status.
 * Expirado, cancelado, recusado e reembolsado nunca contam. Mudou de status
 * depois de visto (pendente → pago)? Volta a contar. Global para a equipe:
 * visto por um operador, visto por todos.
 */
export const ATTENTION_STATUSES: readonly ValePassOrderStatus[] = ['PENDING', 'CONFIRMED'];

export function needsAttention(order: { status: ValePassOrderStatus; viewedAt: Date | null; statusChangedAt: Date }): boolean {
  return ATTENTION_STATUSES.includes(order.status) && (!order.viewedAt || order.viewedAt < order.statusChangedAt);
}

/** PENDING < CONFIRMED < finais (expirado, recusado, cancelado, reembolsado). */
const RANK: Record<ValePassOrderStatus, number> = { PENDING: 0, CONFIRMED: 1, EXPIRED: 2, DECLINED: 2, CANCELLED: 2, REFUNDED: 2 };

/**
 * Pode trocar `from` por `to`? `freshness` compara o `updated_at` do estado
 * recebido com o já aplicado:
 *  - `older`: webhook atrasado/fora de ordem — nunca aplica;
 *  - `newer`: a Shopify é a fonte — aplica (um expirado pago depois confirma,
 *    um confirmado que expira deixa de estar confirmado);
 *  - `same`/`unknown` (sem data para comparar): só avança, nunca recua.
 * Nunca volta para PENDING: pedido que saiu de pendente não "despaga".
 */
export function canReplaceValePassOrderStatus(from: ValePassOrderStatus, to: ValePassOrderStatus, freshness: 'older' | 'same' | 'newer' | 'unknown'): boolean {
  if (from === to || freshness === 'older' || to === 'PENDING') return false;
  if (freshness === 'newer') return true;
  return RANK[to] > RANK[from];
}

export function compareFreshness(applied: Date | null, incoming: Date | null): 'older' | 'same' | 'newer' | 'unknown' {
  if (!applied || !incoming) return 'unknown';
  const diff = incoming.getTime() - applied.getTime();
  return diff < 0 ? 'older' : diff === 0 ? 'same' : 'newer';
}
