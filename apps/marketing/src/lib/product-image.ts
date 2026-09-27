/**
 * Imagens de produto vindas da Shopify. Arquivo puro (sem imports) pra ser
 * testado direto por test/product-image.test.mjs.
 *
 * A CDN da Shopify redimensiona pelo parâmetro `width` e já entrega WebP/AVIF
 * conforme o navegador. Servir direto dela evita recomprimir no otimizador do
 * Next uma foto que a Shopify já comprimiu (perda dupla de qualidade) e mantém
 * o cache da própria CDN.
 */
export interface ProductImageSource {
  readonly url: string;
  readonly altText: string | null;
  /** Largura/altura originais do arquivo na Shopify (null em dados antigos/demo). */
  readonly width?: number | null;
  readonly height?: number | null;
}

export function isShopifyCdnUrl(src: string): boolean {
  try {
    const url = new URL(src);
    return url.protocol === 'https:' && url.hostname === 'cdn.shopify.com';
  } catch {
    return false;
  }
}

/**
 * URL da CDN na largura pedida pelo `srcset`, nunca acima da largura original:
 * sem upscaling artificial — acima disso o navegador recebe a foto original.
 */
export function shopifyImageUrl(src: string, width: number, originalWidth?: number | null): string {
  const url = new URL(src);
  const capped = originalWidth && originalWidth > 0 ? Math.min(width, originalWidth) : width;
  url.searchParams.set('width', String(Math.max(1, Math.round(capped))));
  return url.toString();
}
