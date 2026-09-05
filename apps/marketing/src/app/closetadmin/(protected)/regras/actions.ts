'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminSession, requireAdminRole } from '@/lib/admin-session';
import { createBlock, removeBlock, updateRules, type RentalRuleConfig } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';

/** Item 12 — "Somente ADMIN pode alterar regras." `RentalPlanEngine`
 *  continua sendo a autoridade que INTERPRETA estes números; este action
 *  só grava o que o formulário editou. */
export async function updateRulesAction(input: Partial<Omit<RentalRuleConfig, 'id'>>): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'ADMIN');

  try {
    await updateRules(input, session.id);
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível atualizar as regras.' };
  }
  revalidatePath('/closetadmin/regras');
  return { error: null };
}

/** Item 13 — bloqueios operacionais. Sempre exige `reason` (formulário
 *  já valida antes de chamar), nunca aplicado silenciosamente. */
export async function createBlockAction(input: {
  scope: 'STORE_WIDE' | 'UNIT';
  rentalUnitId?: string;
  startDate: string;
  endDate: string;
  reason: string;
}): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'ADMIN');

  try {
    await createBlock(input, session.id);
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível criar o bloqueio.' };
  }
  revalidatePath('/closetadmin/regras');
  revalidatePath('/closetadmin/calendario');
  revalidatePath('/closetadmin');
  return { error: null };
}

export async function removeBlockAction(id: string): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'ADMIN');

  try {
    await removeBlock(id, session.id);
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível remover o bloqueio.' };
  }
  revalidatePath('/closetadmin/regras');
  revalidatePath('/closetadmin/calendario');
  revalidatePath('/closetadmin');
  return { error: null };
}
