/**
 * Alertas financeiros do ClosetAdmin (Fase 2a) — regras PURAS, sem banco, sem Shopify.
 *
 * Pergunta que o painel precisa responder: "tem dinheiro recebido que ninguém tratou?". Quatro casos:
 *  - PAID_ORDER_WITHOUT_RESERVATION: pedido pago por cliente (loja virtual ou Headless) sem nenhuma reserva vinculada.
 *  - PAID_ORDER_INACTIVE_RESERVATION: pedido pago cuja reserva vinculada está cancelada, expirada ou ainda em HOLD
 *    (o webhook de pagamento não pôde confirmá-la).
 *  - LATE_PAYMENT_CONFLICT: pagamento chegou depois do prazo e a peça já era de outra reserva.
 *  - RESERVATION_PROBLEM: reserva em revisão manual (`problem`).
 *
 * Um alerta se RESOLVE sozinho quando o pedido é cancelado, reembolsado (total ou parcial) ou excluído na Shopify.
 * Nunca carrega dados pessoais: só número do pedido, valor, tipo, datas e ids internos.
 */

export type PaymentAlertKind =
  | 'LATE_PAYMENT_CONFLICT'
  | 'PAID_ORDER_WITHOUT_RESERVATION'
  | 'PAID_ORDER_INACTIVE_RESERVATION'
  | 'RESERVATION_PROBLEM';

/** Ordem de gravidade (a mais grave primeiro): dinheiro recebido sem peça > pago sem reserva > reserva em revisão. */
const KIND_RANK: Record<PaymentAlertKind, number> = {
  LATE_PAYMENT_CONFLICT: 0,
  PAID_ORDER_WITHOUT_RESERVATION: 1,
  PAID_ORDER_INACTIVE_RESERVATION: 2,
  RESERVATION_PROBLEM: 3,
};

export interface PaymentAlert {
  readonly kind: PaymentAlertKind;
  /** Chave estável e única do alerta (`order:<id>` ou `reservation:<id>`): nunca há dois alertas para a mesma. */
  readonly key: string;
  readonly orderId: string | null;
  readonly orderName: string | null;
  /** Valor como a Shopify devolve ("120.00"), sem conversão. */
  readonly amount: string | null;
  readonly currency: string | null;
  readonly reservationId: string | null;
  readonly reservationStatus: string | null;
  /** ISO-8601 de quando o fato aconteceu (pedido criado / reserva alterada). */
  readonly since: string;
}

export interface PaymentAlertsResult {
  /** Total real (pode ser maior que `alerts.length`, que é limitado). */
  readonly count: number;
  readonly alerts: PaymentAlert[];
}

/** Estado mais recente conhecido de um pedido, extraído dos webhooks `orders/*` (só campos não pessoais). */
export interface OrderState {
  readonly orderId: string;
  readonly name: string | null;
  readonly financialStatus: string | null;
  readonly cancelledAt: string | null;
  readonly test: boolean;
  readonly sourceName: string | null;
  readonly totalPrice: string | null;
  readonly currency: string | null;
  readonly refundsCount: number;
  readonly updatedAt: Date | null;
  readonly createdAt: Date | null;
  readonly processedAt: Date;
}

export interface LinkedReservation {
  readonly id: string;
  readonly status: string;
  readonly shopifyOrderId: string | null;
}

export interface FlaggedReservation extends LinkedReservation {
  readonly updatedAt: Date;
}

/** Reservas cujo pagamento foi recebido mas que NÃO seguram a peça: o pagamento precisa de uma pessoa. */
export const INACTIVE_RESERVATION_STATUSES: readonly string[] = ['cancelled', 'expired', 'hold'];
/** Reservas que sempre pedem revisão humana (têm alerta próprio, por reserva). */
export const FLAGGED_RESERVATION_STATUSES = ['problem', 'late_payment_conflict'] as const;

/**
 * Só pedidos de CLIENTE entram: loja virtual (`web`) e canais headless (`channel:<id>`). Rascunho
 * (`shopify_draft_order`), PDV (`pos`), pedidos criados por aplicativos/API e assinaturas ficam de fora —
 * são da equipe, não uma compra de cliente sem reserva. (Lista permitida, não bloqueada: na dúvida, não alerta.)
 */
export function isCustomerOrderSource(sourceName: string | null): boolean {
  const source = (sourceName ?? '').trim().toLowerCase();
  return source === 'web' || source.startsWith('channel:');
}

/** O mais recente por pedido: maior `updated_at` do pedido; empate (ou ausência) → o webhook processado por último. */
export function latestOrderStates(rows: readonly OrderState[]): Map<string, OrderState> {
  const latest = new Map<string, OrderState>();
  for (const row of rows) {
    const current = latest.get(row.orderId);
    if (!current || isNewer(row, current)) latest.set(row.orderId, row);
  }
  return latest;
}

function isNewer(candidate: OrderState, current: OrderState): boolean {
  const a = candidate.updatedAt?.getTime();
  const b = current.updatedAt?.getTime();
  if (a !== undefined && b !== undefined && a !== b) return a > b;
  if (a !== undefined && b === undefined) return true;
  if (a === undefined && b !== undefined) return false;
  return candidate.processedAt.getTime() > current.processedAt.getTime();
}

/** Pedido resolvido: cancelado, reembolsado (total/parcial) ou excluído. */
export function isOrderSettled(orderId: string, order: OrderState | undefined, settledOrderIds: ReadonlySet<string>): boolean {
  if (settledOrderIds.has(orderId)) return true;
  if (!order) return false;
  const status = (order.financialStatus ?? '').toLowerCase();
  return Boolean(order.cancelledAt) || order.refundsCount > 0 || status === 'refunded' || status === 'partially_refunded' || status === 'voided';
}

export interface BuildPaymentAlertsInput {
  readonly orders: ReadonlyMap<string, OrderState>;
  /** Pedidos com `refunds/create` registrado (o dinheiro foi devolvido): resolvem qualquer alerta do pedido. */
  readonly settledOrderIds: ReadonlySet<string>;
  /** Pedidos excluídos na Shopify (`orders/delete`): limpam o alerta do PEDIDO, mas NÃO o da reserva (excluir não devolve o dinheiro). */
  readonly deletedOrderIds?: ReadonlySet<string>;
  /** Pedidos de Valle Pass (tabela própria): nunca geram alerta de aluguel. */
  readonly valePassOrderIds: ReadonlySet<string>;
  /** Reserva vinculada a cada pedido (por `shopify_order_id`). */
  readonly reservationsByOrder: ReadonlyMap<string, LinkedReservation>;
  /** Reservas em `problem`/`late_payment_conflict` não arquivadas. */
  readonly flaggedReservations: readonly FlaggedReservation[];
  readonly limit?: number;
}

export function buildPaymentAlerts(input: BuildPaymentAlertsInput): PaymentAlertsResult {
  const byKey = new Map<string, PaymentAlert>();

  for (const order of input.orders.values()) {
    if ((order.financialStatus ?? '').toLowerCase() !== 'paid') continue;
    if (order.test || !isCustomerOrderSource(order.sourceName)) continue;
    if (isOrderSettled(order.orderId, order, input.settledOrderIds) || input.deletedOrderIds?.has(order.orderId)) continue;
    if (input.valePassOrderIds.has(order.orderId)) continue;

    const reservation = input.reservationsByOrder.get(order.orderId);
    let kind: PaymentAlertKind | null = null;
    if (!reservation) kind = 'PAID_ORDER_WITHOUT_RESERVATION';
    else if (INACTIVE_RESERVATION_STATUSES.includes(reservation.status)) kind = 'PAID_ORDER_INACTIVE_RESERVATION';
    // pending_payment (confirmação a caminho), confirmed/em andamento e problem/late_payment_conflict (alerta próprio): sem alerta de pedido.
    if (!kind) continue;

    const key = `order:${order.orderId}`;
    byKey.set(key, {
      kind,
      key,
      orderId: order.orderId,
      orderName: order.name,
      amount: order.totalPrice,
      currency: order.currency,
      reservationId: reservation?.id ?? null,
      reservationStatus: reservation?.status ?? null,
      since: (order.createdAt ?? order.processedAt).toISOString(),
    });
  }

  for (const reservation of input.flaggedReservations) {
    const order = reservation.shopifyOrderId ? input.orders.get(reservation.shopifyOrderId) : undefined;
    // Pedido já cancelado/reembolsado/excluído: o dinheiro foi tratado, o alerta some (a reserva segue na lista, para a equipe).
    if (reservation.shopifyOrderId && isOrderSettled(reservation.shopifyOrderId, order, input.settledOrderIds)) continue;
    const kind: PaymentAlertKind = reservation.status === 'late_payment_conflict' ? 'LATE_PAYMENT_CONFLICT' : 'RESERVATION_PROBLEM';
    const key = `reservation:${reservation.id}`;
    byKey.set(key, {
      kind,
      key,
      orderId: reservation.shopifyOrderId,
      orderName: order?.name ?? null,
      amount: order?.totalPrice ?? null,
      currency: order?.currency ?? null,
      reservationId: reservation.id,
      reservationStatus: reservation.status,
      since: reservation.updatedAt.toISOString(),
    });
  }

  const alerts = [...byKey.values()].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.since.localeCompare(b.since) || a.key.localeCompare(b.key));
  const limit = input.limit ?? 50;
  return { count: alerts.length, alerts: alerts.slice(0, limit) };
}
