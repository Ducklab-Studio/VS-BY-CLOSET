'use server';

import { getAdminSession, hasAdminModule } from '@/lib/admin-session';
import { getPaymentAlerts, getReservationAttention, markReservationsViewed } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { RESERVATION_ATTENTION_STATUSES } from '@/lib/reservation-attention';
import { parsePaymentAlerts } from '@/lib/payment-alerts';

/**
 * Contador de novas reservas no menu (mesmo contrato do Valle Pass): nunca
 * redireciona — sem sessão ou sem o módulo RESERVATIONS responde
 * `forbidden` e o menu para de perguntar.
 *
 * O número inclui os "pagamentos a tratar" (`alerts`, parte do `count`). Reservas novas
 * (pendentes/confirmadas) e alertas são conjuntos disjuntos por construção — status e
 * pedidos diferentes —, então a soma não conta nada duas vezes. Se a consulta de alertas
 * falhar (ou a API ainda não tiver a rota), o menu segue só com as reservas novas.
 */
export async function getReservationAttentionAction(): Promise<{ count: number; alerts?: number } | { forbidden: true } | { error: true }> {
  const session = await getAdminSession();
  if (!session || !hasAdminModule(session, 'RESERVATIONS')) return { forbidden: true };
  try {
    const base = (await getReservationAttention(session.id)).count;
    let alerts = 0;
    try {
      alerts = parsePaymentAlerts(await getPaymentAlerts(session.id))?.count ?? 0;
    } catch {
      alerts = 0;
    }
    return alerts > 0 ? { count: base + alerts, alerts } : { count: base };
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
