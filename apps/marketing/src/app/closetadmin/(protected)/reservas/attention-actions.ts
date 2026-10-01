'use server';

import { getAdminSession, hasAdminModule } from '@/lib/admin-session';
import { getReservationAttention, markReservationsViewed } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { RESERVATION_ATTENTION_STATUSES } from '@/lib/reservation-attention';

/**
 * Contador de novas reservas no menu (mesmo contrato do Valle Pass): nunca
 * redireciona — sem sessão ou sem o módulo RESERVATIONS responde
 * `forbidden` e o menu para de perguntar.
 */
export async function getReservationAttentionAction(): Promise<{ count: number } | { forbidden: true } | { error: true }> {
  const session = await getAdminSession();
  if (!session || !hasAdminModule(session, 'RESERVATIONS')) return { forbidden: true };
  try {
    return { count: (await getReservationAttention(session.id)).count };
  } catch (err) {
    return err instanceof AdminApiError && (err.status === 401 || err.status === 403) ? { forbidden: true } : { error: true };
  }
}

/** A tela de Reservas (lista ou detalhe) marca como vistas as reservas que exibiu. Só visualização. */
export async function markReservationsViewedAction(reservations: readonly { id: string; status: string }[]): Promise<{ marked: number } | { error: true }> {
  const session = await getAdminSession();
  if (!session || !hasAdminModule(session, 'RESERVATIONS')) return { marked: 0 };
  const shown = reservations
    .filter((r) => (RESERVATION_ATTENTION_STATUSES as readonly string[]).includes(r.status))
    .slice(0, 300)
    .map(({ id, status }) => ({ id, status }));
  if (shown.length === 0) return { marked: 0 };
  try {
    return await markReservationsViewed(shown);
  } catch {
    return { error: true };
  }
}
