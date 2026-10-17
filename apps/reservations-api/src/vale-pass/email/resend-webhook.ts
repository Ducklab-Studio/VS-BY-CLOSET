import { createHmac, timingSafeEqual } from 'node:crypto';

/** Tolerância do carimbo de tempo do webhook (anti-replay). */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/**
 * Verificação de assinatura dos webhooks da Resend (padrão Svix): `HMAC-SHA256(base64decode(secret), "<svix-id>.<svix-timestamp>.<corpo>")`,
 * enviada em `svix-signature` como uma lista "v1,<base64> v1,<base64>". `secret` vem como `whsec_<base64>`.
 * Compara em tempo constante e recusa carimbos fora da tolerância.
 */
export function verifySvixSignature(input: {
  secret: string;
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: Buffer | string | undefined;
  nowSeconds?: number;
}): boolean {
  const { secret, id, timestamp, signature, rawBody } = input;
  if (!secret || !id || !timestamp || !signature || rawBody === undefined) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const keyMaterial = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(keyMaterial, 'base64');
  } catch {
    return false;
  }
  if (key.length === 0) return false;
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();

  for (const candidate of signature.split(' ')) {
    const [version, value] = candidate.split(',');
    if (version !== 'v1' || !value) continue;
    const given = Buffer.from(value, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

/** Extrai `{ type, emailId }` de um evento da Resend; qualquer outro formato é ignorado. */
export function parseResendEvent(rawBody: Buffer | string | undefined): { type: string; emailId: string } | null {
  if (rawBody === undefined) return null;
  try {
    const parsed = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')) as { type?: unknown; data?: { email_id?: unknown } };
    const type = parsed.type;
    const emailId = parsed.data?.email_id;
    if (typeof type !== 'string' || typeof emailId !== 'string' || !emailId || emailId.length > 200) return null;
    return { type, emailId };
  } catch {
    return null;
  }
}
