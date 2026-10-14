import type { Prisma } from '@prisma/client';

type Client = Pick<Prisma.TransactionClient, '$queryRaw'>;

export interface ExpiryResult {
  /** HOLDs (carrinho) cujo prazo venceu. */
  readonly holds: number;
  /** Reservas aguardando pagamento cuja janela de pagamento venceu. */
  readonly payments: number;
}

/**
 * Expira o que venceu POR TEMPO — a regra que já existia, em um lugar só:
 *
 *  - `hold` com `expires_at <= now()`;
 *  - `pending_payment` com `payment_expires_at <= now()` (janela de pagamento).
 *
 * Só estes dois estados. Reserva `confirmed` (paga), operacional, `problem` ou em
 * revisão nunca é tocada por tempo. A linha nunca é apagada (um pagamento tardio
 * ainda precisa achá-la — ver `attemptLatePaymentRecovery`) e a peça só é liberada
 * pelo gatilho do banco, que espelha `expired` nas peças ainda não recebidas.
 *
 * Concorrência: o relógio é o do banco; `FOR UPDATE SKIP LOCKED` deixa para a
 * próxima rodada qualquer reserva que um webhook de pagamento esteja processando
 * agora (nunca expira por cima de uma confirmação em andamento), e o UPDATE
 * reconfere o status depois de obter o lock. Quem perde a corrida não faz nada.
 *
 * Expiração de pagamento registra um evento `RESERVATION_EXPIRED` (sistema) para
 * que a equipe saiba POR QUE a reserva expirou. HOLD abandonado é rotina e não gera
 * evento.
 */
export async function expireDueReservations(client: Client): Promise<ExpiryResult> {
  const rows = await client.$queryRaw<{ previous: string }[]>`
    WITH due AS (
      SELECT id, status FROM reservations
      WHERE (status = 'hold' AND expires_at <= now())
         OR (status = 'pending_payment' AND payment_expires_at <= now())
      FOR UPDATE SKIP LOCKED
    ),
    expired AS (
      UPDATE reservations r SET status = 'expired'
      FROM due
      WHERE r.id = due.id AND r.status = due.status
      RETURNING r.id, due.status AS previous
    ),
    logged AS (
      INSERT INTO reservation_events (reservation_id, type, detail)
      SELECT id, 'RESERVATION_EXPIRED',
             jsonb_build_object('source', 'SYSTEM', 'reason', 'payment_window_elapsed', 'from', 'pending_payment', 'to', 'expired')
      FROM expired WHERE previous = 'pending_payment'
      RETURNING 1
    )
    SELECT previous::text AS previous FROM expired
  `;
  return {
    holds: rows.filter((row) => row.previous === 'hold').length,
    payments: rows.filter((row) => row.previous === 'pending_payment').length,
  };
}
