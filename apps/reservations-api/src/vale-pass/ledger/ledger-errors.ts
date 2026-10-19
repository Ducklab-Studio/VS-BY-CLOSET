import { ConflictException, HttpException } from '@nestjs/common';

/**
 * Traduz as recusas do banco (gatilhos do livro-razão, `vale_pass_ledger_*` e `vale_pass_use_blocked_refund_review`) em respostas HTTP seguras: nada de
 * texto de SQL, código de voucher ou dados pessoais. Devolve `null` quando o erro não é uma recusa conhecida (quem chamou trata como falha técnica).
 */
const REASONS: readonly (readonly [string, string])[] = [
  ['vale_pass_ledger_insufficient_balance', 'Saldo insuficiente para este resgate.'],
  ['vale_pass_ledger_over_credit', 'A operação deixaria o saldo acima do crédito emitido.'],
  ['vale_pass_ledger_not_redeemable', 'Este voucher não pode ser resgatado no estado atual (cancelado, expirado ou já utilizado por inteiro).'],
  ['vale_pass_ledger_blocked', 'Este voucher está bloqueado administrativamente.'],
  ['vale_pass_ledger_expired', 'Este voucher está fora da validade.'],
  ['vale_pass_ledger_not_yet_valid', 'Este voucher ainda não está no período de uso.'],
  ['vale_pass_use_blocked_refund_review', 'Este voucher pertence a um pedido com reembolso aguardando decisão de um administrador — o resgate está bloqueado até a decisão.'],
  ['vale_pass_ledger_company_mismatch', 'O lançamento é de outra empresa.'],
  ['vale_pass_ledger_legacy_voucher', 'Voucher legado não tem controle de saldo.'],
  ['vale_pass_ledger_already_reversed', 'Este lançamento já foi revertido.'],
  ['vale_pass_ledger_bad_reversal', 'Esta reversão não é válida para o lançamento informado.'],
  ['vale_pass_ledger_kind_disabled', 'Este tipo de lançamento ainda não está habilitado.'],
  ['vale_pass_ledger_immutable', 'O histórico de saldo não pode ser alterado.'],
  ['vale_pass_balance_direct_update', 'O saldo só muda por lançamento no livro-razão.'],
  ['vale_pass_used_requires_zero_balance', 'Voucher com saldo não pode ser marcado como usado.'],
];

export function ledgerRefusal(err: unknown): HttpException | null {
  if (err instanceof HttpException) return err;
  const message = err instanceof Error ? err.message : '';
  for (const [needle, text] of REASONS) if (message.includes(needle)) return new ConflictException(text);
  return null;
}
