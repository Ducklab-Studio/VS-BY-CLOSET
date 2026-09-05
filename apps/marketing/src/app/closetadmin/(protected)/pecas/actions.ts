'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminSession, requireAdminRole } from '@/lib/admin-session';
import { updatePiece } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';

/** Item 11 — só campos operacionais, e só ADMIN ("gestão operacional de
 *  RentalUnits" no RBAC da Fase 9). `requireAdminRole` redireciona STAFF;
 *  o `AdminRoleGuard` do reservations-api recusa de qualquer forma. */
export async function updatePieceAction(
  id: string,
  input: { active?: boolean; reservableOnline?: boolean; countsTowardRentalDuration?: boolean },
): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'ADMIN');

  try {
    await updatePiece(id, input, session.id);
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível atualizar a peça.' };
  }
  revalidatePath('/closetadmin/pecas');
  return { error: null };
}
