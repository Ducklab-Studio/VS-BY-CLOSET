import { describe, expect, test } from 'vitest';
import { formatCents, parseMoneyToCents } from './money';

const cents = (input: unknown, options?: Parameters<typeof parseMoneyToCents>[1]) => {
  const result = parseMoneyToCents(input, options);
  return result.ok ? result.cents : result.reason;
};

describe('parseMoneyToCents: texto decimal → centavos inteiros', () => {
  test('formatos válidos da Shopify', () => {
    expect(cents('0')).toBe(0);
    expect(cents('0.00')).toBe(0);
    expect(cents('0.5')).toBe(50);
    expect(cents('10')).toBe(1000);
    expect(cents('10.5')).toBe(1050);
    expect(cents('123.45')).toBe(12345);
    expect(cents('49.99')).toBe(4999);
    expect(cents('1500000.00')).toBe(150_000_000);
  });

  test('casos clássicos de ponto flutuante dão o inteiro exato', () => {
    // 0.1 + 0.2, 1.1 * 100, 19.99 * 100, 4.35 * 100: todos errados em float
    for (const [text, expected] of [['0.30', 30], ['1.10', 110], ['19.99', 1999], ['4.35', 435], ['8.2', 820], ['1.005'.slice(0, 4), 100], ['33.33', 3333]] as const) {
      expect(cents(text)).toBe(expected);
    }
  });

  test('rejeita tudo que não seja o formato estrito', () => {
    for (const bad of ['', ' ', '1,5', '1.', '.5', '01', '00.10', '1.234', '1e3', '1E3', '0x10', ' 10', '10 ', '+10', '1_000', '1 000', 'NaN', 'Infinity', '-', '--1', '1.2.3', '１２', '10.5\n', '１0']) {
      expect(cents(bad), JSON.stringify(bad)).toBe('bad_format');
    }
  });

  test('só aceita texto: número, null, undefined, objeto e bigint são recusados', () => {
    for (const bad of [10, 10.5, Number.NaN, null, undefined, {}, [], true, 10n]) expect(cents(bad)).toBe('not_a_string');
  });

  test('negativo só com autorização explícita; "-0" vira zero', () => {
    expect(cents('-1.50')).toBe('bad_format');
    expect(cents('-1.50', { allowNegative: true })).toBe(-150);
    expect(Object.is(cents('-0.00', { allowNegative: true }), 0)).toBe(true);
  });

  test('teto: acima do máximo informado ou do inteiro seguro é recusado, nunca arredondado', () => {
    expect(cents('100000000.00', { maxCents: 100_000_000 * 100 })).toBe(10_000_000_000);
    expect(cents('1000000.01', { maxCents: 100_000_000 })).toBe('too_large');
    expect(cents('1000000.00', { maxCents: 100_000_000 })).toBe(100_000_000);
    expect(cents('90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER); // o maior valor representável com exatidão
    expect(cents('90071992547409.92')).toBe('too_large'); // 9007199254740992 já não é seguro
    expect(cents('9999999999999999')).toBe('too_large'); // cabe no formato, mas ×100 estoura
    expect(cents('99999999999999999')).toBe('bad_format'); // mais de 16 dígitos inteiros
  });

  test('ida e volta: formatCents(parse(x)) === x para valores normalizados', () => {
    for (const value of [0, 1, 9, 10, 99, 100, 4999, 12345, 100_000_000, 2_000_000_000]) {
      const text = formatCents(value);
      expect(cents(text)).toBe(value);
    }
    expect(formatCents(4999)).toBe('49.99');
    expect(formatCents(-5)).toBe('-0.05');
    expect(() => formatCents(1.5)).toThrow(RangeError);
    expect(() => formatCents(Number.NaN)).toThrow(RangeError);
  });
});
