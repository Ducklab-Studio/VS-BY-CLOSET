import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TERMS_SHA256_PATTERN, TERMS_VERSION_PATTERN } from './terms-acceptance-config';

/**
 * Token de aceite dos termos: `vp1.<payload base64url>.<HMAC-SHA256 base64url>`.
 *
 * O que ele prova: que ESTE servidor registrou, num instante, um pedido afirmativo de aceite para uma versão e um hash específicos do texto, para uma variante
 * específica, e que o conteúdo não foi alterado depois (assinatura). NÃO prova quem clicou: qualquer visitante pode pedir um token. A segurança contra
 * reaproveitamento vem de: validade curta, vínculo com a variante comprada e uso único (o webhook recusa um nonce já consumido por outro pedido).
 *
 * Sem dado pessoal: só versão, hash, instantes, nonce aleatório e a variante.
 */
const PREFIX = 'vp1';
const MAX_TOKEN_LENGTH = 700;
const MAX_LIFETIME_MS = 48 * 60 * 60_000;
/** Tolerância entre o relógio deste servidor e o `created_at` do pedido na Shopify. */
export const TOKEN_CLOCK_SKEW_MS = 5 * 60_000;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,43}$/;
const VARIANT_PATTERN = /^\d{1,20}$/;

export interface TermsTokenClaims {
  readonly ver: string;
  readonly sha: string;
  /** Emitido em (ms desde 1970, relógio do servidor). */
  readonly iat: number;
  /** Expira em (ms). */
  readonly exp: number;
  readonly nonce: string;
  /** Id numérico da variante da campanha para a qual o aceite foi emitido. */
  readonly variant: string;
}

export type TermsTokenFailure = 'malformed' | 'bad_signature' | 'version_mismatch' | 'hash_mismatch' | 'variant_mismatch' | 'not_yet_valid' | 'expired';
export type TermsTokenCheck = { readonly ok: true; readonly claims: TermsTokenClaims } | { readonly ok: false; readonly reason: TermsTokenFailure };

const b64 = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

function signature(secret: string, signingInput: string): Buffer {
  return createHmac('sha256', secret).update(signingInput).digest();
}

export function issueTermsToken(input: { secret: string; version: string; sha256: string; variant: string; now: Date; ttlMs: number; nonce?: string }): { token: string; claims: TermsTokenClaims } {
  const iat = input.now.getTime();
  const claims: TermsTokenClaims = { ver: input.version, sha: input.sha256, iat, exp: iat + input.ttlMs, nonce: input.nonce ?? b64(randomBytes(16)), variant: input.variant };
  const payload = b64(JSON.stringify({ v: 1, ver: claims.ver, sha: claims.sha, iat: claims.iat, exp: claims.exp, n: claims.nonce, var: claims.variant }));
  const signingInput = `${PREFIX}.${payload}`;
  return { token: `${signingInput}.${b64(signature(input.secret, signingInput))}`, claims };
}

/**
 * Verifica assinatura PRIMEIRO (nada do conteúdo é interpretado antes), depois formato, versão, hash, variante e janela de tempo. `at` é o instante de referência
 * (o `created_at` do pedido na Shopify, não "agora": o webhook pode chegar atrasado e o aceite precisa ter sido válido quando a compra foi feita).
 */
export function verifyTermsToken(token: string, expected: { secret: string; version: string; sha256: string; variantIds: readonly string[]; at: Date }): TermsTokenCheck {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX || parts[1] === '' || parts[2] === '') return { ok: false, reason: 'malformed' };
  const given = Buffer.from(parts[2], 'base64url');
  const wanted = signature(expected.secret, `${PREFIX}.${parts[1]}`);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return { ok: false, reason: 'bad_signature' };

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const p = raw as Record<string, unknown> | null;
  if (
    p === null || typeof p !== 'object' || p.v !== 1 ||
    typeof p.ver !== 'string' || !TERMS_VERSION_PATTERN.test(p.ver) ||
    typeof p.sha !== 'string' || !TERMS_SHA256_PATTERN.test(p.sha) ||
    !Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp) ||
    typeof p.n !== 'string' || !NONCE_PATTERN.test(p.n) ||
    typeof p.var !== 'string' || !VARIANT_PATTERN.test(p.var)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const iat = p.iat as number;
  const exp = p.exp as number;
  if (exp <= iat || exp - iat > MAX_LIFETIME_MS) return { ok: false, reason: 'malformed' };
  if (p.ver !== expected.version) return { ok: false, reason: 'version_mismatch' };
  if (p.sha !== expected.sha256) return { ok: false, reason: 'hash_mismatch' };
  if (!expected.variantIds.includes(p.var)) return { ok: false, reason: 'variant_mismatch' };
  const at = expected.at.getTime();
  if (at < iat - TOKEN_CLOCK_SKEW_MS) return { ok: false, reason: 'not_yet_valid' };
  if (at > exp) return { ok: false, reason: 'expired' };
  return { ok: true, claims: { ver: p.ver, sha: p.sha, iat, exp, nonce: p.n, variant: p.var } };
}
