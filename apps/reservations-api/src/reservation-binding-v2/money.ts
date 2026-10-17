/**
 * Parser monetário SEGURO (Fase 3, HMAC v2): texto decimal → centavos inteiros, sem `parseFloat`, sem `Number("1.1")`,
 * sem multiplicação por 100 de ponto flutuante. Módulo PURO: não lê ambiente, banco nem rede.
 *
 * Aceita só o formato que a Shopify usa para valores em string (`"123.45"`, `"10.5"`, `"10"`):
 *   - sem sinal por padrão (`allowNegative` existe para reembolsos/ajustes; nunca é implícito);
 *   - parte inteira sem zeros à esquerda (`"0"` é válido, `"01"` não);
 *   - 1 ou 2 casas decimais (mais casas = valor que não cabe em centavos: rejeitado, nunca arredondado);
 *   - nada de vírgula, expoente, espaços, separador de milhar, `NaN`/`Infinity`.
 */

export type MoneyParseResult =
  | { readonly ok: true; readonly cents: number }
  | { readonly ok: false; readonly reason: 'not_a_string' | 'bad_format' | 'too_large' };

export interface MoneyParseOptions {
  /** Teto em centavos (inclusive). Padrão: o maior inteiro seguro. */
  readonly maxCents?: number;
  readonly allowNegative?: boolean;
}

const MONEY_FORMAT = /^(-?)(0|[1-9]\d{0,15})(?:\.(\d{1,2}))?$/;

export function parseMoneyToCents(input: unknown, options: MoneyParseOptions = {}): MoneyParseResult {
  if (typeof input !== 'string') return { ok: false, reason: 'not_a_string' };
  const match = MONEY_FORMAT.exec(input);
  if (!match) return { ok: false, reason: 'bad_format' };
  const [, sign, whole, fraction = ''] = match;
  if (sign === '-' && !options.allowNegative) return { ok: false, reason: 'bad_format' };

  // Só aritmética de inteiros: "10.5" → 10 * 100 + 50.
  const magnitude = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(magnitude)) return { ok: false, reason: 'too_large' };
  const cents = sign === '-' ? -magnitude : magnitude;
  // "-0" / "-0.00" são zero, nunca -0.
  const normalized = cents === 0 ? 0 : cents;
  const max = options.maxCents ?? Number.MAX_SAFE_INTEGER;
  if (Math.abs(normalized) > max) return { ok: false, reason: 'too_large' };
  return { ok: true, cents: normalized };
}

/** Centavos inteiros → texto com 2 casas ("4999" → "49.99"). Lança para qualquer coisa que não seja inteiro seguro. */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError('formatCents exige um inteiro seguro.');
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
