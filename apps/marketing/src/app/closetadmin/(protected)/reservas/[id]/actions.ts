'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminSession } from '@/lib/admin-session';
import { cancelManualReservation } from '@/lib/admin-data';
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
  try {
    await cancelManualReservation(reservationId, session.id, session.name, reason || undefined);
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
