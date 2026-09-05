import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEY_LEN = 64;
const SALT_BYTES = 16;

/**
 * PIN é um segredo curto (poucos dígitos) — SHA-256 puro (usado no resto
 * do projeto pra token de 256 bits, ver hold-token.ts) seria rápido
 * demais aqui: um vazamento do banco tornaria viável testar todos os
 * PINs de 4-6 dígitos offline em segundos. `scrypt` (nativo do
 * `node:crypto`, sem dependência nova) é memory-hard, apropriado pra
 * segredo de baixa entropia. Formato gravado: `salt:hash`, os dois em
 * hex — self-contained, não precisa de coluna extra pro salt.
 */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const derived = (await scryptAsync(pin, salt, KEY_LEN)) as Buffer;
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPin(pin: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, hashHex] = parts;
  let stored: Buffer;
  try {
    stored = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  const derived = (await scryptAsync(pin, salt, KEY_LEN)) as Buffer;
  if (derived.length !== stored.length) return false;
  return timingSafeEqual(derived, stored);
}
