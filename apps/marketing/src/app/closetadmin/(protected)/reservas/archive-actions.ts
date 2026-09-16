'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminSession, requireAdminRole } from '@/lib/admin-session';
import { executeArchive, restoreReservation, type ArchiveFilters, type ArchiveExecutionResult } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';

/** Precisa bater com CONFIRM_PHRASE em
 *  reservations-api/.../archive-reservations.dto.ts — o botão "Limpar
 *  lista" já pede a confirmação do usuário pelo próprio ConfirmDialog
 *  (ver ClearListButton.tsx), então preenche a frase fixa aqui em vez de
 *  fazer a pessoa digitá-la de novo. */
const CLEAR_LIST_CONFIRM_PHRASE = 'LIMPAR HISTÓRICOS';
const CLEAR_LIST_STATUSES: ArchiveFilters['statuses'] = ['expired', 'cancelled'];
const CLEAR_LIST_REASON = 'Limpar lista (ClosetAdmin) — reservas expiradas/canceladas antigas';

function revalidateReservationPaths() {
  revalidatePath('/closetadmin/reservas');
  revalidatePath('/closetadmin');
  revalidatePath('/closetadmin/calendario');
  revalidatePath('/closetadmin/auditoria');
}

/**
 * "Limpar lista" — versão enxuta do arquivamento acima, fixada em
 * `expired`/`cancelled` (nunca `returned`/`completed`, nunca ativas nem
 * aguardando pagamento — a allowlist de ARCHIVABLE_TERMINAL_STATUSES e o
 * período mínimo de segurança do próprio ReservationArchiveService
 * continuam sendo a garantia real, não esta tela). Nunca apaga nem muda
 * status — só marca `archivedAt` (ver ReservationArchiveService.execute).
 */
export async function clearOldReservationsAction(): Promise<{ result: ArchiveExecutionResult | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'ADMIN');
  try {
    const result = await executeArchive(
      { statuses: CLEAR_LIST_STATUSES },
      CLEAR_LIST_CONFIRM_PHRASE,
      CLEAR_LIST_REASON,
      session.id,
      session.name,
    );
    revalidateReservationPaths();
    return { result, error: null };
  } catch (err) {
    return { result: null, error: err instanceof AdminApiError ? err.message : 'Não foi possível ocultar as reservas.' };
  }
}

/**
 * "Restaurar lista" — desfaz um "Limpar lista" anterior, restaurando
 * exatamente o conjunto de ids que aquela execução arquivou (guardado no
 * estado do ClearListButton, nunca recalculado). Cada restauração
 * individual usa o mesmo `ReservationArchiveService.restore` já usado
 * pelo botão "Restaurar reserva" da tela de detalhe — nunca reativa
 * HOLD/pagamento, só limpa os 3 campos de arquivamento.
 */
export async function restoreManyAction(reservationIds: readonly string[]): Promise<{ restoredCount: number; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'ADMIN');

  const outcomes = await Promise.allSettled(reservationIds.map((id) => restoreReservation(id, session.id, session.name)));
  const restoredCount = outcomes.filter((o) => o.status === 'fulfilled').length;

  if (restoredCount > 0) revalidateReservationPaths();

  if (restoredCount === 0 && reservationIds.length > 0) {
    return { restoredCount: 0, error: 'Não foi possível restaurar a lista.' };
  }
  return { restoredCount, error: null };
}
