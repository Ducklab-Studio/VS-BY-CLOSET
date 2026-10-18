import type { WebhookSignal } from './payment-time-policy';

/**
 * Sinais de horário do webhook `orders/paid` (Valle Pass 2027), validados UM A UM. Nenhum deles prova sozinho a confirmação financeira (ver
 * `payment-time-policy.ts`): aqui só se separa o que é utilizável do que é ruído. O prazo de 3 dias corre desde o PAGAMENTO — não desde o processamento
 * (webhook atrasado, API fora do ar, reconciliação tardia).
 *
 *  - `X-Shopify-Triggered-At` (cabeçalho): "timestamp de quando a Shopify disparou a entrega". Só vale na entrega de `orders/paid`.
 *  - `updated_at` do payload: última atualização do pedido na geração do payload.
 * NÃO servem: `created_at`/`processed_at` (criação do pedido; no Pix o pagamento vem horas depois), o cabeçalho de `orders/updated`/`orders/create` (qualquer
 * edição) e o relógio do servidor (o processamento). O payload REST de `orders/paid` não traz um "paid_at".
 *
 * Fail-closed: ausente, malformado, no futuro ou anterior à criação do pedido → o sinal fica nulo com o motivo. Nunca se inventa horário.
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

export type SignalRejection = 'NOT_PAID_TOPIC' | 'MISSING' | 'INVALID' | 'FUTURE' | 'BEFORE_ORDER_CREATED';

export interface ResolvedWebhookSignal extends WebhookSignal {
  /** Por que o cabeçalho foi descartado (nulo se foi aceito). */
  readonly triggeredRejected: SignalRejection | null;
  /** Por que o `updated_at` foi descartado (nulo se foi aceito). */
  readonly updatedRejected: SignalRejection | null;
}

// ISO 8601 com data, hora e fuso explícitos (a Shopify envia `2021-01-01T00:00:00.000000000Z` ou com `-03:00`).
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function parseIso(raw: string | null | undefined): { at: Date } | { rejected: SignalRejection } {
  const text = raw?.trim();
  if (!text) return { rejected: 'MISSING' };
  if (!ISO_WITH_ZONE.test(text)) return { rejected: 'INVALID' };
  // `Date` só guarda milissegundos: corta a fração (nanossegundos) antes de interpretar.
  const at = new Date(text.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(at.getTime()) ? { rejected: 'INVALID' } : { at };
}

function bounded(at: Date, orderCreatedAt: Date | null, now: Date): SignalRejection | null {
  if (at.getTime() > now.getTime() + PAYMENT_INSTANT_SKEW_MS) return 'FUTURE';
  if (orderCreatedAt && at.getTime() < orderCreatedAt.getTime() - PAYMENT_INSTANT_SKEW_MS) return 'BEFORE_ORDER_CREATED';
  return null;
}

/** ISO 8601 com fuso → `Date` (nulo se ausente/ilegível). Sem checar limites. */
export function parseIsoInstant(raw: string | null | undefined): Date | null {
  const parsed = parseIso(raw);
  return 'at' in parsed ? parsed.at : null;
}

export function resolveWebhookSignal(input: { topic: string; triggeredAt: string | null | undefined; payloadUpdatedAt: string | null | undefined; orderCreatedAt: Date | null; now?: Date }): ResolvedWebhookSignal {
  if (input.topic !== 'orders/paid') return { triggered: null, updated: null, triggeredRejected: 'NOT_PAID_TOPIC', updatedRejected: 'NOT_PAID_TOPIC' };
  const now = input.now ?? new Date();
  const side = (raw: string | null | undefined): { at: Date | null; rejected: SignalRejection | null } => {
    const parsed = parseIso(raw);
    if ('rejected' in parsed) return { at: null, rejected: parsed.rejected };
    const reason = bounded(parsed.at, input.orderCreatedAt, now);
    return reason ? { at: null, rejected: reason } : { at: parsed.at, rejected: null };
  };
  const triggered = side(input.triggeredAt);
  const updated = side(input.payloadUpdatedAt);
  return { triggered: triggered.at, updated: updated.at, triggeredRejected: triggered.rejected, updatedRejected: updated.rejected };
}
