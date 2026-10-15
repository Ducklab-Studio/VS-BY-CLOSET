/**
 * Mensagens para o CLIENTE no fluxo de aluguel. Arquivo puro (sem imports) para
 * test/customer-messages.test.mjs.
 *
 * Nada técnico da Shopify (quantidade de estoque, "Storefront API", ids, texto de
 * erro vindo de lá) chega à tela. As verificações e bloqueios continuam iguais:
 * só a APRESENTAÇÃO muda.
 */

/** Mensagem única quando a peça não pode ser alugada agora (sem peça física, ou não vendável na loja). */
export const TEMPORARILY_UNAVAILABLE_MESSAGE = 'Esta peça está temporariamente indisponível para aluguel.';

/**
 * Texto de um erro do carrinho para o cliente. Erro com `code` (CartError) vem da
 * Shopify ou do carrinho e NUNCA é mostrado cru: só o texto amigável do `fallback`
 * (ou o da peça indisponível). Erro comum (as próprias telas já lançam texto em
 * português para o cliente) mantém a mensagem.
 */
export function customerFacingCartError(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = String((err as { code?: unknown }).code);
    if (code === 'not_added') return TEMPORARILY_UNAVAILABLE_MESSAGE;
    return fallback;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}
