import { Prisma, type ReservationStatus } from '@prisma/client';

/**
 * "Novas reservas" no menu do ClosetAdmin — mesma ideia do contador do Valle
 * Pass, para as reservas de ALUGUEL que vieram da Shopify.
 *
 * Conta uma reserva quando:
 *  - é online (`source = online`) e tem pedido Shopify vinculado — HOLD,
 *    checkout abandonado e reserva manual da equipe ficam de fora; pedido
 *    comum (sem `reservation_id`) nunca vira reserva, e Valle Pass mora em
 *    outra tabela;
 *  - está pendente de pagamento ou confirmada (expirada, cancelada, recusada
 *    etc. nunca geram alerta novo);
 *  - não está arquivada;
 *  - ninguém da equipe a viu NESTE status (`viewed_status` diferente do
 *    status atual): visto como pendente e depois pago → volta a contar.
 */
export const RESERVATION_ATTENTION_STATUSES: readonly ReservationStatus[] = ['pending_payment', 'confirmed'];

export interface ReservationAttentionFields {
  readonly source: string;
  readonly shopifyOrderId: string | null;
  readonly status: string;
  readonly archivedAt: Date | string | null;
  readonly viewedStatus: string | null;
}

export function reservationNeedsAttention(r: ReservationAttentionFields): boolean {
  return (
    r.source === 'online' &&
    !!r.shopifyOrderId &&
    !r.archivedAt &&
    (RESERVATION_ATTENTION_STATUSES as readonly string[]).includes(r.status) &&
    r.viewedStatus !== r.status
  );
}

/** A mesma regra em SQL (alias da tabela `reservations`). */
export function reservationAttentionSql(alias = 'r'): Prisma.Sql {
  const t = Prisma.raw(alias);
  return Prisma.sql`(
    ${t}.source = 'online'
    AND ${t}.shopify_order_id IS NOT NULL
    AND ${t}.archived_at IS NULL
    AND ${t}.status IN ('pending_payment', 'confirmed')
    AND ${t}.viewed_status IS DISTINCT FROM ${t}.status
  )`;
}
