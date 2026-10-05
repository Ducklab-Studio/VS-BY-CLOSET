/**
 * Trava da Shopify real nos builds e testes.
 *
 * O build simulado (`pnpm --filter @valle/marketing build:mock`) grava
 * `NEXT_PUBLIC_SHOPIFY_NETWORK=mock-only` no bundle. Nesse bundle, catálogo
 * (servidor) e carrinho (navegador) só falam com uma Shopify LOCAL: mesmo que
 * um domínio real apareça depois (ex.: `.env.local` carregado pelo
 * `next start`), a chamada é recusada antes de sair. No build de deploy a
 * variável não existe e nada muda.
 *
 * Sem imports e sem ler `process` aqui: quem chama passa o modo (o literal
 * `process.env.NEXT_PUBLIC_SHOPIFY_NETWORK` precisa estar no arquivo que o
 * Next compila para ser substituído no bundle).
 */
export const SHOPIFY_MOCK_ONLY = 'mock-only';

export function isLocalHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Host de um domínio da loja como o projeto configura: `<loja>.myshopify.com`, `127.0.0.1:8443` ou URL. */
export function shopifyHostOf(domain: string): string {
  const value = domain.trim();
  if (!value) return '';
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname;
  } catch {
    return value;
  }
}

/** Recusa (lança) uma chamada à Shopify num build simulado se o destino não for local. */
export function assertShopifyNetworkAllowed(domain: string, mode: string | undefined): void {
  if (mode !== SHOPIFY_MOCK_ONLY) return;
  if (!isLocalHost(shopifyHostOf(domain))) {
    throw new Error('Build/teste com Shopify simulada: chamada à Shopify real bloqueada.');
  }
}
