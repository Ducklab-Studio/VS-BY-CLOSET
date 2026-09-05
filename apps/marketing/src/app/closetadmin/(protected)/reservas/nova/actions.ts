'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminSession } from '@/lib/admin-session';
import { createManualReservation, type CreateManualReservationInput } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';

export interface CreateManualResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly violations?: string[];
  readonly reservationId?: string;
}

/**
 * Item 6 (fluxo "Nova reserva"). A validação de verdade — engine de
 * duração, temporada, domingo, máximo de peças, double booking, bloqueio
 * operacional — é TODA feita no reservations-api
 * (`AdminReservationsService.createManual`, Fases 8/9); este action só
 * encaminha e traduz o formato de erro (`violations`) pro wizard decidir
 * se mostra um override ou um bloqueio definitivo.
 */
export async function createManualReservationAction(
  input: Omit<CreateManualReservationInput, 'adminUserId' | 'adminUserName'>,
): Promise<CreateManualResult> {
  const session = await requireAdminSession();
  try {
    const result = await createManualReservation({ ...input, adminUserId: session.id, adminUserName: session.name });
    revalidatePath('/closetadmin/reservas');
    revalidatePath('/closetadmin/calendario');
    return { ok: true, reservationId: (result as { reservationId: string }).reservationId };
  } catch (err) {
    if (err instanceof AdminApiError) {
      const body = err.body as { violations?: unknown } | undefined;
      const violations = Array.isArray(body?.violations) ? (body.violations as string[]) : undefined;
      return { ok: false, error: err.message, violations };
    }
    return { ok: false, error: 'Erro inesperado ao criar a reserva.' };
  }
}
