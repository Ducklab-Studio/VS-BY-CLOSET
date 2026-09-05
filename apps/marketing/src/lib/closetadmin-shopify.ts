/**
 * Fase 9 — "NÃO quero recriar o Shopify Admin". Em vez de mostrar
 * detalhe comercial (preço, pagamento, produto) aqui, todo lugar que
 * toca algo que já é do Shopify só linka de volta pro Admin real. Não é
 * server-only: só monta uma URL a partir do domínio da loja, que já é
 * público (NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN).
 */
const STORE_DOMAIN = process.env.NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN ?? '';

export function shopifyOrderAdminUrl(shopifyOrderId: string | null): string | null {
  if (!STORE_DOMAIN || !shopifyOrderId) return null;
  const numericId = shopifyOrderId.replace(/\D/g, '');
  if (!numericId) return null;
  return `https://${STORE_DOMAIN}/admin/orders/${numericId}`;
}

export function shopifyProductAdminUrl(shopifyProductId: string | null): string | null {
  if (!STORE_DOMAIN || !shopifyProductId) return null;
  const numericId = shopifyProductId.replace(/\D/g, '');
  if (!numericId) return null;
  return `https://${STORE_DOMAIN}/admin/products/${numericId}`;
}
