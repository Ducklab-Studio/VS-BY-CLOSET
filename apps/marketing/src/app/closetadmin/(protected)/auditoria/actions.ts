'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminRole, requireAdminSession } from '@/lib/admin-session';
import { clearAudit } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';

export async function clearAuditAction(): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'ADMIN');

  try {
    await clearAudit(session.id, session.name);
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível limpar os logs.' };
  }

  revalidatePath('/closetadmin/auditoria');
  return { error: null };
}
