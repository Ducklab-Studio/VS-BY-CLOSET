/**
 * Valor da reserva de aluguel: a SOMA exata de todas as peças, nunca o preço
 * da última. Arquivo puro (sem imports) para test/rental-price.test.mjs.
 *
 *  - a conta é feita em centavos inteiros: a ordem das peças não muda o total
 *    e 0,10 + 0,20 nunca vira 0,30000000000000004;
 *  - R$ 0 é um preço válido e soma como zero. Preço ausente ou ilegível NÃO
 *    vira zero: o total fica "a confirmar" em vez de exibir um número errado
 *    (`0`, `null`, `undefined` e `''` são coisas diferentes aqui);
 *  - a Shopify é a fonte de verdade: com todas as peças já no carrinho, o total
 *    exibido é `cart.cost.totalAmount`; a soma local é só a prévia de antes.
 */

export interface MoneyValue {
  readonly amount: string;
  readonly currencyCode: string;
}

const DECIMAL = /^(\d{1,13})(?:\.(\d{1,9}))?$/;
const CURRENCY = /^[A-Z]{3}$/;

export const isCurrencyCode = (value: unknown): value is string => typeof value === 'string' && CURRENCY.test(value);

/**
 * Preço em reais (MoneyV2.amount da Shopify: "200.0", "0.0", "89.90"; ou
 * número) → centavos. Arredonda a 3ª casa. Ausente, vazio, negativo ou
 * ilegível (inclusive "200,00") → `null` — nunca 0.
 */
export function amountToCents(amount: unknown): number | null {
  if (typeof amount === 'number') return Number.isFinite(amount) && amount >= 0 ? amountToCents(String(amount)) : null;
  if (typeof amount !== 'string') return null;
  const match = DECIMAL.exec(amount.trim());
  if (!match) return null;
  const fraction = (match[2] ?? '').padEnd(3, '0');
  const cents = Number(match[1]) * 100 + Number(fraction.slice(0, 2)) + (Number(fraction[2]) >= 5 ? 1 : 0);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Valor que JÁ está em centavos (inteiro ≥ 0, número ou texto) → centavos; o resto → `null`. */
export function parseCents(value: unknown): number | null {
  const n = typeof value === 'string' && /^\d{1,15}$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Centavos → texto decimal no formato da Shopify ("200.00"), sem passar por ponto flutuante. */
export function centsToAmount(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

export interface PriceItem {
  readonly id: string;
  /** Preço UNITÁRIO em reais (texto decimal da Shopify ou número). */
  readonly amount: unknown;
  readonly currencyCode: unknown;
  readonly quantity?: number;
}

export type PriceSum =
  | { readonly status: 'ok'; readonly cents: number; readonly amount: string; readonly currencyCode: string }
  | { readonly status: 'empty' }
  | { readonly status: 'missing'; readonly missing: readonly string[] }
  | { readonly status: 'mixed_currency' };

const quantityOf = (item: PriceItem) => (Number.isInteger(item.quantity) && (item.quantity as number) > 0 ? (item.quantity as number) : 1);

/** Soma preço × quantidade de TODOS os itens. Um preço ausente deixa o total "a confirmar". */
export function sumPrices(items: readonly PriceItem[]): PriceSum {
  if (items.length === 0) return { status: 'empty' };
  const missing = items.filter((item) => amountToCents(item.amount) === null || !isCurrencyCode(item.currencyCode)).map((item) => item.id);
  if (missing.length > 0) return { status: 'missing', missing };
  const currencies = new Set(items.map((item) => item.currencyCode));
  if (currencies.size > 1) return { status: 'mixed_currency' };
  const cents = items.reduce((sum, item) => sum + (amountToCents(item.amount) as number) * quantityOf(item), 0);
  if (!Number.isSafeInteger(cents)) return { status: 'missing', missing: items.map((item) => item.id) };
  return { status: 'ok', cents, amount: centsToAmount(cents), currencyCode: items[0].currencyCode as string };
}

/** Peça escolhida na vitrine (ainda fora do carrinho): o preço é a prévia. */
export interface SelectionPiece {
  readonly variantId: string;
  readonly title: string;
  readonly handle?: string | null;
  readonly priceAmount: string | null;
  readonly currencyCode: string | null;
}

/** Prévia do total das peças escolhidas (barra do catálogo). */
export function selectionTotal(pieces: readonly SelectionPiece[]): PriceSum {
  return sumPrices(pieces.map((piece) => ({ id: piece.variantId, amount: piece.priceAmount, currencyCode: piece.currencyCode })));
}

/** O que importa de uma linha do carrinho da Shopify para o valor. */
export interface PricedCartLine {
  readonly quantity: number;
  readonly merchandise: {
    readonly id: string;
    readonly price?: MoneyValue | null;
    readonly product?: { readonly title: string; readonly handle: string } | null;
  };
}

export interface PricedCart {
  readonly lines: readonly PricedCartLine[];
  readonly cost?: { readonly totalAmount?: MoneyValue | null } | null;
}

export interface SummaryRow {
  readonly variantId: string;
  readonly title: string;
  readonly handle: string | null;
  readonly quantity: number;
  /** Preço unitário normalizado ("200.00"): o da linha do carrinho (Shopify) se a peça já está nele; senão o da vitrine. `null` = a confirmar. */
  readonly unitAmount: string | null;
  readonly currencyCode: string | null;
  readonly inCart: boolean;
  readonly inSelection: boolean;
}

export type SummaryTotal =
  /** Tudo já está no carrinho: total OFICIAL da Shopify. `previewCents` é a soma local, só para comparar. */
  | { readonly source: 'shopify'; readonly cents: number; readonly amount: string; readonly currencyCode: string; readonly previewCents: number | null }
  /** Alguma peça ainda vai entrar: soma local (prévia) das peças que o carrinho terá. */
  | { readonly source: 'preview'; readonly cents: number; readonly amount: string; readonly currencyCode: string }
  | { readonly source: 'unknown'; readonly reason: 'missing' | 'mixed_currency' | 'empty' };

export interface ReservationSummary {
  readonly rows: readonly SummaryRow[];
  /** Peças da reserva (soma das quantidades). */
  readonly pieces: number;
  readonly total: SummaryTotal;
}

const normalized = (amount: unknown): string | null => {
  const cents = amountToCents(amount);
  return cents === null ? null : centsToAmount(cents);
};

/**
 * Resumo da reserva = peças da seleção + peças que já estão no carrinho, cada
 * variante uma vez (é o que o carrinho terá depois do "Alugar agora", que
 * nunca duplica linha). Preço de cada linha: o do carrinho quando a peça já
 * está nele; senão o da vitrine.
 */
export function reservationSummary(selection: readonly SelectionPiece[], cart: PricedCart | null): ReservationSummary {
  const lines = cart?.lines ?? [];
  const cartRows = new Map<string, { quantity: number; line: PricedCartLine }>();
  for (const line of lines) {
    const current = cartRows.get(line.merchandise.id);
    const quantity = Number.isInteger(line.quantity) && line.quantity > 0 ? line.quantity : 1;
    cartRows.set(line.merchandise.id, { quantity: (current?.quantity ?? 0) + quantity, line: current?.line ?? line });
  }

  const rows: SummaryRow[] = [];
  const seen = new Set<string>();
  for (const piece of selection) {
    if (seen.has(piece.variantId)) continue;
    seen.add(piece.variantId);
    const inCart = cartRows.get(piece.variantId);
    rows.push({
      variantId: piece.variantId,
      title: piece.title,
      handle: piece.handle ?? null,
      quantity: inCart?.quantity ?? 1,
      unitAmount: normalized(inCart ? inCart.line.merchandise.price?.amount : piece.priceAmount),
      currencyCode: (inCart ? inCart.line.merchandise.price?.currencyCode : piece.currencyCode) ?? null,
      inCart: !!inCart,
      inSelection: true,
    });
  }
  for (const [variantId, { quantity, line }] of cartRows) {
    if (seen.has(variantId)) continue;
    seen.add(variantId);
    rows.push({
      variantId,
      title: line.merchandise.product?.title ?? '',
      handle: line.merchandise.product?.handle ?? null,
      quantity,
      unitAmount: normalized(line.merchandise.price?.amount),
      currencyCode: line.merchandise.price?.currencyCode ?? null,
      inCart: true,
      inSelection: false,
    });
  }

  const pieces = rows.reduce((sum, row) => sum + row.quantity, 0);
  const preview = sumPrices(rows.map((row) => ({ id: row.variantId, amount: row.unitAmount, currencyCode: row.currencyCode, quantity: row.quantity })));
  const officialCents = amountToCents(cart?.cost?.totalAmount?.amount);
  const officialCurrency = cart?.cost?.totalAmount?.currencyCode;
  if (rows.length > 0 && rows.every((row) => row.inCart) && officialCents !== null && isCurrencyCode(officialCurrency)) {
    return {
      rows,
      pieces,
      total: { source: 'shopify', cents: officialCents, amount: centsToAmount(officialCents), currencyCode: officialCurrency, previewCents: preview.status === 'ok' ? preview.cents : null },
    };
  }
  if (preview.status === 'ok') return { rows, pieces, total: { source: 'preview', cents: preview.cents, amount: preview.amount, currencyCode: preview.currencyCode } };
  return { rows, pieces, total: { source: 'unknown', reason: preview.status } };
}
