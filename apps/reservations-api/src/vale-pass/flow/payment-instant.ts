/**
 * Instante REAL do pagamento confirmado (Valle Pass 2027). O prazo de 3 dias do cliente corre desde o PAGAMENTO — não desde o processamento (webhook
 * atrasado, API fora do ar, reconciliação tardia).
 *
 * Fonte: o cabeçalho `X-Shopify-Triggered-At` da entrega de `orders/paid` (momento em que a Shopify disparou o evento de pagamento; permanece o mesmo
 * nas reentregas). NÃO servem: `created_at` (criação do pedido; Pix/boleto pagam depois), `processed_at` (idem), `updated_at` e o cabeçalho de
 * `orders/updated` (qualquer edição genérica) e o relógio do servidor (o processamento). O payload REST de `orders/paid` não traz um "paid_at".
 *
 * Fail-closed: ausente, malformado, no futuro ou anterior à criação do pedido → `at: null` com o motivo. Nunca se inventa horário.
 */
export const PAYMENT_INSTANT_SKEW_MS = 5 * 60_000;

/** Metadados da entrega do webhook que o Valle Pass precisa (cabeçalhos autenticados pela assinatura HMAC). */
export interface ValePassWebhookMeta {
  readonly triggeredAt: string | null;
}

export interface WebhookInput {
  readonly topic: string;
  readonly shopifyWebhookId: string;
  readonly payload: unknown;
  /** Valor bruto do cabeçalho `X-Shopify-Triggered-At`. */
  readonly triggeredAt?: string | null;
}

export type PaymentInstantReason = 'NOT_PAID_TOPIC' | 'MISSING' | 'INVALID' | 'FUTURE' | 'BEFORE_ORDER_CREATED';
export type PaymentInstant = { readonly at: Date; readonly reason?: undefined } | { readonly at: null; readonly reason: PaymentInstantReason };

// ISO 8601 com data, hora e fuso explícitos (a Shopify envia `2021-01-01T00:00:00.000000000Z` ou com `-03:00`).
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A documentação da Shopify descreve o cabeçalho como o momento em que a Shopify disparou a ENTREGA; numa reentrega (retry após 5xx) ele pode ser o do
 * novo disparo. Por isso, quando o `updated_at` do próprio payload de `orders/paid` (o instante em que o pedido passou a pago) é válido e MAIS ANTIGO,
 * vale ele: nunca atrasa o prazo por causa de uma reentrega. Sempre o mais conservador (mais antigo) entre fontes válidas.
 */
export function resolvePaymentInstant(input: { topic: string; triggeredAt: string | null | undefined; orderCreatedAt: Date | null; payloadUpdatedAt?: Date | null; now?: Date }): PaymentInstant {
  if (input.topic !== 'orders/paid') return { at: null, reason: 'NOT_PAID_TOPIC' };
  const raw = input.triggeredAt?.trim();
  if (!raw) return { at: null, reason: 'MISSING' };
  if (!ISO_WITH_ZONE.test(raw)) return { at: null, reason: 'INVALID' };
  // `Date` só guarda milissegundos: corta a fração (nanossegundos) antes de interpretar.
  const at = new Date(raw.replace(/(\.\d{3})\d+/, '$1'));
  if (Number.isNaN(at.getTime())) return { at: null, reason: 'INVALID' };
  const now = input.now ?? new Date();
  if (at.getTime() > now.getTime() + PAYMENT_INSTANT_SKEW_MS) return { at: null, reason: 'FUTURE' };
  if (input.orderCreatedAt && at.getTime() < input.orderCreatedAt.getTime() - PAYMENT_INSTANT_SKEW_MS) return { at: null, reason: 'BEFORE_ORDER_CREATED' };
  const updated = input.payloadUpdatedAt;
  const updatedValid = updated && !Number.isNaN(updated.getTime()) && updated.getTime() < at.getTime() && (!input.orderCreatedAt || updated.getTime() >= input.orderCreatedAt.getTime() - PAYMENT_INSTANT_SKEW_MS);
  return { at: updatedValid ? updated : at };
}
