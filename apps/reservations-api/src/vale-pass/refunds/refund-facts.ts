import { parseMoneyCents, sumCents, type Cents } from '../financial/money';

/**
 * Fatos de um REEMBOLSO da Shopify (webhook `refunds/create`), extraídos sem presumir nada: campo ausente ou ilegível vira `null`.
 *
 * Estrutura REAL confirmada nos webhooks guardados da loja (só nomes e tipos) e na documentação oficial (Refund REST/GraphQL):
 *  - `refund_line_items[]`: `line_item_id`, `quantity`, `subtotal` e `total_tax` (NÚMEROS no payload real; a documentação mostra texto em outros pontos),
 *    `restock_type` (`cancel` | `return` | `no_restock`), `line_item` aninhado com `variant_id`, `product_id`, `price` (texto) e `quantity`;
 *  - `refund_shipping_lines[]`: `subtotal_amount_set.shop_money.amount` (texto) — o frete reembolsado aparece AQUI (e em `order_adjustments`);
 *  - `transactions[]`: `amount` (texto), `kind`, `status`, `currency` — vazio quando nenhum dinheiro foi devolvido (ex.: cancelamento de pedido não pago);
 *  - o `subtotal` de uma linha, sem desconto, é preço × quantidade (o imposto já está incluído no preço na loja: `taxes_included`).
 * Não é possível saber QUAL unidade foi reembolsada: a Shopify só informa a linha e a quantidade.
 */
export interface RefundLineFacts {
  readonly lineItemId: string | null;
  readonly variantId: string | null;
  readonly productId: string | null;
  readonly quantity: number | null;
  readonly subtotalCents: Cents | null;
  /** Preço unitário informado no `line_item` aninhado (antes de descontos). */
  readonly unitPriceCents: Cents | null;
  readonly restockType: string | null;
}

export interface RefundFacts {
  readonly refundId: string | null;
  readonly orderId: string | null;
  readonly lines: readonly RefundLineFacts[];
  /** Soma do frete reembolsado; `0` se não há linhas de frete; `null` se alguma está ilegível. */
  readonly shippingRefundCents: Cents | null;
  readonly transactionCount: number;
  /** Soma das transações de reembolso bem-sucedidas; `null` se alguma está ilegível. */
  readonly transactionsCents: Cents | null;
  readonly orderAdjustmentCount: number;
}

const rec = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const idText = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && value.trim() !== '') return value.trim().split('/').pop() ?? null;
  return null;
};
const whole = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) ? value : null);

export function factsFromRefundWebhook(payload: unknown): RefundFacts {
  const refund = rec(payload) ?? {};
  const lines = list(refund.refund_line_items).map((raw): RefundLineFacts => {
    const line = rec(raw) ?? {};
    const item = rec(line.line_item);
    return {
      lineItemId: idText(line.line_item_id),
      variantId: idText(item?.variant_id),
      productId: idText(item?.product_id),
      quantity: whole(line.quantity),
      subtotalCents: parseMoneyCents(line.subtotal),
      unitPriceCents: parseMoneyCents(item?.price),
      restockType: typeof line.restock_type === 'string' ? line.restock_type : null,
    };
  });

  const shippingParts = list(refund.refund_shipping_lines).map((raw) => {
    const shipping = rec(raw) ?? {};
    const money = rec(rec(shipping.subtotal_amount_set)?.shop_money);
    return parseMoneyCents(money?.amount);
  });
  const transactions = list(refund.transactions).map((raw) => rec(raw) ?? {});
  const successful = transactions.filter((tx) => (tx.kind === undefined || tx.kind === 'refund') && (tx.status === undefined || tx.status === 'success'));

  return {
    refundId: idText(refund.id),
    orderId: idText(refund.order_id),
    lines,
    shippingRefundCents: sumCents(shippingParts),
    transactionCount: transactions.length,
    transactionsCents: sumCents(successful.map((tx) => parseMoneyCents(tx.amount))),
    orderAdjustmentCount: list(refund.order_adjustments).length,
  };
}
