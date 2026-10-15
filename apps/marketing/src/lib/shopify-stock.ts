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

/**
 * Estoque da Shopify NÃO é disponibilidade de aluguel: quem manda é a peça física
 * reservável do ClosetAdmin + o calendário. A página do produto de aluguel NÃO mostra
 * quantidade nem "disponível na Shopify"; esta classificação segue existindo só para
 * a lógica do carrinho (variante que a Shopify confirma não vendável bloqueia o envio).
 * Quando o reservations-api informa que não existe peça reservável (404/422 de
 * "not_rentable"), a página mostra este texto.
 */
export const RENTAL_UNAVAILABLE_TEXT = 'Indisponível para aluguel no momento.';
