/**
 * "Pagamentos a tratar" no ClosetAdmin — regras PURAS de apresentação (sem imports, para test/payment-alerts.test.mjs).
 *
 * Os alertas vêm do servidor (GET /admin/reservations/payment-alerts). Aqui só se valida o formato e se escolhe o texto.
 * SOMENTE LEITURA e sem dados pessoais: número do pedido, valor, tipo e ids internos — nada de nome, e-mail ou telefone.
 */

export type PaymentAlertKind =
  | 'LATE_PAYMENT_CONFLICT'
  | 'PAID_ORDER_WITHOUT_RESERVATION'
  | 'PAID_ORDER_INACTIVE_RESERVATION'
  | 'RESERVATION_PROBLEM';

export interface PaymentAlert {
  readonly kind: PaymentAlertKind;
  readonly key: string;
  readonly orderId: string | null;
  readonly orderName: string | null;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly reservationId: string | null;
  readonly reservationStatus: string | null;
  readonly since: string;
}

export interface PaymentAlerts {
  readonly count: number;
  readonly alerts: readonly PaymentAlert[];
}

const KINDS: readonly string[] = ['LATE_PAYMENT_CONFLICT', 'PAID_ORDER_WITHOUT_RESERVATION', 'PAID_ORDER_INACTIVE_RESERVATION', 'RESERVATION_PROBLEM'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/**
 * Valida a resposta e copia SÓ os campos conhecidos: se a API um dia devolver algo a mais (inclusive dado pessoal),
 * a tela nunca o recebe. `null` = resposta fora do formato (a tela avisa que não conseguiu verificar).
 */
export function parsePaymentAlerts(raw: unknown): PaymentAlerts | null {
  if (!raw || typeof raw !== 'object') return null;
  const { count, alerts } = raw as { count?: unknown; alerts?: unknown };
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || !Array.isArray(alerts)) return null;
  const parsed: PaymentAlert[] = [];
  for (const item of alerts) {
    if (!item || typeof item !== 'object') return null;
    const a = item as Record<string, unknown>;
    const kind = str(a.kind);
    const key = str(a.key);
    const since = str(a.since);
    if (!kind || !KINDS.includes(kind) || !key || !since || Number.isNaN(Date.parse(since))) return null;
    const reservationId = str(a.reservationId);
    parsed.push({
      kind: kind as PaymentAlertKind,
      key,
      orderId: str(a.orderId),
      orderName: str(a.orderName),
      amount: str(a.amount),
      currency: str(a.currency),
      reservationId: reservationId && UUID.test(reservationId) ? reservationId : null,
      reservationStatus: str(a.reservationStatus),
      since,
    });
  }
  return { count, alerts: parsed };
}

export function paymentAlertTitle(kind: PaymentAlertKind): string {
  switch (kind) {
    case 'LATE_PAYMENT_CONFLICT':
      return 'Pagamento recebido, peça já ocupada';
    case 'PAID_ORDER_WITHOUT_RESERVATION':
      return 'Pedido pago sem reserva';
    case 'PAID_ORDER_INACTIVE_RESERVATION':
      return 'Pedido pago, reserva não ativa';
    case 'RESERVATION_PROBLEM':
      return 'Reserva em revisão';
  }
}

/** O que a equipe precisa entender e fazer — sempre manual: o sistema não cancela, libera nem reembolsa nada. */
export function paymentAlertHint(kind: PaymentAlertKind): string {
  switch (kind) {
    case 'LATE_PAYMENT_CONFLICT':
      return 'A cliente pagou depois do prazo e a peça já era de outra reserva. Ofereça outra data/peça ou reembolse na Shopify.';
    case 'PAID_ORDER_WITHOUT_RESERVATION':
      return 'Há dinheiro recebido e nenhuma reserva ligada ao pedido. Confira o pedido na Shopify: reembolse ou crie a reserva manualmente.';
    case 'PAID_ORDER_INACTIVE_RESERVATION':
      return 'O pedido foi pago, mas a reserva dele está cancelada, expirada ou sem confirmação. Reembolse ou reative com a cliente.';
    case 'RESERVATION_PROBLEM':
      return 'A reserva foi marcada para revisão manual (divergência no pedido ou reembolso). Veja o histórico dela.';
  }
}

export function paymentAlertsHeadline(count: number): string {
  if (count <= 0) return 'Nenhum pagamento a tratar';
  return count === 1 ? '1 pagamento a tratar' : `${count} pagamentos a tratar`;
}

/** "R$ 120,00" para BRL; outra moeda ou valor ilegível: devolve como veio, sem inventar conversão. */
export function formatAlertAmount(amount: string | null, currency: string | null): string | null {
  if (!amount) return null;
  const value = Number(amount);
  if (!Number.isFinite(value)) return null;
  if (!currency || currency === 'BRL') return `R$ ${value.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
  return `${value.toFixed(2)} ${currency}`;
}

/** "há 5 min", "há 3 h", "há 2 dias". */
export function sinceLabel(since: string, now: number = Date.now()): string {
  const diffMs = now - Date.parse(since);
  if (!Number.isFinite(diffMs) || diffMs < 60_000) return 'agora há pouco';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `há ${hours} h`;
  return `há ${Math.floor(hours / 24)} dias`;
}

/** Itens mostrados no cartão; o resto vira "e mais N" (a contagem total continua a do servidor). */
export const PAYMENT_ALERTS_VISIBLE = 8;

export function hiddenAlertsCount(alerts: PaymentAlerts): number {
  return Math.max(0, alerts.count - Math.min(alerts.alerts.length, PAYMENT_ALERTS_VISIBLE));
}
