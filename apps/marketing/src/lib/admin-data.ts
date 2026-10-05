import 'server-only';
import { pathSegment } from './admin-path';

import { AdminApiError, adminGet, adminPatch, adminPost, adminPut } from './admin-api';
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
  return adminGet(`/admin/calendar?from=${pathSegment(from)}&to=${pathSegment(to)}`, adminUserId);
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
  /** Pedido vinculado excluído na Shopify (a reserva nunca é apagada). */
  readonly shopifyOrderDeletedAt: string | null;
  /** Nova para a equipe: reserva da Shopify pendente ou confirmada ainda não vista neste status. */
  readonly needsAttention: boolean;
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
  /** "Mostrar excluídos da Shopify". */
  shopifyDeletedOnly?: boolean;
}

export function listReservations(adminUserId: string, filters: ReservationFilters): Promise<ReservationListItem[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, String(value));
  }
  const qs = params.toString();
  return adminGet(`/admin/reservations${qs ? `?${qs}` : ''}`, adminUserId);
}

/** Contador do menu: novas reservas de aluguel da Shopify (global para a equipe). */
export function getReservationAttention(adminUserId: string): Promise<{ count: number }> {
  return adminGet('/admin/reservations/attention', adminUserId);
}

/** Sem `adminUserId` no corpo: quem viu vem da sessão validada. Só visualização. */
export function markReservationsViewed(reservations: readonly { id: string; status: string }[]): Promise<{ marked: number }> {
  return adminPost('/admin/reservations/viewed', { reservations });
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
  return adminGet(`/admin/reservations/${pathSegment(id)}`, adminUserId);
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
  return adminPost(`/admin/reservations/${pathSegment(id)}/cancel`, { reason });
}

const ITEM_ACTIONS = ['receive', 'start-cleaning', 'complete-cleaning'] as const;

export function advanceReservationItem(id: string, itemId: string, action: (typeof ITEM_ACTIONS)[number], note?: string) {
  // `action` chega de server action (valor do navegador): o tipo não vale em
  // tempo de execução, então só as três ações conhecidas viram caminho.
  if (!ITEM_ACTIONS.includes(action)) return Promise.reject(new AdminApiError(400, 'Ação inválida.'));
  return adminPost<{ reservationId: string; reservationItemId: string; reservationStatus: string; itemStatus: string }>(
    `/admin/reservations/${pathSegment(id)}/items/${pathSegment(itemId)}/${action}`,
    { note },
  );
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
  /// Presente = a sincronização de catálogo arquivou esta peça (variante
  /// removida, produto DRAFT/ARCHIVED ou sem variante — ver docs/shopify-catalog-sync.md).
  readonly shopifyVariantMissingAt: string | null;
}

/** Lista principal (sem arquivadas); `archived: true` = só as arquivadas pela sincronização. */
export function listPieces(adminUserId: string, options: { archived?: boolean } = {}): Promise<PieceListItem[]> {
  return adminGet(`/admin/pieces${options.archived ? '?archived=true' : ''}`, adminUserId);
}

export function updatePiece(
  id: string,
  input: { active?: boolean; reservableOnline?: boolean; countsTowardRentalDuration?: boolean; reason?: string },
  adminUserId: string,
): Promise<PieceListItem> {
  return adminPatch(`/admin/pieces/${pathSegment(id)}`, { ...input, adminUserId });
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
  /** YYYY-MM-DD — primeira retirada aceita; null = sem restrição. */
  readonly operationStartDate: string | null;
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
  /** Desativado continua listado e pode ser reativado; removido some da lista. */
  readonly active: boolean;
  readonly createdByAdminUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly removedAt: string | null;
}

export type BlockInput = { scope: 'STORE_WIDE' | 'UNIT'; rentalUnitId?: string; startDate: string; endDate: string; reason: string };

/** `activeOnly` (nome da API) = esconder removidos; desativados continuam na lista. */
export function listBlocks(adminUserId: string, activeOnly = true): Promise<BlockItem[]> {
  return adminGet(`/admin/blocks?activeOnly=${activeOnly}`, adminUserId);
}

export function createBlock(input: BlockInput, adminUserId: string): Promise<BlockItem> {
  return adminPost('/admin/blocks', { ...input, adminUserId });
}

export function updateBlock(id: string, input: Partial<BlockInput>, adminUserId: string): Promise<BlockItem> {
  return adminPatch(`/admin/blocks/${pathSegment(id)}`, { ...input, adminUserId });
}

export function setBlockActive(id: string, active: boolean, adminUserId: string): Promise<BlockItem> {
  return adminPost(`/admin/blocks/${pathSegment(id)}/${active ? 'activate' : 'deactivate'}`, { adminUserId });
}

export function removeBlock(id: string, adminUserId: string): Promise<BlockItem> {
  return adminPost(`/admin/blocks/${pathSegment(id)}/remove`, { adminUserId });
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
  return adminPost(`/admin/reservations-archive/${pathSegment(id)}/restore`, { adminUserId, adminUserName });
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
  return adminPost(`/admin/employees/${pathSegment(id)}/block`, { adminUserId });
}

export function reactivateEmployee(id: string, adminUserId: string): Promise<EmployeeListItem> {
  return adminPost(`/admin/employees/${pathSegment(id)}/reactivate`, { adminUserId });
}

export function removeEmployee(id: string, adminUserId: string): Promise<EmployeeListItem> {
  return adminPost(`/admin/employees/${pathSegment(id)}/remove`, { adminUserId });
}

export function restoreEmployee(id: string, adminUserId: string): Promise<EmployeeListItem> {
  return adminPost(`/admin/employees/${pathSegment(id)}/restore`, { adminUserId });
}

/** "Excluir permanentemente" — DELETE físico real, só quem já foi
 *  removido antes. Backend recusa se ativo, SUPER_ADMIN, ou o próprio
 *  ator. */
export function purgeEmployee(id: string, adminUserId: string): Promise<{ id: string }> {
  return adminPost(`/admin/employees/${pathSegment(id)}/purge`, { adminUserId });
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
  return adminPost(`/admin/vale-pass/campaigns/${pathSegment(id)}/activate`, { adminUserId });
}

export function deactivateValePassCampaign(id: string, adminUserId: string): Promise<ValePassCampaign> {
  return adminPost(`/admin/vale-pass/campaigns/${pathSegment(id)}/deactivate`, { adminUserId });
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

/** Situação do PEDIDO na Shopify (não do vale): todo pedido de Valle Pass
 *  aparece desde a criação, pago ou não. */
export type ValePassOrderStatus = 'PENDING' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED' | 'DECLINED' | 'REFUNDED';

export interface ValePassOrder {
  readonly id: string;
  readonly shopifyOrderId: string;
  readonly shopifyOrderName: string | null;
  readonly status: ValePassOrderStatus;
  readonly financialStatus: string | null;
  readonly cancelReason: string | null;
  readonly quantity: number;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly customerEmail: string | null;
  readonly orderCreatedAt: string | null;
  readonly statusChangedAt: string;
  readonly deletedInShopifyAt: string | null;
  /** Conta no contador do menu: pendente ou pago, ainda não visto neste status. */
  readonly needsAttention: boolean;
  readonly vouchers: readonly { readonly code: string; readonly status: ValePassStatus }[];
}

/** Pedido excluído na Shopify fica fora por padrão; `includeDeleted` = filtro
 *  "Mostrar excluídos da Shopify". */
export function listValePassOrders(adminUserId: string, options: { status?: ValePassOrderStatus; includeDeleted?: boolean } = {}): Promise<ValePassOrder[]> {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.includeDeleted) params.set('includeDeleted', 'true');
  const query = params.toString();
  return adminGet(`/admin/vale-pass/orders${query ? `?${query}` : ''}`, adminUserId);
}

/** Contador do menu lateral (global para a equipe). */
export function getValePassAttention(adminUserId: string): Promise<{ count: number }> {
  return adminGet('/admin/vale-pass/orders/attention', adminUserId);
}

/** Sem `adminUserId` no corpo: quem viu vem da sessão validada. */
export function markValePassOrdersViewed(orders: readonly { id: string; statusChangedAt: string }[]): Promise<{ marked: number }> {
  return adminPost('/admin/vale-pass/orders/viewed', { orders });
}

export function findValePassVoucherByCode(code: string, adminUserId: string): Promise<ValePassVoucher> {
  return adminGet(`/admin/vale-pass/vouchers/${pathSegment(code)}`, adminUserId);
}

export function markValePassVoucherUsed(code: string, adminUserId: string): Promise<ValePassVoucher> {
  return adminPost(`/admin/vale-pass/vouchers/${pathSegment(code)}/use`, { adminUserId });
}

export function cancelValePassVoucher(code: string, reason: string, adminUserId: string): Promise<ValePassVoucher> {
  return adminPost(`/admin/vale-pass/vouchers/${pathSegment(code)}/cancel`, { reason, adminUserId });
}

/** Sem `adminUserId` no corpo — RestoreValePassDto não aceita esse campo;
 *  identidade só vem da sessão validada (mesmo padrão mais novo já usado
 *  em outras ações administrativas deste projeto). */
export function restoreValePassVoucher(code: string, reason: string): Promise<ValePassVoucher> {
  return adminPost(`/admin/vale-pass/vouchers/${pathSegment(code)}/restore`, { reason });
}

export function updateEmployeePermissions(id: string, moduleAccess: AdminModuleName[], adminUserId: string): Promise<EmployeeListItem> {
  return adminPut(`/admin/employees/${pathSegment(id)}/permissions`, { moduleAccess, adminUserId });
}
