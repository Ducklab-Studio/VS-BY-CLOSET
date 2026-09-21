'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminModule, requireAdminRole, requireAdminSession } from '@/lib/admin-session';
import { advanceReservationItem, cancelManualReservation, restoreReservation } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';

/**
 * Item 8 — cancelamento manual só quando o state machine permite E a
 * reserva é `source = manual_admin` (o próprio reservations-api recusa
 * com 409 se for `online` — ver AdminReservationsService.cancelManual,
 * Fase 8, item 5). Sessão revalidada aqui de novo: nunca confia num
 * `adminUserId` vindo do cliente.
 */
export async function cancelReservationAction(reservationId: string, reason: string): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'RESERVATIONS');
  try {
    await cancelManualReservation(reservationId, reason || undefined);
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível cancelar a reserva.' };
  }

  revalidatePath(`/closetadmin/reservas/${reservationId}`);
  revalidatePath('/closetadmin');
  revalidatePath('/closetadmin/reservas');
  revalidatePath('/closetadmin/calendario');
  revalidatePath('/closetadmin/pecas');
  revalidatePath('/closetadmin/auditoria');
  return { error: null };
}

export async function operationalReservationAction(
  reservationId: string,
  reservationItemId: string,
  action: 'receive' | 'start-cleaning' | 'complete-cleaning',
): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'RESERVATIONS');
  try {
    await advanceReservationItem(reservationId, reservationItemId, action);
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível atualizar a reserva.' };
  }
  for (const path of [
    `/closetadmin/reservas/${reservationId}`, '/closetadmin/reservas',
    '/closetadmin/calendario', '/closetadmin/pecas', '/closetadmin/auditoria',
  ]) revalidatePath(path);
  return { error: null };
}

/**
 * "Limpar históricos" — restaurar é exclusivo de ADMIN (mesma regra do
 * arquivamento). Só limpa `archivedAt`/`archivedBy`/`archiveReason` —
 * nunca reativa HOLD, reabre pagamento ou muda status comercial (ver
 * ReservationArchiveService.restore).
 */
export async function restoreReservationAction(reservationId: string): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'ADMIN');
  try {
    await restoreReservation(reservationId, session.id, session.name);
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível restaurar a reserva.' };
  }

  revalidatePath(`/closetadmin/reservas/${reservationId}`);
  revalidatePath('/closetadmin/reservas');
  revalidatePath('/closetadmin/auditoria');
  return { error: null };
}
