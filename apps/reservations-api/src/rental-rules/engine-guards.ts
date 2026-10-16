/**
 * Guardas de entrada dos motores puros da Fase 3 (preço, cronograma, alocação).
 *
 * São ESTRITAS de propósito e vivem num arquivo novo: `civil-date.ts` (em uso pelo fluxo legado) normaliza overflow
 * ("2026-02-31" vira "2026-03-03") e o comportamento dele NÃO foi alterado. Os motores novos não herdam essa
 * normalização: data inexistente é rejeitada.
 */

import { type CivilDate, civilDate } from './civil-date';

/**
 * Teto INTERNO de sanidade para a duração de uma peça, em dias (~10 anos). NÃO é regra comercial: o teto comercial
 * (se existir) é `maxDays`/`maxDaysPerItem`, sempre menor ou igual a este. Existe só para impedir que durações
 * absurdas estourem datas ou preços (fail closed).
 */
export const MAX_SANE_RENTAL_DAYS = 3650;

/** Faixa de anos aceita em datas civis dos motores (evita datas fora do alcance do `Date`). */
export const MIN_CIVIL_YEAR = 1970;
export const MAX_CIVIL_YEAR = 2200;

/** A data existe no calendário (mês 1–12, dia dentro do mês, ano na faixa) e é composta só de inteiros? */
export function isValidCivilDate(value: unknown): value is CivilDate {
  if (typeof value !== 'object' || value === null) return false;
  const { year, month, day } = value as Record<string, unknown>;
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const y = year as number;
  const m = month as number;
  const d = day as number;
  if (y < MIN_CIVIL_YEAR || y > MAX_CIVIL_YEAR || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const normalized = civilDate(y, m, d);
  return normalized.year === y && normalized.month === m && normalized.day === d;
}

/** "YYYY-MM-DD" estrito → data civil, ou `null` se o formato ou a data forem inválidos (nunca lança, nunca normaliza). */
export function parseStrictCivilDateISO(iso: unknown): CivilDate | null {
  if (typeof iso !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const candidate = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  return isValidCivilDate(candidate) ? candidate : null;
}

/** Janela [início, fim) não vazia e com datas válidas. */
export function isValidBlockedRange(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const { blockedFrom, blockedUntilExclusive } = value as Record<string, unknown>;
  if (!isValidCivilDate(blockedFrom) || !isValidCivilDate(blockedUntilExclusive)) return false;
  const a = blockedFrom;
  const b = blockedUntilExclusive;
  return a.year * 10_000 + a.month * 100 + a.day < b.year * 10_000 + b.month * 100 + b.day;
}
