/**
 * Configuração da integração com o Booqable.
 *
 * O Booqable é a plataforma de locação: ele cuida de catálogo, disponibilidade
 * por data, carrinho, checkout, pagamento, clientes e pedidos. Este site é a
 * camada de marca e conteúdo em volta disso.
 */

/**
 * Identificador da conta no Booqable — a parte antes de `.booqable.com` na URL
 * da sua loja. Encontre em: Settings → Online Bookings → Website integration.
 */
export const BOOQABLE_COMPANY = process.env.NEXT_PUBLIC_BOOQABLE_COMPANY ?? '';

/** Sem a conta configurada os componentes exibem um aviso em vez de quebrar. */
export const isBooqableConfigured = BOOQABLE_COMPANY.length > 0;

/**
 * URL do script de integração.
 *
 * O snippet oficial vem pronto do painel do Booqable. Este formato reproduz o
 * que ele carrega; se o painel entregar uma URL diferente, defina-a em
 * NEXT_PUBLIC_BOOQABLE_SCRIPT_URL que ela tem precedência.
 */
export const BOOQABLE_SCRIPT_URL =
  process.env.NEXT_PUBLIC_BOOQABLE_SCRIPT_URL ??
  (isBooqableConfigured
    ? `https://${BOOQABLE_COMPANY}.booqable.com/embed.js`
    : '');

/**
 * Global injetado pelo script. Não é documentado publicamente, então tratamos
 * cada método como opcional e nunca assumimos que existe.
 */
declare global {
  interface Window {
    Booqable?: {
      init?: () => void;
      refresh?: () => void;
      reload?: () => void;
    };
  }
}

/**
 * Re-inicializa os componentes na tela.
 *
 * Necessário porque o Booqable foi desenhado para sites com navegação por
 * recarga de página: ele varre o DOM uma vez no load. No App Router a
 * navegação é client-side, então um `<div class="booqable-...">` que aparece
 * depois disso nunca seria hidratado sem este empurrão.
 *
 * Como o nome do método não é documentado, tentamos os candidatos em ordem.
 */
export function refreshBooqable(): boolean {
  if (typeof window === 'undefined' || !window.Booqable) return false;

  for (const method of ['refresh', 'init', 'reload'] as const) {
    const fn = window.Booqable[method];
    if (typeof fn === 'function') {
      try {
        fn.call(window.Booqable);
        return true;
      } catch {
        // Tenta o próximo candidato.
      }
    }
  }
  return false;
}
