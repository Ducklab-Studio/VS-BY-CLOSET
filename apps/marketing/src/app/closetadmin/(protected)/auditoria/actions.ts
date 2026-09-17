'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminRole, requireAdminSession } from '@/lib/admin-session';
import { clearAudit } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';

/** "Limpar logs" é exclusivo de SUPER_ADMIN — um funcionário com o
 *  módulo AUDIT concedido não pode esconder eventos do próprio
 *  proprietário (ver AdminAuditController.clear no reservations-api). */
export async function clearAuditAction(): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'SUPER_ADMIN');

  try {
    await clearAudit(session.id, session.name);
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível limpar os logs.' };
  }

  revalidatePath('/closetadmin/auditoria');
  return { error: null };
}
