import 'server-only';

import { adminGet, adminPatch, adminPost, adminPut } from './admin-api';
import type { AdminModuleName } from './admin-session';

/** Fase 9 — tipos e chamadas ao reservations-api usadas pelas páginas
 *  Server Component do ClosetAdmin. Espelham exatamente as respostas do
 *  backend (ver apps/reservations-api/src/admin-panel e
 *  admin-reservations) — nenhuma regra de negócio recalculada aqui. */

export interface CalendarItem {
  readonly reservationId: string;
  readonly status: string;
  readonly source: string;
  readonly customerName: string | null;
  readonly rentalUnitId: string;
  readonly rentalUnitCode: string;
  readonly pickupDate: string | null;
  readonly effectiveReturnDate: string | null;
  readonly blockedFrom: string;
  readonly blockedUntilExclusive: string;
}

export function getCalendar(adminUserId: string, from: string, to: string): Promise<CalendarItem[]> {
  return adminGet(`/admin/calendar?from=${from}&to=${to}`, adminUserId);
}

export interface ReservationListItem {
  readonly id: string;
  readonly status: string;
  readonly source: string;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly customerEmail: string | null;
  readonly pickupDate: string | null;
  readonly returnDate: string | null;
  readonly shopifyOrderId: string | null;
  readonly itemCount: number;
  readonly archivedAt: string | null;
}

export interface ReservationFilters {
  status?: string;
  source?: string;
  from?: string;
  to?: string;
  customer?: string;
  phone?: string;
  unitCode?: string;
  code?: string;
  includeArchived?: boolean;
  archivedOnly?: boolean;
}

export function listReservations(adminUserId: string, filters: ReservationFilters): Promise<ReservationListItem[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, String(value));
  }
  const qs = params.toString();
  return adminGet(`/admin/reservations${qs ? `?${qs}` : ''}`, adminUserId);
}

export interface ReservationDetail extends Omit<ReservationListItem, 'itemCount'> {
  readonly shopifyOrderGid: string | null;
  readonly checkoutState: string;
  readonly internalNote: string | null;
  readonly confirmedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedBy: string | null;
  readonly archiveReason: string | null;
  readonly items: readonly {
    id: string;
    rentalUnitId: string;
    code: string;
    status: string;
    blockedFrom: string;
    blockedUntilExclusive: string;
    returnedAt: string | null;
    cleaningStartedAt: string | null;
    cleaningCompletedAt: string | null;
  }[];
  readonly events: readonly { type: string; detail: unknown; createdAt: string }[];
}

export function getReservationDetail(adminUserId: string, id: string): Promise<ReservationDetail> {
  return adminGet(`/admin/reservations/${id}`, adminUserId);
}

export interface CreateManualReservationInput {
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  items: { rentalUnitId: string }[];
  pickupDate: string;
  returnDate?: string;
  durationDays?: number;
  sundayReturnOption?: 'saturday' | 'mondayMorning';
  overrides?: { minLeadTime?: boolean; customDuration?: boolean; outsideOnlineSeason?: boolean };
  overrideReason?: string;
  internalNote?: string;
  adminUserId: string;
  adminUserName: string;
}

export function createManualReservation(input: CreateManualReservationInput) {
  return adminPost('/admin/reservations/manual', input);
}

export function cancelManualReservation(id: string, reason?: string) {
  return adminPost(`/admin/reservations/${id}/cancel`, { reason });
}

export function advanceReservationItem(id: string, itemId: string, action: 'receive' | 'start-cleaning' | 'complete-cleaning', note?: string) {
  return adminPost<{ reservationId: string; reservationItemId: string; reservationStatus: string; itemStatus: string }>(`/admin/reservations/${id}/items/${itemId}/${action}`, { note });
}

export interface PieceListItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly shopifyProductId: string | null;
  readonly shopifyVariantId: string | null;
  readonly shopifySku: string | null;
  readonly active: boolean;
  readonly reservableOnline: boolean;
  readonly countsTowardRentalDuration: boolean;
  readonly currentlyOccupied: boolean;
  readonly upcomingReservations: number;
  /// Presente = a sincronização de catálogo desativou esta peça porque a
  /// variante vinculada não existe mais na Shopify (ver docs/shopify-catalog-sync.md).
  readonly shopifyVariantMissingAt: string | null;
}

export function listPieces(adminUserId: string): Promise<PieceListItem[]> {
  return adminGet('/admin/pieces', adminUserId);
}

export function updatePiece(
  id: string,
  input: { active?: boolean; reservableOnline?: boolean; countsTowardRentalDuration?: boolean },
  adminUserId: string,
): Promise<PieceListItem> {
  return adminPatch(`/admin/pieces/${id}`, { ...input, adminUserId });
}

export interface PiecesToDaysRule {
  readonly upTo: number;
  readonly days: number;
}

export interface RentalRuleConfig {
  readonly id: string;
  readonly minAdvanceDays: number;
  readonly prepDays: number;
  readonly cleaningDays: number;
  readonly blackoutStart: string;
  readonly blackoutEnd: string;
  readonly maxPieces: number;
  readonly piecesToDaysTable: PiecesToDaysRule[];
  readonly timezone: string;
}

export function getRules(adminUserId: string): Promise<RentalRuleConfig> {
  return adminGet(`/admin/rules`, adminUserId);
}

export function updateRules(input: Partial<Omit<RentalRuleConfig, 'id'>>, adminUserId: string): Promise<RentalRuleConfig> {
  return adminPatch('/admin/rules', { ...input, adminUserId });
}

export interface BlockItem {
  readonly id: string;
  readonly scope: 'STORE_WIDE' | 'UNIT';
  readonly rentalUnitId: string | null;
  readonly rentalUnitCode: string | null;
  readonly startDate: string;
  readonly endDate: string;
  readonly reason: string;
  readonly createdByAdminUserId: string;
  readonly createdAt: string;
  readonly removedAt: string | null;
}

export function listBlocks(adminUserId: string, activeOnly = true): Promise<BlockItem[]> {
  return adminGet(`/admin/blocks?activeOnly=${activeOnly}`, adminUserId);
}

export function createBlock(
  input: { scope: 'STORE_WIDE' | 'UNIT'; rentalUnitId?: string; startDate: string; endDate: string; reason: string },
  adminUserId: string,
): Promise<BlockItem> {
  return adminPost('/admin/blocks', { ...input, adminUserId });
}

export function removeBlock(id: string, adminUserId: string): Promise<BlockItem> {
  return adminPost(`/admin/blocks/${id}/remove`, { adminUserId });
}

export interface AuditEntry {
  readonly id: string;
  readonly source: 'PANEL' | 'RESERVATION';
  readonly adminUserId: string | null;
  readonly adminUserName: string | null;
  readonly action: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly detail: unknown;
  readonly createdAt: string;
}

export function listAudit(adminUserId: string, limit = 100): Promise<AuditEntry[]> {
  return adminGet(`/admin/audit?limit=${limit}`, adminUserId);
}

export function clearAudit(adminUserId: string, adminUserName: string): Promise<{ clearedAt: string }> {
  return adminPost('/admin/audit/clear', { adminUserId, adminUserName });
}

/** "Limpar históricos" — arquivamento (soft delete) de reservas em
 *  estado terminal. Ver apps/reservations-api/src/reservation-archive. */
export interface ArchiveFilters {
  status?: 'cancelled' | 'expired' | 'completed';
  /** "Limpar lista" — conjunto explícito de status numa única chamada
   *  (ex.: ['expired', 'cancelled']). Prioridade sobre os demais campos. */
  statuses?: ('cancelled' | 'expired' | 'completed')[];
  source?: string;
  closedBefore?: string;
  minSafetyDays?: number;
  onlyCancelled?: boolean;
  onlyReturned?: boolean;
}

export interface ArchivePreviewRow {
  readonly id: string;
  readonly status: string;
  readonly source: string;
  readonly customerName: string | null;
  readonly pickupDate: string | null;
  readonly returnDate: string | null;
  readonly closureDate: string;
}

export interface ArchivePreviewResult {
  readonly eligibleCount: number;
  readonly protectedActiveCount: number;
  readonly futureCount: number;
  readonly alreadyArchivedCount: number;
  readonly cutoffDate: string;
  readonly minSafetyDays: number;
  readonly statuses: readonly string[];
  readonly sample: readonly ArchivePreviewRow[];
}

export interface ArchiveExecutionResult {
  readonly archivedCount: number;
  readonly ignoredCount: number;
  readonly ignoredReasons: Record<string, number>;
  readonly archivedIds: readonly string[];
  readonly cutoffDate: string;
  readonly minSafetyDays: number;
}

export function previewArchive(adminUserId: string, filters: ArchiveFilters): Promise<ArchivePreviewResult> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return adminGet(`/admin/reservations-archive/preview${qs ? `?${qs}` : ''}`, adminUserId);
}

export function executeArchive(
  filters: ArchiveFilters,
  confirmPhrase: string,
  reason: string,
  adminUserId: string,
  adminUserName: string,
): Promise<ArchiveExecutionResult> {
  return adminPost('/admin/reservations-archive', { ...filters, confirmPhrase, reason, adminUserId, adminUserName });
}

export function restoreReservation(id: string, adminUserId: string, adminUserName: string): Promise<{ reservationId: string; status: string }> {
  return adminPost(`/admin/reservations-archive/${id}/restore`, { adminUserId, adminUserName });
}

/** Sistema de autorização de funcionários — exclusivo de SUPER_ADMIN no
 *  backend (ver AdminEmployeesController). Nunca inclui PIN/hash na
 *  resposta. */
export interface EmployeeListItem {
  readonly id: string;
  readonly name: string;
  readonly phone: string;
  readonly role: 'SUPER_ADMIN' | 'ADMIN' | 'STAFF';
  readonly active: boolean;
  readonly isTechnical: boolean;
  readonly moduleAccess: readonly AdminModuleName[];
  readonly removedAt: string | null;
  readonly createdAt: string;
}

/** `includeRemoved` — "Mostrar removidos", opcional, nunca o padrão. */
export function listEmployees(adminUserId: string, includeRemoved = false): Promise<EmployeeListItem[]> {
  return adminGet(`/admin/employees${includeRemoved ? '?includeRemoved=true' : ''}`, adminUserId);
}

export interface CreateEmployeeInput {
  name: string;
  phone: string;
  pin: string;
  role: 'ADMIN' | 'STAFF';
  moduleAccess: AdminModuleName[];
}

export function createEmployee(input: CreateEmployeeInput, adminUserId: string): Promise<EmployeeListItem> {
  return adminPost('/admin/employees', { ...input, adminUserId });
}

export function blockEmployee(id: string, adminUserId: string): Promise<EmployeeListItem> {
  return adminPost(`/admin/employees/${id}/block`, { adminUserId });
}

export function reactivateEmployee(id: string, adminUserId: string): Promise<EmployeeListItem> {
  return adminPost(`/admin/employees/${id}/reactivate`, { adminUserId });
}

export function removeEmployee(id: string, adminUserId: string): Promise<EmployeeListItem> {
  return adminPost(`/admin/employees/${id}/remove`, { adminUserId });
}

export function restoreEmployee(id: string, adminUserId: string): Promise<EmployeeListItem> {
  return adminPost(`/admin/employees/${id}/restore`, { adminUserId });
}

/** "Excluir permanentemente" — DELETE físico real, só quem já foi
 *  removido antes. Backend recusa se ativo, SUPER_ADMIN, ou o próprio
 *  ator. */
export function purgeEmployee(id: string, adminUserId: string): Promise<{ id: string }> {
  return adminPost(`/admin/employees/${id}/purge`, { adminUserId });
}

/** Valle Pass — vale-presente/crédito de compra, produto TOTALMENTE
 *  separado do fluxo de aluguel (nunca depende de disponibilidade,
 *  HOLD ou datas de retirada/devolução). Vendido pelo checkout oficial
 *  da Shopify; este painel só configura campanha e opera os vales já
 *  emitidos pelo webhook. */
export interface ValePassCampaign {
  readonly id: string;
  readonly name: string;
  readonly amountCents: number;
  readonly validityDays: number;
  readonly quantityLimit: number | null;
  readonly shopifyVariantId: string;
  readonly active: boolean;
  readonly soldCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function listValePassCampaigns(adminUserId: string): Promise<ValePassCampaign[]> {
  return adminGet('/admin/vale-pass/campaigns', adminUserId);
}

export interface CreateValePassCampaignInput {
  name: string;
  amountCents: number;
  validityDays: number;
  quantityLimit?: number;
  shopifyVariantId: string;
}

export function createValePassCampaign(input: CreateValePassCampaignInput, adminUserId: string): Promise<ValePassCampaign> {
  return adminPost('/admin/vale-pass/campaigns', { ...input, adminUserId });
}

export function activateValePassCampaign(id: string, adminUserId: string): Promise<ValePassCampaign> {
  return adminPost(`/admin/vale-pass/campaigns/${id}/activate`, { adminUserId });
}

export function deactivateValePassCampaign(id: string, adminUserId: string): Promise<ValePassCampaign> {
  return adminPost(`/admin/vale-pass/campaigns/${id}/deactivate`, { adminUserId });
}

export type ValePassStatus = 'ACTIVE' | 'USED' | 'EXPIRED' | 'CANCELLED';

export interface ValePassVoucher {
  readonly id: string;
  readonly code: string;
  readonly campaignId: string;
  readonly campaignName: string;
  readonly amountCents: number;
  readonly status: ValePassStatus;
  readonly purchasedAt: string;
  readonly expiresAt: string;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly customerEmail: string | null;
  readonly shopifyOrderId: string | null;
  readonly shopifyOrderName: string | null;
  readonly usedAt: string | null;
  readonly cancelledAt: string | null;
  readonly cancelReason: string | null;
  /** Só tem sentido quando `status === 'CANCELLED'`. O backend já checa
   *  utilização, validade, origem do cancelamento (admin × Shopify) e
   *  conflito com o pedido — a tela só mostra o resultado, nunca decide. */
  readonly canBeRestored: boolean;
  readonly restoreBlockedReason: string | null;
}

export interface ValePassVoucherFilters {
  status?: ValePassStatus;
  campaignId?: string;
  search?: string;
}

export function listValePassVouchers(adminUserId: string, filters: ValePassVoucherFilters): Promise<ValePassVoucher[]> {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.campaignId) params.set('campaignId', filters.campaignId);
  if (filters.search) params.set('search', filters.search);
  const qs = params.toString();
  return adminGet(`/admin/vale-pass/vouchers${qs ? `?${qs}` : ''}`, adminUserId);
}

export function findValePassVoucherByCode(code: string, adminUserId: string): Promise<ValePassVoucher> {
  return adminGet(`/admin/vale-pass/vouchers/${encodeURIComponent(code)}`, adminUserId);
}

export function markValePassVoucherUsed(code: string, adminUserId: string): Promise<ValePassVoucher> {
  return adminPost(`/admin/vale-pass/vouchers/${encodeURIComponent(code)}/use`, { adminUserId });
}

export function cancelValePassVoucher(code: string, reason: string, adminUserId: string): Promise<ValePassVoucher> {
  return adminPost(`/admin/vale-pass/vouchers/${encodeURIComponent(code)}/cancel`, { reason, adminUserId });
}

/** Sem `adminUserId` no corpo — RestoreValePassDto não aceita esse campo;
 *  identidade só vem da sessão validada (mesmo padrão mais novo já usado
 *  em outras ações administrativas deste projeto). */
export function restoreValePassVoucher(code: string, reason: string): Promise<ValePassVoucher> {
  return adminPost(`/admin/vale-pass/vouchers/${encodeURIComponent(code)}/restore`, { reason });
}

export function updateEmployeePermissions(id: string, moduleAccess: AdminModuleName[], adminUserId: string): Promise<EmployeeListItem> {
  return adminPut(`/admin/employees/${id}/permissions`, { moduleAccess, adminUserId });
}
