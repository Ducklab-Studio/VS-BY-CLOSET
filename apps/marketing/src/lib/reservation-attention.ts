/**
 * Contador de novas reservas de aluguel no menu do ClosetAdmin — textos e
 * canais de aviso. O ciclo de atualização é o mesmo do Valle Pass
 * (`startAttentionPoller` em lib/valle-pass-attention.ts). Arquivo puro (sem
 * imports) para test/reservation-attention.test.mjs.
 *
 * A contagem é do servidor (GET /admin/reservations/attention): reservas da
 * Shopify pendentes de pagamento ou confirmadas que ninguém da equipe viu
 * neste status.
 */

/** Mesma aba: a tela de Reservas avisa o menu depois de marcar como vista. */
export const RESERVATION_ATTENTION_EVENT = 'closetadmin:reservation-attention';
/** Outras abas do mesmo navegador (BroadcastChannel). */
export const RESERVATION_ATTENTION_CHANNEL = 'closetadmin-reservation-attention';
/** A tela de Reservas se atualiza sozinha neste intervalo (aba visível). */
export const RESERVATIONS_REFRESH_MS = 30_000;

/**
 * Número do menu de Reservas = reservas novas (pendentes/confirmadas que ninguém viu) + pagamentos a tratar.
 * São conjuntos disjuntos por construção (status e pedidos diferentes no servidor), então a soma não duplica nada;
 * `alerts` leva a parte financeira separada, para o texto de acessibilidade e para quem quiser distinguir.
 */
export function combineReservationAttention(newReservations: number, paymentAlerts: number): { count: number; alerts?: number } {
  const fresh = Number.isFinite(newReservations) && newReservations > 0 ? Math.floor(newReservations) : 0;
  const alerts = Number.isFinite(paymentAlerts) && paymentAlerts > 0 ? Math.floor(paymentAlerts) : 0;
  return alerts > 0 ? { count: fresh + alerts, alerts } : { count: fresh };
}

/** Texto para leitor de tela, anexado ao nome do link "Reservas". */
export function reservationAttentionLabel(count: number | null, paymentAlerts = 0): string {
  if (!count || count <= 0) return 'nenhuma reserva nova';
  if (paymentAlerts > 0) {
    // `count` já inclui os pagamentos a tratar: separa os dois, sem contar nada duas vezes.
    const alerts = Math.min(paymentAlerts, count);
    const fresh = count - alerts;
    const parts = [
      fresh > 0 ? (fresh === 1 ? '1 reserva nova' : `${fresh > 99 ? 'mais de 99' : fresh} reservas novas`) : null,
      alerts === 1 ? '1 pagamento a tratar' : `${alerts > 99 ? 'mais de 99' : alerts} pagamentos a tratar`,
    ].filter(Boolean);
    return parts.join(' e ');
  }
  return count === 1 ? '1 reserva nova' : `${count > 99 ? 'mais de 99' : count} reservas novas`;
}

/** Statuses em que uma reserva pode estar "nova" (o servidor decide quais estão). */
export const RESERVATION_ATTENTION_STATUSES = ['pending_payment', 'confirmed'] as const;

export interface AttentionRow {
  readonly id: string;
  readonly status: string;
  readonly needsAttention: boolean;
}

/** Reservas exibidas que ainda contam como novas e ainda não foram mandadas
 *  para "vista" nesta página (chave id@status: mudou de status, manda de novo). */
export function rowsToMarkViewed(rows: readonly AttentionRow[], alreadySent: ReadonlySet<string>): { id: string; status: string }[] {
  return rows
    .filter((row) => row.needsAttention && (RESERVATION_ATTENTION_STATUSES as readonly string[]).includes(row.status) && !alreadySent.has(viewKey(row)))
    .map((row) => ({ id: row.id, status: row.status }));
}

export const viewKey = (row: { id: string; status: string }): string => `${row.id}@${row.status}`;
