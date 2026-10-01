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

/** Texto para leitor de tela, anexado ao nome do link "Reservas". */
export function reservationAttentionLabel(count: number | null): string {
  if (!count || count <= 0) return 'nenhuma reserva nova';
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
