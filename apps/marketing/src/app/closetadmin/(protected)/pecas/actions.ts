'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminSession, requireAdminRole } from '@/lib/admin-session';
import { updatePiece } from '@/lib/admin-data';
import { importShopifyUnits } from '@/lib/shopify-admin-data';
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

  revalidatePieceDependentViews();
  return { error: null };
}

/**
 * Cria apenas as unidades físicas escolhidas pela operação. O estoque da
 * Shopify é exibido como referência, mas nunca é convertido automaticamente
 * em RentalUnits: aluguel precisa de identidade física individual por peça.
 */
export async function importShopifyUnitsAction(
  shopifyVariantId: string,
  rawCodes: string,
  options?: { reservableOnline?: boolean; countsTowardRentalDuration?: boolean },
): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'ADMIN');

  const codes = rawCodes
    .split(/[\n,;]+/)
    .map((code) => code.trim())
    .filter(Boolean);

  if (codes.length === 0) return { error: 'Informe pelo menos um código de peça.' };
  if (codes.length > 50) return { error: 'Cadastre no máximo 50 peças por vez.' };

  try {
    await importShopifyUnits(
      {
        shopifyVariantId,
        codes,
        reservableOnline: options?.reservableOnline,
        countsTowardRentalDuration: options?.countsTowardRentalDuration,
      },
      session.id,
    );
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível cadastrar as peças.' };
  }

  revalidatePieceDependentViews();
  return { error: null };
}

function revalidatePieceDependentViews() {
  revalidatePath('/closetadmin/pecas');
  revalidatePath('/closetadmin');
  revalidatePath('/closetadmin/calendario');
  revalidatePath('/closetadmin/reservas/nova');
}
