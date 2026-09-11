'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminSession, requireAdminRole } from '@/lib/admin-session';
import { previewArchive, executeArchive, type ArchiveFilters, type ArchivePreviewResult, type ArchiveExecutionResult } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';

/**
 * "Limpar históricos" — item 15 do padrão já seguido no resto do
 * ClosetAdmin: a tela pode até esconder o botão pra STAFF, mas quem
 * garante de verdade é sempre o servidor. `requireAdminRole` aqui é só
 * a mesma cortesia de UX que as outras páginas exclusivas de ADMIN já
 * fazem (evita a viagem de rede pra quem não pode usar) — o
 * reservations-api recusa de qualquer jeito via `@RequireRole('ADMIN')`.
 */
export async function previewArchiveAction(filters: ArchiveFilters): Promise<{ result: ArchivePreviewResult | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'ADMIN');
  try {
    const result = await previewArchive(session.id, filters);
    return { result, error: null };
  } catch (err) {
    return { result: null, error: err instanceof AdminApiError ? err.message : 'Não foi possível calcular a prévia.' };
  }
}

export async function executeArchiveAction(
  filters: ArchiveFilters,
  confirmPhrase: string,
  reason: string,
): Promise<{ result: ArchiveExecutionResult | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'ADMIN');
  try {
    const result = await executeArchive(filters, confirmPhrase, reason, session.id, session.name);
    revalidatePath('/closetadmin/reservas');
    revalidatePath('/closetadmin');
    revalidatePath('/closetadmin/calendario');
    revalidatePath('/closetadmin/auditoria');
    return { result, error: null };
  } catch (err) {
    return { result: null, error: err instanceof AdminApiError ? err.message : 'Não foi possível concluir o arquivamento.' };
  }
}
