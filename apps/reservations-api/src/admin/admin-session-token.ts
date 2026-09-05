import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Token de sessão do ClosetAdmin — mesmo padrão de hold-token.ts: 256
 * bits aleatórios, só o HASH (SHA-256, entropia alta o bastante pra
 * dispensar scrypt aqui — diferente do PIN) vai pro banco
 * (`admin_sessions.token_hash`). O valor puro só existe no cookie
 * HttpOnly que o apps/marketing seta no navegador; nunca é persistido.
 */
const TOKEN_BYTES = 32;

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function verifySessionTokenHash(token: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashSessionToken(token), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}
