import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Comparação em tempo constante entre o bearer token apresentado e o
 * `ADMIN_API_TOKEN` configurado — mesma técnica de hold-token.ts (hash
 * SHA-256 dos dois lados antes de `timingSafeEqual`, pra nunca comparar
 * strings de tamanho diferente diretamente, o que já vazaria informação
 * pelo próprio comprimento antes mesmo do timing entrar em jogo).
 */
export function verifyAdminToken(presented: string | undefined, configured: string): boolean {
  if (!presented) return false;
  const presentedHash = createHash('sha256').update(presented, 'utf8').digest();
  const configuredHash = createHash('sha256').update(configured, 'utf8').digest();
  return timingSafeEqual(presentedHash, configuredHash);
}

/**
 * Aceita o token se ele conferir com QUALQUER um dos configurados (principal e, durante rotação, o "próximo"). Compara com TODOS, sem parar no primeiro acerto,
 * para o tempo de resposta não revelar qual deles bateu.
 */
export function verifyAnyAdminToken(presented: string | undefined, configured: readonly string[]): boolean {
  let ok = false;
  for (const token of configured) if (verifyAdminToken(presented, token)) ok = true;
  return ok;
}

/** `Authorization: Bearer <token>` — nunca um header customizado tipo
 *  `x-admin-token`, pra seguir o padrão HTTP real de autenticação, não
 *  inventar um. */
export function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = /^Bearer (.+)$/.exec(authorizationHeader);
  return match ? match[1] : undefined;
}
