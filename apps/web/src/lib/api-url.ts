/**
 * Resolve a base da API conforme onde o código está rodando.
 *
 * Três cenários:
 *  1. Navegador com proxy de mesmo domínio (padrão) → caminho relativo `/api/v1`.
 *     O Next repassa para a API pela rede interna. Sem CORS, cookie same-site.
 *  2. Navegador com API em domínio próprio → usa NEXT_PUBLIC_API_URL.
 *  3. Servidor (SSR / Server Component) → sempre a URL interna. Chamar a si
 *     mesmo pelo proxy criaria um salto de rede inútil e quebraria durante o
 *     build, quando o servidor HTTP do Next ainda nem está de pé.
 */

const PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL;
const INTERNAL_API_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:3333';

export function apiBase(): string {
  // Server-side: fala direto com a API.
  if (typeof window === 'undefined') {
    return `${(PUBLIC_API_URL ?? INTERNAL_API_URL).replace(/\/$/, '')}/api/v1`;
  }
  // Navegador em modo cross-domain.
  if (PUBLIC_API_URL) {
    return `${PUBLIC_API_URL.replace(/\/$/, '')}/api/v1`;
  }
  // Navegador com proxy de mesmo domínio.
  return '/api/v1';
}
