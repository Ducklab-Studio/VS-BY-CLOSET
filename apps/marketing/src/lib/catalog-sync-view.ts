/**
 * Lógica de apresentação do painel "Sincronização com a Shopify" (ClosetAdmin > Peças).
 * Arquivo puro (sem imports) para test/catalog-sync-view.test.mjs. Nada aqui muda a
 * reconciliação: só descreve o que o relatório já traz.
 */

export interface SyncReportLike {
  readonly generatedAt: string;
  readonly lastSyncedAt: string | null;
  readonly lastSyncedByName: string | null;
  readonly totalShopifyVariants: number;
  readonly totalRentalUnitsLinked: number;
  readonly divergences: readonly { readonly applied: boolean }[];
}

export interface CatalogItemLike {
  readonly id: string;
  readonly title: string;
  readonly product: { readonly id: string; readonly title: string; readonly status: string };
  readonly physicalUnitsTotal: number;
}

export type LastSyncOrigin = 'never' | 'manual' | 'automatic';

/**
 * Quem fez a última sincronização. Manual grava o nome de quem clicou; webhook de produto
 * e agendador gravam sem nome. Sem `lastSyncedAt` nunca houve sincronização.
 */
export function describeLastSyncOrigin(report: Pick<SyncReportLike, 'lastSyncedAt' | 'lastSyncedByName'>): { origin: LastSyncOrigin; label: string } {
  if (!report.lastSyncedAt) return { origin: 'never', label: 'nunca sincronizado' };
  const name = report.lastSyncedByName?.trim();
  if (name) return { origin: 'manual', label: `manual, por ${name}` };
  return { origin: 'automatic', label: 'automática (webhook da Shopify ou rotina periódica)' };
}

/** Peças que a rodada realmente alterou (desativadas, reativadas, SKU/código ajustados). */
export function appliedChanges(report: Pick<SyncReportLike, 'divergences'>): number {
  return report.divergences.filter((d) => d.applied).length;
}

/** Divergências que ainda esperam ação (relatório sem aplicar, ou itens que não foram aplicados). */
export function pendingChanges(report: Pick<SyncReportLike, 'divergences'>): number {
  return report.divergences.filter((d) => !d.applied).length;
}

export interface SyncSuccessSummary {
  readonly variantsChecked: number;
  readonly updatedUnits: number;
  readonly pendingUnits: number;
  readonly text: string;
}

export function summarizeSync(report: SyncReportLike, atLabel: string): SyncSuccessSummary {
  const variantsChecked = report.totalShopifyVariants;
  const updatedUnits = appliedChanges(report);
  const pendingUnits = pendingChanges(report);
  const variants = `${variantsChecked} variante${variantsChecked === 1 ? '' : 's'} verificada${variantsChecked === 1 ? '' : 's'}`;
  const updated =
    updatedUnits === 0 ? 'nenhuma peça precisou de atualização' : `${updatedUnits} peça${updatedUnits === 1 ? '' : 's'} atualizada${updatedUnits === 1 ? '' : 's'}`;
  const pending = pendingUnits > 0 ? `; ${pendingUnits} item(ns) ainda pedem atenção` : '';
  return { variantsChecked, updatedUnits, pendingUnits, text: `Sincronização concluída às ${atLabel}: ${variants}, ${updated}${pending}.` };
}

/**
 * Variantes de produtos ATIVOS na Shopify que ainda não têm nenhuma peça física. NÃO são
 * divergência (o produto aparece na vitrine como indisponível até o inventário existir) e o
 * estoque da Shopify não conta. Valle Pass (compra direta) nunca precisa de peça.
 */
export function awaitingPhysicalInventory<T extends CatalogItemLike>(
  items: readonly T[] | null | undefined,
  isDirectPurchase: (item: T) => boolean,
): T[] {
  if (!items) return [];
  return items.filter((item) => item.product.status.trim().toUpperCase() === 'ACTIVE' && item.physicalUnitsTotal === 0 && !isDirectPurchase(item));
}

/** "Produto — variante" (variante padrão da Shopify não vira rótulo). */
export function awaitingLabel(item: CatalogItemLike): string {
  const variant = item.title && item.title.trim().toLowerCase() !== 'default title' ? ` — ${item.title}` : '';
  return `${item.product.title}${variant}`;
}

export type SyncFailureKind = 'error' | 'uncertain';

export const UNCERTAIN_MESSAGE =
  'A resposta demorou mais que o esperado. A sincronização pode ter sido concluída no servidor: vamos conferir o estado atual.';

/** Falha do servidor com resposta de erro (`error`) ou sem resposta/timeout (`uncertain`: pode ter concluído). */
export function classifySyncFailure(result: { error: string | null; timedOut?: boolean }): SyncFailureKind {
  return result.timedOut ? 'uncertain' : 'error';
}

/**
 * Depois de um timeout (ou erro de rede), a sincronização "parece concluída" se o relatório
 * relido tem uma data NOVA, feita por uma pessoa (manual) e recente. Uma rodada automática no
 * mesmo intervalo (webhook/rotina) NÃO conta como prova do clique.
 */
export function looksCompletedAfterUncertain(
  before: Pick<SyncReportLike, 'lastSyncedAt'> | null,
  after: Pick<SyncReportLike, 'lastSyncedAt' | 'lastSyncedByName'>,
  startedAtMs: number,
  skewToleranceMs = 120_000,
): boolean {
  if (!after.lastSyncedAt || !after.lastSyncedByName?.trim()) return false;
  if (before && before.lastSyncedAt === after.lastSyncedAt) return false;
  const at = Date.parse(after.lastSyncedAt);
  return Number.isFinite(at) && at >= startedAtMs - skewToleranceMs;
}
