'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminModule, requireAdminRole, requireAdminSession } from '@/lib/admin-session';
import {
  advanceReservationItem,
  cancelManualReservation,
  receiveReservationItem,
  recordReservationItemOccurrence,
  releaseReservationItemHold,
  restoreReservation,
} from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { MAX_TEXT, MIN_TEXT, validateInspection, type InspectionInput } from '@/lib/return-inspection';

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

function revalidateOperational(reservationId: string): void {
  for (const path of [
    `/closetadmin/reservas/${reservationId}`, '/closetadmin/reservas',
    '/closetadmin/calendario', '/closetadmin/pecas', '/closetadmin/auditoria',
  ]) revalidatePath(path);
}

export async function operationalReservationAction(
  reservationId: string,
  reservationItemId: string,
  action: 'start-cleaning' | 'complete-cleaning',
): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'RESERVATIONS');
  try {
    await advanceReservationItem(reservationId, reservationItemId, action);
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível atualizar a reserva.' };
  }
  revalidateOperational(reservationId);
  return { error: null };
}

/**
 * Recebimento com conferência individual. O corpo vem do navegador: a condição e a
 * observação são revalidadas aqui e de novo na API; o operador vem da sessão.
 */
export async function receiveItemAction(
  reservationId: string,
  reservationItemId: string,
  inspection: InspectionInput,
): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'RESERVATIONS');
  const invalid = validateInspection(inspection);
  if (invalid) return { error: invalid };
  try {
    await receiveReservationItem(reservationId, reservationItemId, inspection);
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível registrar a devolução.' };
  }
  revalidateOperational(reservationId);
  return { error: null };
}

/** Liberar peça retida (manutenção/avaria): exclusivo de ADMIN, também validado na API. */
export async function releaseHoldAction(
  reservationId: string,
  reservationItemId: string,
  note: string,
): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'RESERVATIONS');
  requireAdminRole(session, 'ADMIN');
  const text = typeof note === 'string' ? note.trim() : '';
  if (text.length < MIN_TEXT || text.length > MAX_TEXT) return { error: 'Informe o motivo da liberação (mínimo 3 caracteres).' };
  try {
    await releaseReservationItemHold(reservationId, reservationItemId, text);
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível liberar a peça.' };
  }
  revalidateOperational(reservationId);
  return { error: null };
}

export async function recordOccurrenceAction(
  reservationId: string,
  reservationItemId: string,
  kind: 'not_returned' | 'note',
  notes: string,
): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'RESERVATIONS');
  if (kind !== 'not_returned' && kind !== 'note') return { error: 'Tipo de ocorrência inválido.' };
  const text = typeof notes === 'string' ? notes.trim() : '';
  if (text.length < MIN_TEXT || text.length > MAX_TEXT) return { error: 'Descreva a ocorrência (mínimo 3 caracteres).' };
  try {
    await recordReservationItemOccurrence(reservationId, reservationItemId, kind, text);
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível registrar a ocorrência.' };
  }
  revalidateOperational(reservationId);
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
