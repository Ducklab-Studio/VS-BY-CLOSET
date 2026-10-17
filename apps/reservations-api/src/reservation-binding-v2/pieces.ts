import { createHash } from 'node:crypto';
import { MAX_SANE_RENTAL_DAYS, parseStrictCivilDateISO } from '../rental-rules/engine-guards';
import { DB_MAX_EXTRA_DAY_CENTS, DB_MAX_LINE_TOTAL_CENTS, DB_MAX_UNIT_BASE_CENTS } from '../rental-rules/rental-pricing';

/**
 * Representação CANÔNICA das peças de um pedido (HMAC v2, Fase 3). Módulo PURO, não integrado a nenhum fluxo.
 *
 * Cada peça vira uma tupla de texto determinística; tuplas IDÊNTICAS somam a quantidade (a Shopify pode mesclar ou
 * separar linhas iguais e o resultado é o mesmo); tuplas com QUALQUER campo diferente (data, duração, valor...) nunca
 * se agrupam. As linhas finais são ordenadas por unidades de código (nunca `localeCompare`, que depende de locale) e o
 * fingerprint é o SHA-256 delas com uma etiqueta de domínio.
 *
 * NÃO decide regra comercial: aceita os valores que as CHECKs da A1 aceitam (os mesmos tetos) e a fórmula do total da
 * linha que o próprio banco impõe (`ri_line_total_formula`). Cobrança no Shopify (opção A–D), taxa e arredondamento
 * continuam decisões abertas — aqui o preço é só um dado a ser assinado.
 */

/** Tetos TÉCNICOS (não comerciais) para quantidades. */
export const MAX_PIECE_QUANTITY = 1000;
export const MAX_TOTAL_QUANTITY = 10_000;

const ITEMS_DOMAIN = 'vsbc-items/v2';

export interface PieceV2Input {
  /** GID (`gid://shopify/ProductVariant/123`) ou id numérico (número ou texto): ambos viram `"123"`. */
  readonly variantId: unknown;
  readonly quantity: unknown;
  readonly pickupDate: unknown;
  readonly returnDate: unknown;
  readonly rentalDays: unknown;
  readonly prepDays: unknown;
  readonly cleaningDays: unknown;
  /** Minuto do dia da retirada (0–1439) ou `null` quando não definido. */
  readonly pickupMinuteOfDay: unknown;
  readonly unitBaseCents: unknown;
  readonly extraDayCents: unknown;
  readonly lineTotalCents: unknown;
}

export type PieceViolationCode =
  | 'no_pieces'
  | 'invalid_piece'
  | 'invalid_variant'
  | 'invalid_quantity'
  | 'invalid_date'
  | 'return_before_pickup'
  | 'invalid_days'
  | 'invalid_prep_days'
  | 'invalid_cleaning_days'
  | 'invalid_pickup_minute'
  | 'invalid_amount'
  | 'amount_above_ceiling'
  | 'line_total_mismatch'
  | 'total_quantity_above_max';

export interface PieceViolation {
  readonly code: PieceViolationCode;
  /** Índice da peça na entrada, quando a violação é de uma peça específica. */
  readonly index?: number;
}

export interface CanonicalPieces {
  /** Linhas `tupla|quantidade`, já agrupadas e ordenadas. */
  readonly lines: readonly string[];
  readonly totalQuantity: number;
  /** SHA-256 hex (64 caracteres, minúsculo) das linhas com a etiqueta de domínio. */
  readonly fingerprint: string;
}

export type CanonicalizeResult =
  | { readonly ok: true; readonly pieces: CanonicalPieces }
  | { readonly ok: false; readonly violations: readonly PieceViolation[] };

const NUMERIC_ID = /^[1-9]\d{0,19}$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/([1-9]\d{0,19})$/;

/**
 * Id de variante → só o número (texto). Aceita o GID do Storefront/Admin, o número cru do webhook (`variant_id` REST)
 * e o mesmo número em texto. Estrito: sem espaços, sem zeros à esquerda, sem query (`?key=...`), sem outro tipo de GID.
 * Devolve `null` para qualquer outra coisa — nunca "escolhe parecido".
 */
export function normalizeVariantIdV2(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value !== 'string') return null;
  if (NUMERIC_ID.test(value)) return value;
  const gid = VARIANT_GID.exec(value);
  return gid ? gid[1] : null;
}

const isIntInRange = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** Valida uma peça. Devolve a tupla canônica (sem quantidade) ou as violações dela. */
function canonicalTuple(piece: PieceV2Input, index: number, violations: PieceViolation[]): { tuple: string; quantity: number } | null {
  const before = violations.length;
  const flag = (code: PieceViolationCode) => violations.push({ code, index });

  if (piece === null || typeof piece !== 'object') {
    flag('invalid_piece');
    return null;
  }
  const variant = normalizeVariantIdV2(piece.variantId);
  if (variant === null) flag('invalid_variant');
  if (!isIntInRange(piece.quantity, 1, MAX_PIECE_QUANTITY)) flag('invalid_quantity');

  const pickup = parseStrictCivilDateISO(piece.pickupDate);
  const ret = parseStrictCivilDateISO(piece.returnDate);
  if (pickup === null || ret === null) flag('invalid_date');
  else if ((piece.returnDate as string) < (piece.pickupDate as string)) flag('return_before_pickup'); // ISO compara como texto

  if (!isIntInRange(piece.rentalDays, 1, MAX_SANE_RENTAL_DAYS)) flag('invalid_days');
  if (!isIntInRange(piece.prepDays, 0, 365)) flag('invalid_prep_days');
  if (!isIntInRange(piece.cleaningDays, 0, 365)) flag('invalid_cleaning_days');
  if (piece.pickupMinuteOfDay !== null && !isIntInRange(piece.pickupMinuteOfDay, 0, 1439)) flag('invalid_pickup_minute');

  const amounts = [
    [piece.unitBaseCents, DB_MAX_UNIT_BASE_CENTS],
    [piece.extraDayCents, DB_MAX_EXTRA_DAY_CENTS],
    [piece.lineTotalCents, DB_MAX_LINE_TOTAL_CENTS],
  ] as const;
  let amountsUsable = true;
  for (const [value, ceiling] of amounts) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      flag('invalid_amount');
      amountsUsable = false;
    } else if (value > ceiling) {
      flag('amount_above_ceiling');
      amountsUsable = false;
    }
  }
  // Fórmula que o próprio banco impõe (ri_line_total_formula): total da linha = base + (dias − 1) × diária extra.
  if (amountsUsable && isIntInRange(piece.rentalDays, 1, MAX_SANE_RENTAL_DAYS)) {
    if ((piece.unitBaseCents as number) + (piece.rentalDays - 1) * (piece.extraDayCents as number) !== piece.lineTotalCents) flag('line_total_mismatch');
  }

  if (violations.length > before || variant === null) return null;
  const tuple = [
    variant,
    piece.pickupDate,
    piece.returnDate,
    piece.rentalDays,
    piece.prepDays,
    piece.cleaningDays,
    piece.pickupMinuteOfDay === null ? '-' : piece.pickupMinuteOfDay,
    piece.unitBaseCents,
    piece.extraDayCents,
    piece.lineTotalCents,
  ].join('|');
  return { tuple, quantity: piece.quantity as number };
}

/** Comparação por unidades de código UTF-16 (determinística em qualquer locale/plataforma). */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function canonicalizePieces(pieces: readonly PieceV2Input[]): CanonicalizeResult {
  if (!Array.isArray(pieces) || pieces.length === 0) return { ok: false, violations: [{ code: 'no_pieces' }] };

  const violations: PieceViolation[] = [];
  const byTuple = new Map<string, number>();
  let totalQuantity = 0;
  pieces.forEach((piece, index) => {
    const parsed = canonicalTuple(piece, index, violations);
    if (!parsed) return;
    byTuple.set(parsed.tuple, (byTuple.get(parsed.tuple) ?? 0) + parsed.quantity);
    totalQuantity += parsed.quantity;
  });
  if (violations.length === 0 && totalQuantity > MAX_TOTAL_QUANTITY) violations.push({ code: 'total_quantity_above_max' });
  if (violations.length > 0) return { ok: false, violations };

  const lines = [...byTuple.entries()].map(([tuple, quantity]) => `${tuple}|${quantity}`).sort(byCodeUnit);
  const fingerprint = createHash('sha256').update(`${ITEMS_DOMAIN}\n${lines.join('\n')}`, 'utf8').digest('hex');
  return { ok: true, pieces: { lines, totalQuantity, fingerprint } };
}
