import { describe, expect, test } from 'vitest';
import { MAX_CIVIL_YEAR, MAX_SANE_RENTAL_DAYS, MIN_CIVIL_YEAR, isValidBlockedRange, isValidCivilDate, parseStrictCivilDateISO } from './engine-guards';

describe('isValidCivilDate', () => {
  test('aceita datas reais, inclusive 29/02 de anos bissextos e os extremos da faixa', () => {
    for (const d of [{ year: 2026, month: 10, day: 26 }, { year: 2028, month: 2, day: 29 }, { year: 2000, month: 2, day: 29 }, { year: 2026, month: 12, day: 31 }, { year: MIN_CIVIL_YEAR, month: 1, day: 1 }, { year: MAX_CIVIL_YEAR, month: 12, day: 31 }]) {
      expect(isValidCivilDate(d)).toBe(true);
    }
  });

  test('rejeita o que não existe, não é inteiro ou está fora da faixa', () => {
    const bad: unknown[] = [
      { year: 2026, month: 2, day: 29 },
      { year: 2100, month: 2, day: 29 },
      { year: 2026, month: 4, day: 31 },
      { year: 2026, month: 13, day: 1 },
      { year: 2026, month: 1, day: 0 },
      { year: 2026, month: 1, day: 32 },
      { year: NaN, month: 1, day: 1 },
      { year: 2026, month: 1.5, day: 1 },
      { year: Infinity, month: 1, day: 1 },
      { year: MIN_CIVIL_YEAR - 1, month: 12, day: 31 },
      { year: MAX_CIVIL_YEAR + 1, month: 1, day: 1 },
      { year: '2026', month: 1, day: 1 },
      {},
      null,
      undefined,
      'x',
      7,
    ];
    for (const value of bad) expect(isValidCivilDate(value)).toBe(false);
  });
});

describe('parseStrictCivilDateISO', () => {
  test('só YYYY-MM-DD de datas reais; nunca lança nem normaliza', () => {
    expect(parseStrictCivilDateISO('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 });
    for (const bad of ['2026-02-31', '2027-02-29', '2026-13-01', '2026-1-1', '', ' 2026-01-01', '2026-01-01T00:00', null, undefined, 5]) expect(parseStrictCivilDateISO(bad)).toBeNull();
  });
});

describe('isValidBlockedRange', () => {
  const r = (a: [number, number, number], b: [number, number, number]) => ({ blockedFrom: { year: a[0], month: a[1], day: a[2] }, blockedUntilExclusive: { year: b[0], month: b[1], day: b[2] } });
  test('janela não vazia, em ordem, com datas reais', () => {
    expect(isValidBlockedRange(r([2026, 12, 31], [2027, 1, 1]))).toBe(true);
    expect(isValidBlockedRange(r([2026, 12, 31], [2026, 12, 31]))).toBe(false);
    expect(isValidBlockedRange(r([2027, 1, 1], [2026, 12, 31]))).toBe(false);
    expect(isValidBlockedRange(r([2026, 2, 31], [2026, 3, 5]))).toBe(false);
    expect(isValidBlockedRange(null)).toBe(false);
    expect(isValidBlockedRange({ blockedFrom: { year: 2026, month: 1, day: 1 } })).toBe(false);
  });
});

test('teto interno de sanidade não é regra comercial: ~10 anos', () => {
  expect(MAX_SANE_RENTAL_DAYS).toBe(3650);
});
