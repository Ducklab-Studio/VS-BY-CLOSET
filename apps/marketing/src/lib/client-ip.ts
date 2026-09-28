/**
 * IP de quem está usando o site, repassado à API para contar tentativas de
 * login por pessoa (e não pelo IP do servidor do site, igual para todos).
 *
 * Só na Vercel (`VERCEL=1`, variável de sistema presente em runtime) esses
 * cabeçalhos são confiáveis: a borda da Vercel SOBRESCREVE `x-forwarded-for`
 * e não repassa IPs externos, "para impedir IP spoofing"; `x-real-ip` e
 * `x-vercel-forwarded-for` são idênticos, e o último não é afetado por outro
 * proxy na frente (docs: vercel.com/docs/headers/request-headers). Fora da
 * Vercel (local, outro host) quem escreve esses cabeçalhos é o próprio
 * navegador — então nada é repassado e a API usa um balde neutro.
 */
const IP_LIKE = /^[0-9a-fA-F:.]{2,45}$/;
const TRUSTED_HEADERS = ['x-vercel-forwarded-for', 'x-real-ip', 'x-forwarded-for'] as const;

export function clientIpFromHeaders(
  headers: { get(name: string): string | null },
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.VERCEL !== '1') return null;
  for (const name of TRUSTED_HEADERS) {
    const value = headers.get(name)?.split(',')[0]?.trim();
    if (value && IP_LIKE.test(value)) return value;
  }
  return null;
}

/** Cabeçalho lido pela API em /admin/auth/login (ver login-keys.ts na API). */
export const CLIENT_IP_HEADER = 'X-Closetadmin-Client-Ip';
