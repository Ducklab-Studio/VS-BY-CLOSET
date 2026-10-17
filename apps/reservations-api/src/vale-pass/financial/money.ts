/**
 * Dinheiro em CENTAVOS INTEIROS. Nada aqui usa ponto flutuante para somar, multiplicar ou comparar valores.
 *
 * A Shopify envia valores como texto decimal ("350.00"); alguns campos aparecem como número em amostras da documentação. Qualquer coisa que
 * não seja um decimal não negativo com no máximo 2 casas significativas é "indefinida" (`null`) — e valor indefinido NUNCA é tratado como zero
 * nem como o valor esperado (fail-closed).
 */
export type Cents = number;

const DECIMAL = /^(\d{1,15})(?:\.(\d+))?$/;

export function parseMoneyCents(value: unknown): Cents | null {
  let text: string;
  if (typeof value === 'string') text = value.trim();
  else if (typeof value === 'number' && Number.isFinite(value)) text = String(value); // sem notação científica na faixa usada; 0.1+0.2 cai fora das 2 casas
  else return null;

  const match = DECIMAL.exec(text);
  if (!match) return null; // negativo, vazio, vírgula, expoente, espaços internos, letras...
  const fraction = match[2] ?? '';
  if (fraction.length > 2 && /[1-9]/.test(fraction.slice(2))) return null; // fração real além de centavos (ex.: 350.005)
  const cents = Number(match[1]) * 100 + Number((fraction + '00').slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Soma segura: qualquer parcela indefinida ou estouro de inteiro seguro → `null`. */
export function sumCents(values: readonly (Cents | null)[]): Cents | null {
  let total = 0;
  for (const value of values) {
    if (value === null || !Number.isSafeInteger(value) || value < 0) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

/** Multiplicação segura de centavos por uma quantidade inteira. */
export function multiplyCents(cents: Cents, quantity: number): Cents | null {
  if (!Number.isSafeInteger(cents) || cents < 0 || !Number.isSafeInteger(quantity) || quantity < 0) return null;
  const product = cents * quantity;
  return Number.isSafeInteger(product) ? product : null;
}

/** Texto para mensagens ("R$ 350,00"), a partir de centavos inteiros (sem dividir por 100 em ponto flutuante). */
export function formatCentsBRL(cents: Cents): string {
  const whole = Math.trunc(cents / 100);
  const rest = String(cents % 100).padStart(2, '0');
  return `R$ ${whole.toLocaleString('pt-BR')},${rest}`;
}
