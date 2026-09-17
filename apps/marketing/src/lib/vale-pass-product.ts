import { storeUrl } from './shopify';

/**
 * Identificação do produto Valle Pass no catálogo da Shopify.
 *
 * Vale-presente/crédito de compra — produto Shopify normal, mas que
 * NUNCA pode passar pelo fluxo de aluguel (calendário, disponibilidade,
 * HOLD, reserva). Ver apps/reservations-api/src/vale-pass para o
 * backend que processa a compra pelo webhook `orders/paid`.
 */

/**
 * Extrai a parte numérica de um id da Shopify — aceita tanto o formato
 * cru (`"49174518595684"`) quanto o GID (`"gid://shopify/ProductVariant/49174518595684"`).
 * A Storefront API sempre devolve GID; configuração por env pode trazer
 * qualquer um dos dois formatos.
 */
export function normalizeShopifyId(id: string | null | undefined): string {
  if (!id) return '';
  const match = id.match(/(\d+)\s*$/);
  return match ? match[1] : id.trim();
}

/**
 * Configurável por env (útil se o produto for recriado ou se a loja
 * mudar); os valores default são os IDs reais informados pelo negócio.
 */
export const VALE_PASS_PRODUCT_ID = normalizeShopifyId(
  process.env.NEXT_PUBLIC_VALE_PASS_PRODUCT_ID?.trim() || '8723909804132',
);
export const VALE_PASS_VARIANT_ID = normalizeShopifyId(
  process.env.NEXT_PUBLIC_VALE_PASS_VARIANT_ID?.trim() || '49174518595684',
);

/**
 * true se o produto OU a variante corresponde ao Valle Pass. Checar os
 * dois (não só a variante) cobre o caso de o produto ganhar mais
 * variantes no futuro sem que a detecção precise ser atualizada.
 */
export function isValePassProduct(input: { productId?: string | null; variantId?: string | null }): boolean {
  const productMatches = !!input.productId && normalizeShopifyId(input.productId) === VALE_PASS_PRODUCT_ID;
  const variantMatches = !!input.variantId && normalizeShopifyId(input.variantId) === VALE_PASS_VARIANT_ID;
  return productMatches || variantMatches;
}

/**
 * Link de checkout direto da Shopify pro Valle Pass — "compra normal do
 * produto", nunca o fluxo de HOLD/reserva. Usa o permalink nativo de
 * carrinho da Shopify (`/cart/{variantId}:{quantity}`), a mesma rota que
 * qualquer botão "comprar agora" de tema Shopify usa: nenhuma chamada de
 * rede feita por este site, nenhuma dependência do reservations-api.
 */
export function valePassCheckoutHref(variantId: string, quantity = 1): string {
  return storeUrl(`/cart/${normalizeShopifyId(variantId)}:${quantity}`);
}
