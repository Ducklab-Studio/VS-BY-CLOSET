/**
 * Trava do `next build` contra a Shopify real.
 *
 * O `next build` carrega o `.env.local` (credenciais reais da loja) e, com a
 * loja configurada, consulta o catálogo para pré-gerar páginas. Fora do deploy
 * isso nunca pode acontecer. Regra:
 *  - build de deploy na Vercel (`VERCEL=1` e `VERCEL_ENV` production/preview,
 *    definidos pela própria Vercel no build): segue com as variáveis do projeto.
 *    Um `.env.local` baixado com `vercel env pull` traz `VERCEL_ENV=development`
 *    e por isso NÃO libera o build local;
 *  - build de deploy no Railway (o serviço `@valle/marketing` também é construído
 *    lá): as variáveis de sistema `RAILWAY_*` só existem dentro do build do
 *    Railway;
 *  - qualquer outro build (local, CI): só o simulado (`build:mock`), com a loja
 *    apontando para um host local e o bundle marcado `mock-only`. Senão o build
 *    para AQUI, antes de qualquer página (e de qualquer consulta) ser gerada.
 */
const LOCAL = /^(localhost|127(\.\d{1,3}){3}|::1|.+\.localhost)$/i;

function hostOf(domain) {
  const value = String(domain ?? '').trim();
  if (!value) return '';
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return value;
  }
}

/** `null` = pode seguir; texto = motivo para parar o build. */
export function shopifyBuildViolation(env) {
  if (env.VERCEL === '1' && (env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview')) return null;
  if (env.RAILWAY_PROJECT_ID?.trim() && env.RAILWAY_ENVIRONMENT_NAME?.trim()) return null;
  const how = 'Use `pnpm --filter @valle/marketing build:mock` (Shopify simulada; o .env.local não é carregado).';
  if (env.SHOPIFY_MOCK_BUILD !== '1' || env.NEXT_PUBLIC_SHOPIFY_NETWORK !== 'mock-only') {
    return `Build fora da Vercel bloqueado: a Shopify real não pode ser consultada em builds locais ou de CI. ${how}`;
  }
  const host = hostOf(env.NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN);
  if (host && !LOCAL.test(host)) {
    return `Build simulado com loja que não é local (${host}): credenciais reais chegaram ao build. ${how}`;
  }
  return null;
}
