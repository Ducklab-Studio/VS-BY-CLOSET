import 'server-only';

import { AdminApiError, adminGetPlain } from './admin-api';
import { parseReport, type ReconciliationReport } from './reconciliation-report';

/**
 * Conferência Shopify × reservas — SOMENTE LEITURA. Chama o modo relatório da
 * API (`GET`, sem `apply`); não existe aqui nenhuma chamada que altere dados.
 * O papel ADMIN e o módulo RESERVATIONS são exigidos pela própria API.
 */
export async function getShopifyReconciliation(days: number): Promise<ReconciliationReport> {
  // Sem adminUserId na query: o DTO deste relatório só aceita `days` (ver adminGetPlain).
  const json = await adminGetPlain<unknown>(`/admin/reconciliation/shopify-orders?days=${encodeURIComponent(String(days))}`);
  const report = parseReport(json);
  if (!report) throw new AdminApiError(502, 'A API respondeu num formato inesperado. Atualize a página; se continuar, a versão da API pode estar diferente da do painel.');
  return report;
}
