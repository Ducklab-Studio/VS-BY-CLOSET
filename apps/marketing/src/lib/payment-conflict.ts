/**
 * Pagamento recebido com conflito de disponibilidade (`late_payment_conflict`) — regras puras,
 * sem rede e sem React, compartilhadas pelo painel inicial, pela lista, pelo detalhe e testadas
 * em test/payment-conflict.test.mjs.
 *
 * O estado nasce quando a cliente PAGA depois que a reserva expirou e a peça já foi ocupada por
 * outra reserva: o pagamento é real (está na Shopify), mas a reserva NÃO pôde ser confirmada.
 * Nada aqui confirma, cancela, libera ou reembolsa: é só informação para a equipe agir.
 */

export const PAYMENT_CONFLICT_STATUS = 'late_payment_conflict';
export const PAYMENT_CONFLICT_LABEL = 'Pagamento recebido — conflito de disponibilidade';
/** Lista já filtrada (a API aceita `status=late_payment_conflict`). */
export const PAYMENT_CONFLICT_LIST_HREF = '/closetadmin/reservas?status=late_payment_conflict';

export function isPaymentConflict(status: string | null | undefined): boolean {
  return status === PAYMENT_CONFLICT_STATUS;
}

/** Quantas reservas estão em conflito. Reservas normais nunca entram. */
export function paymentConflictCount(rows: readonly { status: string }[]): number {
  return rows.filter((row) => isPaymentConflict(row.status)).length;
}

/**
 * Contador "Requer atenção": o que exige conferência humana — reserva em revisão (`problem`)
 * OU pagamento recebido sem peça (`late_payment_conflict`). Reservas confirmadas, novas ou
 * aguardando pagamento nunca entram aqui.
 */
export function attentionTotal(rows: readonly { status: string }[]): number {
  return rows.filter((row) => row.status === 'problem' || isPaymentConflict(row.status)).length;
}

export function conflictHeadline(count: number): string {
  return count === 1
    ? '1 reserva com pagamento recebido e conflito de disponibilidade'
    : `${count} reservas com pagamento recebido e conflito de disponibilidade`;
}

export const PAYMENT_CONFLICT_SUMMARY =
  'A cliente pagou depois de a reserva expirar e a peça já estava ocupada por outra reserva. A reserva NÃO foi confirmada e nada foi cancelado, liberado ou reembolsado automaticamente.';

export const PAYMENT_CONFLICT_STEPS: readonly string[] = [
  'Confira o pagamento no pedido da Shopify (o número está abaixo).',
  'Decida com a cliente: atendimento alternativo (outra peça ou outra data) ou reembolso, feito pela Shopify.',
  'Não confirme esta reserva enquanto a peça estiver ocupada por outra cliente.',
];

const EVENT_LABELS: Record<string, string> = {
  LATE_PAYMENT_RECEIVED: 'Pagamento recebido depois de a reserva expirar',
  LATE_PAYMENT_CONFLICT: 'Conflito de disponibilidade: a reserva não pôde ser confirmada',
  LATE_PAYMENT_RECOVERED: 'Pagamento tardio recuperado: reserva confirmada',
};

/** Rótulo legível dos eventos de pagamento tardio; os demais seguem como o painel já mostrava. */
export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type;
}

/**
 * Motivo curto do conflito, do `detail` do evento `LATE_PAYMENT_CONFLICT`. Só texto, limitado, e
 * nunca outros campos do detalhe (que podem carregar identificadores): nada pessoal vai à tela.
 */
export function conflictReason(type: string, detail: unknown): string | null {
  if (type !== 'LATE_PAYMENT_CONFLICT' || typeof detail !== 'object' || detail === null) return null;
  const reason = (detail as { reason?: unknown }).reason;
  if (typeof reason !== 'string') return null;
  const text = reason.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 200) : null;
}
