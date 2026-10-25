/**
 * Helpers PUROS do saldo/resgate do Valle Pass no ClosetAdmin (sem React, sem rede): entrada de valores em reais → centavos INTEIROS, formatação em BRL e
 * tradução dos códigos de erro da API. A conta nunca é feita com ponto flutuante: o texto digitado vira centavos por manipulação de string.
 * Nada aqui protege saldo — quem protege é o backend (e os gatilhos do banco); isto só evita erro de digitação e explica as recusas.
 */

/** Teto técnico da API por operação (centavos). */
export const MAX_OPERATION_CENTS = 100_000_000;

/**
 * "200" → 20000, "200,5" → 20050, "1.234,56" → 123456. Só formato pt-BR (vírgula decimal, ponto de milhar). Recusa (null): vazio, zero, negativo, letras,
 * mais de 2 casas, "200.50" (ambíguo: use vírgula), notação científica e valores acima do teto.
 */
export function parseReaisToCents(input: string): number | null {
  const text = input.replace(/^\s*R\$\s*/i, '').trim();
  const match = /^(\d+|\d{1,3}(?:\.\d{3})+)(?:,(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const whole = match[1].replace(/\./g, '');
  const decimals = (match[2] ?? '').padEnd(2, '0');
  if (whole.length > 9) return null; // evita número fora do intervalo seguro antes de converter
  const cents = Number(whole) * 100 + Number(decimals);
  return Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_OPERATION_CENTS ? cents : null;
}

/** 20050 → "200,50" (campo de valor, sem R$ nem milhar): o que `parseReaisToCents` aceita de volta sem perda. */
export function centsToInput(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const decimals = String(Math.abs(cents % 100)).padStart(2, '0');
  return `${whole},${decimals}`;
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
/** Exibição apenas (R$ 1.234,56). */
export function formatCents(cents: number): string {
  return brl.format(cents / 100).replace(/ /g, ' ');
}

export const COMPANY_LABELS = { VALLE_SHOWROOM: 'Valle Showroom', VS_BY_CLOSET: 'VS BY CLOSET' } as const;
export type BalanceCompany = keyof typeof COMPANY_LABELS;

/** Códigos de recusa da API (`code` no corpo do 409) → texto curto para o operador. */
export const BALANCE_ERROR_TEXT: Record<string, string> = {
  COMPANY_MISMATCH: 'Este voucher é de outra empresa. O saldo de uma empresa nunca é usado na outra.',
  INSUFFICIENT_BALANCE: 'Saldo insuficiente para este valor.',
  BALANCE_CHANGED: 'O saldo mudou desde a conferência. Confira o novo saldo e tente de novo.',
  IDEMPOTENCY_CONFLICT: 'Esta operação já foi enviada com outro conteúdo. Refaça a conferência.',
  OPERATION_IN_PROGRESS: 'Esta operação já está sendo processada. Consulte o voucher de novo.',
  ALREADY_REVERSED: 'Este resgate já foi revertido.',
  NOT_A_REDEMPTION: 'Só um resgate pode ser revertido.',
  ENTRY_NOT_FOUND: 'Lançamento não encontrado neste voucher.',
  OVER_CREDIT: 'A reversão deixaria o saldo acima do crédito emitido.',
  CANCELLED: 'Voucher cancelado.',
  EXPIRED: 'Voucher fora da validade.',
  NOT_YET_VALID: 'Voucher ainda não está no período de uso.',
  BLOCKED: 'Voucher bloqueado administrativamente.',
  USED_UP: 'Voucher sem saldo.',
  REFUND_UNDER_REVIEW: 'Pedido com reembolso aguardando decisão de um administrador. Resgate bloqueado até a decisão.',
  ORDER_CANCELLED: 'O pedido deste voucher foi cancelado ou reembolsado.',
  LEGACY_NO_BALANCE: 'Voucher legado: não tem controle de saldo.',
  ALREADY_BLOCKED: 'Este voucher já está bloqueado.',
  NOT_BLOCKED: 'Este voucher não está bloqueado.',
};

/** Texto mostrado ao operador: o da tabela quando o código é conhecido; senão a mensagem da API (já sem dados sensíveis). */
export function describeBalanceError(code: string | null | undefined, fallback: string): string {
  return (code && BALANCE_ERROR_TEXT[code]) || fallback;
}

/** Porcentagem de uso para a barra (0–100, inteira). */
export function usedPercent(amountCents: number, balanceCents: number): number {
  if (amountCents <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round(((amountCents - balanceCents) / amountCents) * 100)));
}
