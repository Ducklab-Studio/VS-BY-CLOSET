import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { DB_MAX_EXPECTED_TOTAL_CENTS, DB_MAX_RESERVATION_FEE_CENTS } from '../rental-rules/rental-pricing';

/**
 * Assinatura e verificação do binding HMAC v2 (Fase 3). Módulo PURO: recebe o segredo como PARÂMETRO (nunca lê
 * `process.env`), não conhece checkout, webhook nem banco. O HMAC v1 (`reservation-binding.ts`) NÃO é tocado.
 *
 * Separação de domínio (um v2 nunca pode ser aceito como v1, nem o contrário):
 *  - a CHAVE v2 é derivada por HKDF-SHA256 do segredo existente, com `info` próprio por `kid` — o v1 usa o segredo
 *    cru como chave HMAC, então as duas chaves são diferentes mesmo com o mesmo segredo de origem;
 *  - o PAYLOAD começa com a etiqueta `vsbc-binding/v2` e cada campo vai rotulado, um por linha;
 *  - o valor assinado é autodescritivo: `v2:<kid>:<hex>`. O v1 é 64 caracteres hex sem prefixo, logo é recusado aqui
 *    como `unsupported_version` (sem tentativa de "cair" para outro formato).
 *
 * Esta etapa só ESTUDA/IMPLEMENTA a derivação e a identificação de chave (`kid`); nenhuma rotação é configurada e o
 * segredo de produção não é lido nem alterado.
 */

export const BINDING_V2_VERSION_TAG = 'v2';
const PAYLOAD_DOMAIN = 'vsbc-binding/v2';
const HKDF_SALT = Buffer.from('vsbc-hkdf-salt/v2', 'utf8');
const KEY_BYTES = 32;
const MIN_SECRET_LENGTH = 16;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BINDING_ID = /^[A-Za-z0-9_-]{16,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const CURRENCY = /^[A-Z]{3}$/;
const KID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SIGNATURE = /^v2:([a-z0-9][a-z0-9_-]{0,31}):([0-9a-f]{64})$/;

export class BindingV2Error extends Error {}

// ── chaves ────────────────────────────────────────────────────────

export interface BindingKeyV2 {
  readonly kid: string;
  /** Material derivado (32 bytes). Nunca logar. */
  readonly material: Buffer;
}

export function isValidKid(kid: unknown): kid is string {
  return typeof kid === 'string' && KID.test(kid);
}

/**
 * HKDF-SHA256(segredo, salt fixo, info = `vsbc/binding/v2|kid=<kid>`) → 32 bytes. Determinístico: o mesmo segredo e
 * o mesmo `kid` dão a mesma chave; `kid` diferente dá chave independente (base da rotação futura: aceitar a atual e a
 * anterior). Lança `BindingV2Error` para segredo curto ou `kid` inválido.
 */
export function deriveBindingKeyV2(secret: string, kid: string): BindingKeyV2 {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) throw new BindingV2Error('segredo ausente ou curto demais');
  if (!isValidKid(kid)) throw new BindingV2Error('kid inválido');
  const material = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), HKDF_SALT, Buffer.from(`vsbc/binding/v2|kid=${kid}`, 'utf8'), KEY_BYTES));
  return { kid, material };
}

// ── payload ───────────────────────────────────────────────────────

export interface BindingPayloadV2 {
  /** UUID minúsculo. */
  readonly reservationId: string;
  /** Nonce da tentativa de checkout (base64url, 16–64 caracteres). */
  readonly bindingId: string;
  /** Versão da regra de preço da reserva (`reservations.pricing_version`), inteiro ≥ 1. */
  readonly pricingVersion: number;
  /** `CanonicalPieces.fingerprint`. */
  readonly itemsFingerprint: string;
  /** `hashPricingSnapshot(pricing_snapshot)`. */
  readonly pricingSnapshotHash: string;
  readonly expectedTotalCents: number;
  readonly feeCents: number;
  /** Moeda ISO 4217 em maiúsculas (ex.: `BRL`). */
  readonly currency: string;
}

export type PayloadViolationCode =
  | 'invalid_reservation_id'
  | 'invalid_binding_id'
  | 'invalid_pricing_version'
  | 'invalid_items_fingerprint'
  | 'invalid_snapshot_hash'
  | 'invalid_expected_total'
  | 'invalid_fee'
  | 'invalid_currency';

const isInt = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

export function validateBindingPayloadV2(payload: BindingPayloadV2): readonly PayloadViolationCode[] {
  if (payload === null || typeof payload !== 'object') return ['invalid_reservation_id'];
  const out: PayloadViolationCode[] = [];
  if (typeof payload.reservationId !== 'string' || !UUID.test(payload.reservationId)) out.push('invalid_reservation_id');
  if (typeof payload.bindingId !== 'string' || !BINDING_ID.test(payload.bindingId)) out.push('invalid_binding_id');
  if (!isInt(payload.pricingVersion, 1, 1_000_000)) out.push('invalid_pricing_version');
  if (typeof payload.itemsFingerprint !== 'string' || !SHA256_HEX.test(payload.itemsFingerprint)) out.push('invalid_items_fingerprint');
  if (typeof payload.pricingSnapshotHash !== 'string' || !SHA256_HEX.test(payload.pricingSnapshotHash)) out.push('invalid_snapshot_hash');
  const feeOk = isInt(payload.feeCents, 0, DB_MAX_RESERVATION_FEE_CENTS);
  if (!feeOk) out.push('invalid_fee');
  // Mesmos limites do CHECK r_pricing_amounts: total esperado entre a taxa e o teto.
  if (!isInt(payload.expectedTotalCents, feeOk ? payload.feeCents : 0, DB_MAX_EXPECTED_TOTAL_CENTS)) out.push('invalid_expected_total');
  if (typeof payload.currency !== 'string' || !CURRENCY.test(payload.currency)) out.push('invalid_currency');
  return out;
}

/** Texto exato que é assinado. Campos rotulados, um por linha; todos validados (sem `\n`, sem ambiguidade). */
export function canonicalBindingStringV2(payload: BindingPayloadV2): string {
  const violations = validateBindingPayloadV2(payload);
  if (violations.length > 0) throw new BindingV2Error(`payload inválido: ${violations.join(',')}`);
  return [
    PAYLOAD_DOMAIN,
    `reservation=${payload.reservationId}`,
    `binding=${payload.bindingId}`,
    `pricingVersion=${payload.pricingVersion}`,
    `items=${payload.itemsFingerprint}`,
    `snapshot=${payload.pricingSnapshotHash}`,
    `expectedTotalCents=${payload.expectedTotalCents}`,
    `feeCents=${payload.feeCents}`,
    `currency=${payload.currency}`,
  ].join('\n');
}

// ── assinar / verificar ───────────────────────────────────────────

const mac = (key: BindingKeyV2, payload: BindingPayloadV2): Buffer => createHmac('sha256', key.material).update(canonicalBindingStringV2(payload), 'utf8').digest();

/** `v2:<kid>:<hex>`. Lança `BindingV2Error` para payload inválido. */
export function signBindingV2(key: BindingKeyV2, payload: BindingPayloadV2): string {
  return `${BINDING_V2_VERSION_TAG}:${key.kid}:${mac(key, payload).toString('hex')}`;
}

export type BindingVerifyResult =
  | { readonly ok: true; readonly kid: string }
  | { readonly ok: false; readonly reason: 'missing' | 'unsupported_version' | 'malformed' | 'unknown_kid' | 'invalid_payload' | 'mismatch' };

/**
 * Verifica a assinatura contra a lista de chaves aceitas (a atual e, numa rotação futura, a anterior). Nunca lança.
 * O motivo é para auditoria interna: quem chamar não deve repassá-lo ao cliente.
 */
export function verifyBindingV2(keys: readonly BindingKeyV2[], payload: BindingPayloadV2, signature: unknown): BindingVerifyResult {
  if (typeof signature !== 'string' || signature === '') return { ok: false, reason: 'missing' };
  // v1 = 64 hex sem prefixo; qualquer coisa que não comece com a etiqueta v2 não é tratada como v2 (sem downgrade).
  if (!signature.startsWith(`${BINDING_V2_VERSION_TAG}:`)) return { ok: false, reason: 'unsupported_version' };
  const match = SIGNATURE.exec(signature);
  if (!match) return { ok: false, reason: 'malformed' };
  const [, kid, hex] = match;
  const key = keys.find((candidate) => candidate.kid === kid);
  if (!key) return { ok: false, reason: 'unknown_kid' };
  if (validateBindingPayloadV2(payload).length > 0) return { ok: false, reason: 'invalid_payload' };

  const expected = mac(key, payload);
  const actual = Buffer.from(hex, 'hex'); // 32 bytes garantidos pelo formato
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, reason: 'mismatch' };
  return { ok: true, kid };
}
