import { toInspectionBody, type InspectionInput, type ReturnCondition } from './return-inspection';
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

/** "Pagamentos a tratar": pedidos pagos sem reserva válida e reservas em revisão/conflito. Só leitura, sem dados pessoais.
 *  Devolve `unknown` de propósito: quem usa passa por `parsePaymentAlerts` (lib/payment-alerts.ts). */
export function getPaymentAlerts(adminUserId: string): Promise<unknown> {
  return adminGet('/admin/reservations/payment-alerts', adminUserId);
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
  /** Maior atraso (dias) entre as peças ainda não recebidas; 0 = sem atraso. */
  readonly overdueDays: number;
  readonly items: readonly ReservationDetailItem[];
  readonly events: readonly { type: string; detail: unknown; createdAt: string }[];
}

export interface ReservationDetailItem {
  readonly id: string;
  readonly rentalUnitId: string;
  readonly code: string;
  readonly status: string;
  readonly blockedFrom: string;
  readonly blockedUntilExclusive: string;
  readonly returnedAt: string | null;
  readonly cleaningStartedAt: string | null;
  readonly cleaningCompletedAt: string | null;
  readonly overdueDays: number;
  readonly inspection: {
    readonly condition: ReturnCondition;
    readonly notes: string | null;
    readonly receivedAt: string;
    readonly receivedByName: string;
    readonly daysLate: number;
    readonly awaitingRelease: boolean;
    readonly releasedAt: string | null;
    readonly releasedByName: string | null;
    readonly releaseNote: string | null;
  } | null;
  readonly occurrences: readonly {
    id: string;
    kind: 'not_returned' | 'note';
    notes: string;
    recordedAt: string;
    recordedByName: string;
  }[];
  /** Esta peça está retida (manutenção/avaria) em OUTRA reserva e esta ainda não foi retirada. */
  readonly unitHold: {
    readonly reservationId: string;
    readonly condition: 'needs_maintenance' | 'damaged';
    readonly heldSince: string;
  } | null;
}

/**
 * Painel e API publicam em momentos diferentes (Vercel × Railway). Durante essa janela
 * o painel novo pode falar com a API anterior, que ainda não envia atraso, conferência
 * e ocorrências: campos ausentes viram "sem atraso / sem conferência / sem ocorrências"
 * em vez de derrubar a tela. Nada é inventado: ausente nunca vira "devolvida" nem "liberada".
 */
export function withReturnDefaults(raw: ReservationDetail): ReservationDetail {
  return {
    ...raw,
    overdueDays: raw.overdueDays ?? 0,
    items: (raw.items ?? []).map((item) => ({
      ...item,
      overdueDays: item.overdueDays ?? 0,
      inspection: item.inspection ?? null,
      occurrences: item.occurrences ?? [],
      unitHold: item.unitHold ?? null,
    })),
  };
}

/** Peças retidas por manutenção/avaria com reserva futura. Só leitura; a API exige o módulo Reservas. */
export function getHeldPieceAlerts(adminUserId: string): Promise<unknown> {
  return adminGet('/admin/reservations/held-piece-alerts', adminUserId);
}

export async function getReservationDetail(adminUserId: string, id: string): Promise<ReservationDetail> {
  return withReturnDefaults(await adminGet<ReservationDetail>(`/admin/reservations/${pathSegment(id)}`, adminUserId));
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

// O recebimento NÃO está aqui: exige a conferência da peça (`receiveReservationItem`).
const ITEM_ACTIONS = ['start-cleaning', 'complete-cleaning'] as const;

export function advanceReservationItem(id: string, itemId: string, action: (typeof ITEM_ACTIONS)[number], note?: string) {
  // `action` chega de server action (valor do navegador): o tipo não vale em
  // tempo de execução, então só as ações conhecidas viram caminho.
  if (!ITEM_ACTIONS.includes(action)) return Promise.reject(new AdminApiError(400, 'Ação inválida.'));
  return adminPost<{ reservationId: string; reservationItemId: string; reservationStatus: string; itemStatus: string }>(
    `/admin/reservations/${pathSegment(id)}/items/${pathSegment(itemId)}/${action}`,
    { note },
  );
}

/** Recebimento COM conferência individual da peça. Sem adminUserId: o operador vem da sessão. */
export function receiveReservationItem(id: string, itemId: string, inspection: InspectionInput) {
  return adminPost<{ reservationId: string; reservationItemId: string; reservationStatus: string; itemStatus: string; condition?: string; daysLate?: number; awaitingRelease?: boolean }>(
    `/admin/reservations/${pathSegment(id)}/items/${pathSegment(itemId)}/receive`,
    toInspectionBody(inspection),
  );
}

/** Só ADMIN (a API revalida no banco). */
export function releaseReservationItemHold(id: string, itemId: string, note: string) {
  return adminPost<{ released: true }>(`/admin/reservations/${pathSegment(id)}/items/${pathSegment(itemId)}/release-hold`, { note });
}

export function recordReservationItemOccurrence(id: string, itemId: string, kind: 'not_returned' | 'note', notes: string) {
  return adminPost<{ occurrenceId: string; kind: string }>(`/admin/reservations/${pathSegment(id)}/items/${pathSegment(itemId)}/occurrences`, { kind, notes });
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
  /** Limite LEGADO: hoje bloqueia a emissão do vale (o pedido pago fica sem vale). Não é o limite global. */
  readonly quantityLimit: number | null;
  /** Limite GLOBAL de passes, somando todos os lotes. */
  readonly globalLimit: number | null;
  /** Validade fixa dos vouchers ("YYYY-MM-DD"); as duas datas ou nenhuma. */
  readonly voucherValidFrom: string | null;
  readonly voucherValidUntil: string | null;
  /** Encerramento das vendas — informativo, sem encerramento automático. */
  readonly salesEndDate: string | null;
  readonly shopifyVariantId: string;
  readonly active: boolean;
  readonly soldCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Edição parcial: campo ausente não muda; `null` limpa (onde o campo aceita vazio). */
export interface UpdateValePassCampaignInput {
  expectedUpdatedAt: string;
  name?: string;
  amountCents?: number;
  validityDays?: number;
  quantityLimit?: number | null;
  globalLimit?: number | null;
  voucherValidFrom?: string | null;
  voucherValidUntil?: string | null;
  salesEndDate?: string | null;
}

export function updateValePassCampaign(id: string, input: UpdateValePassCampaignInput, adminUserId: string): Promise<ValePassCampaign> {
  return adminPatch(`/admin/vale-pass/campaigns/${pathSegment(id)}`, { ...input, adminUserId });
}

export type ValePassLotStatus = 'PLANNED' | 'OPEN' | 'CLOSED' | 'CANCELLED';

export interface ValePassLot {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  readonly status: ValePassLotStatus;
  readonly openedAt: string | null;
  readonly closedAt: string | null;
  /** Versão do lote: devolvida em toda ação (concorrência otimista). */
  readonly updatedAt: string;
  readonly sold: number;
  /** Unidades pagas aguardando emissão cobradas deste lote (só o lote aberto). */
  readonly pending: number;
  readonly remaining: number;
  readonly soldOut: boolean;
}

export interface ValePassCapacityAlert {
  readonly code: string;
  readonly severity: 'critical' | 'warning' | 'info';
  readonly message: string;
}

export interface ValePassPaidOrderShortfall {
  readonly orderId: string;
  readonly orderName: string | null;
  readonly quantity: number;
  readonly issued: number;
  readonly missing: number;
}

export interface ValePassCapacity {
  readonly campaign: {
    readonly id: string;
    readonly name: string;
    readonly active: boolean;
    readonly globalLimit: number | null;
    readonly legacyQuantityLimit: number | null;
    readonly salesEndDate: string | null;
    readonly updatedAt: string;
  };
  readonly totals: {
    readonly issued: number;
    readonly cancelled: number;
    readonly sold: number;
    /** Unidades de pedidos pagos ainda sem emissão completa: já consomem capacidade. */
    readonly pending: number;
    /** `sold + pending`: o que o limite global compara. */
    readonly consumed: number;
    readonly active: number;
    readonly used: number;
    readonly expired: number;
  };
  readonly globalRemaining: number | null;
  readonly openLot: ValePassLot | null;
  readonly lots: readonly ValePassLot[];
  /** Estoque que a Shopify deveria ter para refletir o painel — só informativo; nada é alterado na Shopify. */
  readonly recommendedShopifyStock: number;
  readonly paidOrdersWithoutVoucher: readonly ValePassPaidOrderShortfall[];
  /** Pagamentos confirmados que a emissão automática não atendeu: aguardam um ADMIN. */
  readonly holds: readonly ValePassCapacityHold[];
  /** Reembolsos que o tratamento por unidade não resolveu sozinho: aguardam um ADMIN. */
  readonly refundReviews?: readonly ValePassCapacityRefundReview[];
  readonly benefits: readonly ValePassCapacityBenefit[];
  readonly alerts: readonly ValePassCapacityAlert[];
}

export interface ValePassCapacityRefundReview {
  readonly id: string;
  readonly shopifyOrderName: string | null;
  readonly refundedUnits: number;
  readonly unitsNeedingReview: number;
  readonly reasons: readonly string[];
  readonly createdAt: string;
}

export type ValePassRefundReviewAction = 'KEEP_VOUCHERS' | 'CANCEL_ACTIVE_VOUCHERS';

/** Decisão do ADMIN sobre um reembolso em revisão (voucher já usado nunca é alterado pela API). */
export function resolveValePassRefundReview(id: string, input: { action: ValePassRefundReviewAction; note: string }, adminUserId: string): Promise<unknown> {
  return adminPost(`/admin/vale-pass/refund-reviews/${pathSegment(id)}/resolve`, { ...input, adminUserId });
}

export type ValePassCompany = 'VALLE_SHOWROOM' | 'VS_BY_CLOSET';

export interface ValePassCapacityHold {
  readonly id: string;
  readonly shopifyOrderId: string;
  readonly shopifyOrderName: string | null;
  readonly units: number;
  readonly reason: 'CAPACITY_EXCEEDED' | 'CAMPAIGN_NOT_READY' | 'FINANCIAL_MISMATCH';
  /** Códigos das divergências financeiras (só em FINANCIAL_MISMATCH). */
  readonly issues: readonly string[];
  readonly createdAt: string;
}

export interface ValePassCapacityBenefit {
  readonly code: string;
  readonly kind: 'VOUCHER' | 'DISCOUNT';
  readonly company: ValePassCompany | null;
  readonly label: string;
  readonly amountCents: number | null;
  readonly discountPercent: number | null;
  readonly terms: string | null;
  readonly active: boolean;
  readonly vouchersIssued: number;
}

export interface ValePassBenefitInput {
  readonly code: string;
  readonly kind: 'VOUCHER' | 'DISCOUNT';
  readonly company?: ValePassCompany | null;
  readonly label: string;
  readonly amountCents?: number | null;
  readonly discountPercent?: number | null;
  readonly terms?: string | null;
  readonly active?: boolean;
  readonly sortOrder?: number;
}

export function replaceValePassBenefits(campaignId: string, benefits: readonly ValePassBenefitInput[], adminUserId: string): Promise<unknown> {
  return adminPut(`/admin/vale-pass/campaigns/${pathSegment(campaignId)}/benefits`, { benefits, adminUserId });
}

export interface ValePassHold {
  readonly id: string;
  readonly status: 'OPEN' | 'ISSUED' | 'DISMISSED';
  readonly issuedUnits: number | null;
  readonly resolutionNote: string | null;
}

/** Descartar uma retenção cujo pedido deixou de estar pago. */
export function dismissValePassHold(holdId: string, note: string, adminUserId: string): Promise<ValePassHold> {
  return adminPost(`/admin/vale-pass/holds/${pathSegment(holdId)}/dismiss`, { note, adminUserId });
}

/** Retrato da emissão excepcional: o que a tela de confirmação mostra. O servidor recalcula tudo na hora de emitir. */
export interface ValePassHoldProjection {
  readonly holdId: string;
  readonly campaignName: string;
  readonly orderName: string | null;
  readonly orderStatus: string | null;
  readonly units: number;
  readonly reason: 'CAPACITY_EXCEEDED' | 'CAMPAIGN_NOT_READY' | 'FINANCIAL_MISMATCH';
  readonly globalLimit: number | null;
  readonly soldBefore: number;
  readonly pendingBefore: number;
  readonly consumedBefore: number;
  readonly soldAfter: number;
  readonly pendingAfter: number;
  readonly projectedTotal: number;
  readonly exceedsLimit: boolean;
  readonly exceededBy: number;
  readonly holdUpdatedAt: string;
  readonly canIssue: boolean;
  readonly blockedReason: string | null;
}

export function getValePassHoldPreview(holdId: string, adminUserId: string): Promise<ValePassHoldProjection> {
  return adminGet(`/admin/vale-pass/holds/${pathSegment(holdId)}/preview`, adminUserId);
}

export interface IssueValePassHoldInput {
  readonly note: string;
  readonly confirmTotal: number;
  readonly expected: { readonly projectedTotal: number; readonly consumedTotal: number; readonly globalLimit: number | null; readonly holdUpdatedAt: string };
}

export function issueValePassHold(holdId: string, input: IssueValePassHoldInput, adminUserId: string): Promise<ValePassHold> {
  return adminPost(`/admin/vale-pass/holds/${pathSegment(holdId)}/issue`, { ...input, adminUserId });
}

export function getValePassCapacity(campaignId: string, adminUserId: string): Promise<ValePassCapacity> {
  return adminGet(`/admin/vale-pass/campaigns/${pathSegment(campaignId)}/capacity`, adminUserId);
}

export function createValePassLot(campaignId: string, input: { name: string; quantity: number }, adminUserId: string): Promise<ValePassLot> {
  return adminPost(`/admin/vale-pass/campaigns/${pathSegment(campaignId)}/lots`, { ...input, adminUserId });
}

export function updateValePassLot(campaignId: string, lotId: string, input: { expectedUpdatedAt: string; name?: string; quantity?: number }, adminUserId: string): Promise<ValePassLot> {
  return adminPatch(`/admin/vale-pass/campaigns/${pathSegment(campaignId)}/lots/${pathSegment(lotId)}`, { ...input, adminUserId });
}

export type ValePassLotAction = 'open' | 'close' | 'cancel';

export function actOnValePassLot(campaignId: string, lotId: string, action: ValePassLotAction, expectedUpdatedAt: string, adminUserId: string): Promise<ValePassLot> {
  return adminPost(`/admin/vale-pass/campaigns/${pathSegment(campaignId)}/lots/${pathSegment(lotId)}/${action}`, { expectedUpdatedAt, adminUserId });
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

/** E-mails com os códigos dos vouchers (caixa de saída). Tudo mascarado: o painel nunca recebe e-mail nem código completos. */
export type ValePassEmailStatus = 'QUEUED' | 'SENDING' | 'UNKNOWN' | 'ACCEPTED' | 'DELIVERED' | 'FAILED' | 'NEEDS_ATTENTION' | 'CANCELLED';

export interface ValePassEmailItem {
  readonly id: string;
  readonly orderId: string;
  readonly orderName: string | null;
  readonly kind: 'INITIAL' | 'RESEND';
  readonly status: ValePassEmailStatus;
  readonly toMasked: string;
  readonly codesMasked: readonly string[];
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: string;
  readonly lastError: string | null;
  readonly deadlineAt: string;
  readonly overdue: boolean;
  readonly createdAt: string;
  readonly acceptedAt: string | null;
  readonly deliveredAt: string | null;
  readonly failedAt: string | null;
  readonly resendOfId: string | null;
}

export interface ValePassEmailSummary {
  readonly config: {
    readonly mode: 'off' | 'dry-run' | 'live';
    readonly canSend: boolean;
    readonly blockers: readonly string[];
    readonly providerConfigured: boolean;
    readonly domainVerified: boolean;
    readonly webhookConfigured: boolean;
    readonly dailyLimit: number;
    readonly sender: string | null;
  };
  readonly counts: Readonly<Record<ValePassEmailStatus, number>>;
  readonly overdue: number;
  readonly atRisk: number;
  readonly acceptedLast24h: number;
  readonly dailyLimit: number;
  readonly alerts: readonly { readonly code: string; readonly severity: 'critical' | 'warning' | 'info'; readonly message: string }[];
}

export function getValePassEmailSummary(adminUserId: string): Promise<ValePassEmailSummary> {
  return adminGet('/admin/vale-pass/emails/summary', adminUserId);
}

export function listValePassEmails(adminUserId: string, status?: ValePassEmailStatus): Promise<ValePassEmailItem[]> {
  return adminGet(`/admin/vale-pass/emails${status ? `?status=${encodeURIComponent(status)}` : ''}`, adminUserId);
}

export function listValePassEmailEvents(id: string, adminUserId: string): Promise<{ type: string; detail: unknown; createdAt: string }[]> {
  return adminGet(`/admin/vale-pass/emails/${pathSegment(id)}/events`, adminUserId);
}

export function resendValePassEmail(id: string, input: { note: string; toEmail?: string }, adminUserId: string): Promise<{ id: string; status: ValePassEmailStatus; mayDuplicate: boolean }> {
  return adminPost(`/admin/vale-pass/emails/${pathSegment(id)}/resend`, { ...input, adminUserId });
}

export type ValePassStatus = 'ACTIVE' | 'USED' | 'EXPIRED' | 'CANCELLED';

export interface ValePassVoucher {
  readonly id: string;
  readonly code: string;
  readonly campaignId: string;
  readonly campaignName: string;
  readonly amountCents: number;
  readonly status: ValePassStatus;
  /** Empresa onde ESTE voucher vale (crédito exclusivo). `null` = voucher legado. */
  readonly company: ValePassCompany | null;
  /** Vouchers com o mesmo `groupId` são da mesma unidade comercial (um Valle Pass). */
  readonly groupId: string | null;
  readonly benefitLabel: string | null;
  readonly purchasedAt: string;
  /** Primeiro instante de uso; `null` = vale desde a emissão. */
  readonly validFrom: string | null;
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
