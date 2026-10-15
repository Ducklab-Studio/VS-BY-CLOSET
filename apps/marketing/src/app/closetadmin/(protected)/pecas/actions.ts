'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminSession, requireAdminRole, requireAdminModule } from '@/lib/admin-session';
import { updatePiece } from '@/lib/admin-data';
import { importShopifyUnits, syncCatalog, getCatalogReconciliation, type CatalogSyncReport } from '@/lib/shopify-admin-data';
import { AdminApiError } from '@/lib/admin-api';

/** Item 11 — só campos operacionais, e só ADMIN ("gestão operacional de
 *  RentalUnits" no RBAC da Fase 9). `requireAdminRole` redireciona STAFF;
 *  o `AdminRoleGuard` do reservations-api recusa de qualquer forma. */
export async function updatePieceAction(
  id: string,
  input: { active?: boolean; reservableOnline?: boolean; countsTowardRentalDuration?: boolean; reason?: string },
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

/**
 * Item 10 — sincroniza peça física × variante Shopify. Só ADMIN (mesma regra
 * de `updatePieceAction`/`importShopifyUnitsAction` — "gestão operacional de
 * RentalUnits"). Nenhum dado vem do cliente: o servidor decide tudo.
 */
export type SyncCatalogActionResult =
  | { error: null; report: CatalogSyncReport; timedOut: false }
  /** `timedOut`: sem resposta a tempo — a rodada PODE ter concluído no servidor; a tela confere o estado em vez de declarar falha. */
  | { error: string; report: null; timedOut: boolean };

export async function syncCatalogAction(): Promise<SyncCatalogActionResult> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'ADMIN');

  let report: CatalogSyncReport;
  try {
    report = await syncCatalog();
  } catch (err) {
    if (err instanceof AdminApiError && err.status === 504) {
      return {
        error: 'A resposta demorou mais que o esperado. A sincronização pode ter sido concluída no servidor.',
        report: null,
        timedOut: true,
      };
    }
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível sincronizar o catálogo.', report: null, timedOut: false };
  }

  revalidatePieceDependentViews();
  return { error: null, report, timedOut: false };
}

/**
 * Releitura SOMENTE LEITURA do relatório de divergências e da última sincronização. Mesma
 * regra de acesso da página de Peças (módulo PIECES, sem exigir ADMIN); nada é aplicado.
 * Serve ao "Tentar novamente" do relatório inicial e à conferência depois de um timeout.
 */
export async function fetchCatalogSyncReportAction(): Promise<{ error: string | null; report: CatalogSyncReport | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'PIECES');

  try {
    return { error: null, report: await getCatalogReconciliation(session.id) };
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível consultar a sincronização agora.', report: null };
  }
}

function revalidatePieceDependentViews() {
  // Vitrine pública: destaques (home), listagem e página da peça passam a refletir
  // a peça cadastrada/desativada na hora, sem esperar o ciclo de cache.
  revalidatePath('/');
  revalidatePath('/pecas');
  revalidatePath('/pecas/[handle]', 'page');
  revalidatePath('/closetadmin/pecas');
  revalidatePath('/closetadmin');
  revalidatePath('/closetadmin/calendario');
  revalidatePath('/closetadmin/reservas/nova');
  revalidatePath('/closetadmin/auditoria');
}
