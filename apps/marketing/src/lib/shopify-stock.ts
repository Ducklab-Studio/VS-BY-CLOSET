/**
 * Estoque COMERCIAL da variante na Shopify (pode ir ao carrinho?). Não é a
 * disponibilidade da data — essa vem do reservations-api (RentalUnits livres
 * na retirada, já descontando reservas e HOLDs do ClosetAdmin). Arquivo puro
 * (sem imports) para test/shopify-stock.test.mjs.
 *
 * Campos da Storefront API usados (ProductVariant):
 *  - `availableForSale`: a palavra final da Shopify sobre vender pelo canal.
 *    `false` = não vendável (estoque zero com política "não vender sem
 *    estoque", ou estoque só em locais que não atendem o canal) — a Cart API
 *    zera a linha nesse caso;
 *  - `quantityAvailable`: unidades vendáveis (já sem as "comprometidas" por
 *    pedidos). Com estoque não rastreado ou venda sem estoque permitida a
 *    Shopify devolve 0 mesmo com a variante à venda;
 *  - `currentlyNotInStock`: à venda, mas sem estoque (venda sem estoque).
 * A Storefront API não expõe `inventoryPolicy` nem o "comprometido"; eles só
 * existem na Admin API.
 */

export interface RawVariantStock {
  readonly availableForSale?: unknown;
  readonly quantityAvailable?: unknown;
  readonly currentlyNotInStock?: unknown;
}

export type ShopifyStock =
  /** Vendável. `quantity` = unidades confirmadas (> 0) ou `null` (não rastreado, venda sem estoque ou não informado). */
  | { readonly status: 'available'; readonly quantity: number | null }
  /** A Shopify confirma explicitamente que a variante não está à venda. */
  | { readonly status: 'sold_out' }
  /** Sem resposta, erro, timeout ou dado inconclusivo: nunca vira "esgotada" nem 0. */
  | { readonly status: 'unknown' };

export const UNKNOWN_STOCK: ShopifyStock = { status: 'unknown' };

export function classifyShopifyStock(raw: RawVariantStock | null | undefined): ShopifyStock {
  if (!raw || typeof raw !== 'object') return UNKNOWN_STOCK;
  if (raw.availableForSale === false) return { status: 'sold_out' };
  if (raw.availableForSale !== true) return UNKNOWN_STOCK;
  const quantity = raw.quantityAvailable;
  const counted = typeof quantity === 'number' && Number.isInteger(quantity) && quantity > 0 && raw.currentlyNotInStock !== true;
  return { status: 'available', quantity: counted ? (quantity as number) : null };
}

/** Texto para o cliente — "Esgotada" só com confirmação explícita da Shopify. */
export function shopifyStockText(stock: ShopifyStock | null): string {
  if (stock === null) return 'Conferindo estoque na Shopify…';
  if (stock.status === 'sold_out') return 'Esgotada na Shopify.';
  if (stock.status === 'unknown') return 'Estoque será validado ao finalizar a reserva.';
  return stock.quantity === null
    ? 'Disponível na Shopify para o carrinho.'
    : `Disponível na Shopify para o carrinho (${stock.quantity} em estoque).`;
}
