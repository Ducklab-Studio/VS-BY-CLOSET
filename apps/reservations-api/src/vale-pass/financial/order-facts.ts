import { parseMoneyCents, sumCents, type Cents } from './money';

/**
 * "Fatos financeiros" de um pedido, extraídos de DUAS fontes que precisam dizer a mesma coisa:
 *  - o payload REST do webhook (`orders/paid`, `orders/updated`...);
 *  - o nó do Admin GraphQL, usado pela reconciliação.
 * Campos ausentes ou ilegíveis viram `null` (indefinido). A validação decide o que fazer com isso — e a regra é recusar (fail-closed).
 *
 * Campos conferidos na documentação oficial da Shopify (Order REST/GraphQL e LineItem GraphQL), em 19/10/2026:
 *  REST: currency (moeda da LOJA), presentment_currency, financial_status, cancelled_at, current_total_price (string), total_outstanding (string),
 *        total_discounts (string), discount_codes[], taxes_included, total_shipping_price_set.shop_money.amount, refunds[],
 *        line_items[].{variant_id, product_id, quantity, current_quantity, price (ANTES de descontos, moeda da loja), price_set,
 *        discount_allocations[].amount, gift_card}.
 *  GraphQL: currencyCode, presentmentCurrencyCode, displayFinancialStatus, cancelledAt, currentTotalPriceSet, totalOutstandingSet,
 *        totalDiscountsSet, totalShippingPriceSet, discountCodes, taxesIncluded, lineItems.nodes[].{quantity, currentQuantity,
 *        originalUnitPriceSet, discountAllocations[].allocatedAmountSet, variant.id, product.id}.
 * Atenção: `quantity` conta TODAS as unidades pedidas, inclusive as removidas/reembolsadas; `current_quantity`/`currentQuantity` já desconta.
 */
export interface FinancialLineFacts {
  readonly variantId: string | null;
  readonly productId: string | null;
  readonly quantity: number | null;
  readonly currentQuantity: number | null;
  /** Preço unitário ANTES de descontos, em centavos. */
  readonly unitPriceCents: Cents | null;
  /** Moeda em que o preço da linha foi lido (moeda da loja). */
  readonly unitPriceCurrency: string | null;
  /** Soma dos descontos alocados à linha; `null` se a Shopify não informou. */
  readonly discountCents: Cents | null;
}

export interface OrderFinancialFacts {
  readonly source: 'webhook' | 'admin';
  readonly orderId: string | null;
  /** Em minúsculas (`paid`, `pending`, `partially_paid`...). */
  readonly financialStatus: string | null;
  readonly cancelled: boolean;
  /** Moeda da loja e moeda de apresentação ao cliente. */
  readonly currency: string | null;
  readonly presentmentCurrency: string | null;
  readonly currentTotalCents: Cents | null;
  readonly totalOutstandingCents: Cents | null;
  readonly totalDiscountsCents: Cents | null;
  readonly totalShippingCents: Cents | null;
  readonly discountCodes: readonly string[];
  readonly refundCount: number | null;
  readonly lines: readonly FinancialLineFacts[];
  /** Pedido de TESTE da Shopify (`test: true`). Ausente/nulo = a fonte não informou. */
  readonly testOrder?: boolean | null;
  /** `payment_gateway_names` (ex.: ["Mercado Pago Pix"], ["Mercado Pago Pix","manual"]). Ausente/nulo = a fonte não informou. */
  readonly gatewayNames?: readonly string[] | null;
}

const rec = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const list = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : null);
const upper = (value: unknown): string | null => text(value)?.toUpperCase() ?? null;
const lastSegment = (value: unknown): string | null => text(value)?.split('/').pop() ?? null;

function wholeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/** `MoneyBag` / `*_set` (REST: shop_money.amount, GraphQL: shopMoney.amount) → centavos na moeda da LOJA. */
function shopMoneyCents(bag: unknown): { cents: Cents | null; currency: string | null } {
  const set = rec(bag);
  const money = rec(set?.shop_money) ?? rec(set?.shopMoney);
  if (!money) return { cents: null, currency: null };
  return { cents: parseMoneyCents(money.amount), currency: upper(money.currency_code ?? money.currencyCode) };
}

function sumAllocations(allocations: unknown[] | null, amountOf: (allocation: Record<string, unknown>) => Cents | null): Cents | null {
  if (allocations === null) return null;
  return sumCents(allocations.map((entry) => { const allocation = rec(entry); return allocation ? amountOf(allocation) : null; }));
}

/** Payload REST do webhook. Entrada `unknown`: nada é presumido. */
export function factsFromWebhookPayload(payload: unknown): OrderFinancialFacts {
  const order = rec(payload) ?? {};
  const lines = (list(order.line_items) ?? []).map((raw): FinancialLineFacts => {
    const line = rec(raw) ?? {};
    const priceSet = shopMoneyCents(line.price_set);
    const unitPrice = parseMoneyCents(line.price);
    return {
      variantId: lastSegment(line.variant_id),
      productId: lastSegment(line.product_id),
      quantity: wholeNumber(line.quantity),
      currentQuantity: wholeNumber(line.current_quantity),
      unitPriceCents: unitPrice ?? priceSet.cents,
      unitPriceCurrency: priceSet.currency ?? upper(order.currency),
      discountCents: sumAllocations(list(line.discount_allocations), (allocation) => parseMoneyCents(allocation.amount) ?? shopMoneyCents(allocation.amount_set).cents),
    };
  });
  const codes = list(order.discount_codes);
  return {
    source: 'webhook',
    orderId: lastSegment(order.id),
    financialStatus: text(order.financial_status)?.toLowerCase() ?? null,
    cancelled: Boolean(order.cancelled_at),
    currency: upper(order.currency),
    presentmentCurrency: upper(order.presentment_currency),
    currentTotalCents: parseMoneyCents(order.current_total_price),
    totalOutstandingCents: parseMoneyCents(order.total_outstanding),
    totalDiscountsCents: parseMoneyCents(order.total_discounts),
    totalShippingCents: shopMoneyCents(order.total_shipping_price_set).cents,
    discountCodes: (codes ?? []).map((entry) => text(rec(entry)?.code) ?? '(sem código)'),
    refundCount: list(order.refunds)?.length ?? null,
    lines,
    testOrder: typeof order.test === 'boolean' ? order.test : null,
    gatewayNames: list(order.payment_gateway_names)?.map((entry) => text(entry) ?? '').filter(Boolean) ?? null,
  };
}

/** Nó do Admin GraphQL (campos de `ADMIN_ORDER_FINANCIAL_FIELDS`). Mesma forma de saída do webhook. */
export function factsFromAdminOrder(node: unknown): OrderFinancialFacts {
  const order = rec(node) ?? {};
  const lines = (list(rec(order.lineItems)?.nodes) ?? []).map((raw): FinancialLineFacts => {
    const line = rec(raw) ?? {};
    const price = shopMoneyCents(line.originalUnitPriceSet);
    return {
      variantId: lastSegment(rec(line.variant)?.id),
      productId: lastSegment(rec(line.product)?.id),
      quantity: wholeNumber(line.quantity),
      currentQuantity: wholeNumber(line.currentQuantity),
      unitPriceCents: price.cents,
      unitPriceCurrency: price.currency,
      discountCents: sumAllocations(list(line.discountAllocations), (allocation) => shopMoneyCents(allocation.allocatedAmountSet).cents),
    };
  });
  const codes = list(order.discountCodes);
  const totalDiscounts = shopMoneyCents(order.totalDiscountsSet).cents;
  return {
    source: 'admin',
    orderId: lastSegment(order.id),
    financialStatus: text(order.displayFinancialStatus)?.toLowerCase() ?? null,
    cancelled: Boolean(order.cancelledAt),
    currency: upper(order.currencyCode),
    presentmentCurrency: upper(order.presentmentCurrencyCode),
    currentTotalCents: shopMoneyCents(order.currentTotalPriceSet).cents,
    totalOutstandingCents: shopMoneyCents(order.totalOutstandingSet).cents,
    totalDiscountsCents: totalDiscounts,
    totalShippingCents: shopMoneyCents(order.totalShippingPriceSet).cents,
    discountCodes: (codes ?? []).map((entry) => text(entry) ?? '(sem código)'),
    // O Admin GraphQL desta consulta não lista reembolsos como objetos: o efeito aparece em `currentQuantity` e `currentTotalPrice`.
    refundCount: null,
    lines,
    testOrder: typeof order.test === 'boolean' ? order.test : null,
    gatewayNames: list(order.paymentGatewayNames)?.map((entry) => text(entry) ?? '').filter(Boolean) ?? null,
  };
}

/**
 * Campos que a reconciliação (Admin API) precisaria pedir para a validação funcionar. NÃO é usado pela consulta ativa hoje: a consulta de produção
 * continua exatamente como está (`id`, `displayFinancialStatus`, `lineItems { quantity variant product }`). Entra na integração futura (PR F).
 */
export const ADMIN_ORDER_FINANCIAL_FIELDS = `
  currencyCode
  presentmentCurrencyCode
  displayFinancialStatus
  cancelledAt
  test
  paymentGatewayNames
  discountCodes
  taxesIncluded
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  totalOutstandingSet { shopMoney { amount currencyCode } }
  totalDiscountsSet { shopMoney { amount currencyCode } }
  totalShippingPriceSet { shopMoney { amount currencyCode } }
  lineItems(first: 20) {
    nodes {
      quantity
      currentQuantity
      variant { id }
      product { id }
      originalUnitPriceSet { shopMoney { amount currencyCode } }
      discountAllocations { allocatedAmountSet { shopMoney { amount currencyCode } } }
    }
  }
`;
