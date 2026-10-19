import { BadRequestException } from '@nestjs/common';

/**
 * Dinheiro do Valle Pass é SEMPRE centavos inteiros (nunca ponto flutuante). R$ 500,00 = 50000; R$ 50,00 = 5000.
 * Teto técnico de uma operação: R$ 1.000.000,00 (muito acima de qualquer voucher; só impede lixo/overflow antes de chegar ao banco).
 */
export const MAX_OPERATION_CENTS = 100_000_000;

/** Aceita somente número inteiro seguro > 0 e ≤ teto. Texto, decimal (350.5), notação científica, NaN/Infinity e negativos são recusados. */
export function parsePositiveCents(value: unknown, field = 'amountCents'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_OPERATION_CENTS) {
    throw new BadRequestException(`${field} deve ser um número inteiro de centavos maior que zero (ex.: R$ 200,00 = 20000).`);
  }
  return value;
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
/** Só para exibição/mensagens: a conta nunca é feita em reais. */
export function formatBRL(cents: number): string {
  return brl.format(cents / 100).replace(/ /g, ' ');
}
