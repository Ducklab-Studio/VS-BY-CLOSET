/**
 * Item 10 da Fase 7 — transições de status centralizadas aqui, nunca
 * espalhadas em `if`s por handler de webhook. Qualquer transição não
 * listada é proibida por construção (fail closed): `canTransition`
 * devolve `false` pra tudo que não está explicitamente na lista, então
 * um bug num handler que tentasse "completed → pending_payment" ou
 * "cancelled → hold" é pego aqui, não silenciosamente aplicado.
 *
 * Cobre só as transições que a Fase 7 realmente ESCREVE via webhook —
 * `hold→pending_payment` e `hold→expired` já existiam (Fase 5/6,
 * escritas por HoldsService/CheckoutService, não por aqui) e estão
 * listadas só por completude documental.
 */
export type ReservationStatusValue =
  | 'hold'
  | 'pending_payment'
  | 'confirmed'
  | 'cancelled'
  | 'expired'
  | 'problem'
  | 'late_payment_conflict'
  | 'preparing'
  | 'ready_for_pickup'
  | 'picked_up'
  | 'returned'
  | 'cleaning'
  | 'pending'
  | 'completed';

const ALLOWED_TRANSITIONS: Partial<Record<ReservationStatusValue, ReadonlySet<ReservationStatusValue>>> = {
  // `problem` aqui cobre o endurecimento da correlação Order↔Reservation:
  // um webhook pode chegar com assinatura/linhas que não batem enquanto
  // a reserva ainda está em `hold` (ex.: tentativa de correlação
  // forjada antes mesmo do checkout ter sido concluído do nosso lado).
  hold: new Set(['pending_payment', 'expired', 'problem']),

  // Confirmação normal, expiração da janela de pagamento, cancelamento
  // antes de pagar, e o caso "algo não bate" — ver WebhooksService.
  pending_payment: new Set(['confirmed', 'expired', 'cancelled', 'problem']),

  // Late payment (item 8/9 da Fase 7): recuperação atômica quando a
  // capacidade original ainda está livre, `late_payment_conflict` (não
  // `problem` genérico — ver comentário no enum, schema.prisma) quando
  // não está, e `problem` especificamente pro caso de correlação
  // inválida (assinatura/linhas não batem) num pagamento tardio — é uma
  // falha diferente de "capacidade já foi pra outra reserva".
  expired: new Set(['confirmed', 'late_payment_conflict', 'problem']),

  // Cancelamento depois de confirmado, ou uma inconsistência (ex.:
  // refund inesperado) que precisa de revisão humana.
  confirmed: new Set(['cancelled', 'returned', 'problem']),

  // Item 11: cancelamento chegando depois da retirada NUNCA vira
  // `cancelled` automaticamente — o único destino permitido daqui é
  // `problem`, pra revisão manual.
  preparing: new Set(['problem']),
  ready_for_pickup: new Set(['problem']),
  picked_up: new Set(['returned', 'problem']),
  returned: new Set(['cleaning', 'problem']),
  cleaning: new Set(['completed', 'problem']),

  // Terminais nesta fase — resolução de `problem`/`cancelled`/
  // `late_payment_conflict` é trabalho humano fora deste sistema
  // (painel administrativo, fase futura), não um webhook.
  problem: new Set([]),
  cancelled: new Set([]),
  late_payment_conflict: new Set([]),
};

export function canTransition(from: ReservationStatusValue, to: ReservationStatusValue): boolean {
  if (from === to) return false; // "transição" pra si mesmo não é uma transição — ver isIdempotentNoOp nos handlers
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}
