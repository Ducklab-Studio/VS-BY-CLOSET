/**
 * Política do HORÁRIO DO PAGAMENTO (Valle Pass 2027). O prazo de 3 dias do cliente conta do pagamento confirmado — e nenhum dos sinais do webhook é, sozinho,
 * prova da confirmação financeira:
 *  - `X-Shopify-Triggered-At` é o "timestamp de quando a Shopify disparou a ENTREGA" (documentação da Shopify): não diz nada sobre reentregas;
 *  - o `updated_at` do payload é a última atualização do pedido (pode incluir edições posteriores se o payload for regerado numa reentrega).
 * A fonte AUTORITATIVA é a transação financeira bem-sucedida (SALE/CAPTURE, status SUCCESS) lida na Shopify Admin API (`payment-transactions.ts`).
 *
 * Modos (variável `VALE_PASS_PAYMENT_TIME_POLICY`, padrão `strict`):
 *  - `strict` (padrão): o webhook só REGISTRA os sinais; o horário só passa a valer com a transação da Admin API (concordando com o webhook, se houver) ou com
 *    a confirmação manual de um ADMIN. Até lá o pedido fica retido como PAYMENT_TIME_UNKNOWN.
 *  - `webhook-agreement`: além disso, vale o webhook quando os DOIS sinais (cabeçalho e updated_at) concordam entre si dentro da tolerância. Só deve ser usado
 *    depois do ensaio que medir a diferença real entre eles (`payment_time_evidence` guarda a diferença de cada pedido).
 *
 * Tolerância (padrão 120 s, `VALE_PASS_PAYMENT_TIME_TOLERANCE_SECONDS`, 1–900): por quê 120 s.
 *  (1) no caminho normal os dois sinais vêm do MESMO evento de pagamento; nos dois `orders/paid` reais guardados o `updated_at` coincidiu com o recebimento em até 3 s;
 *  (2) uma reentrega depois de falha acontece em escala de minutos ou mais, então a tolerância precisa ficar bem abaixo disso, mas acima do atraso/jitter normal (~40× o observado);
 *  (3) o erro máximo do prazo fica limitado à própria tolerância (2 min em 72 h = 0,05%);
 *  (4) é PROVISÓRIA: precisa ser reavaliada com as diferenças medidas no ensaio. Valores fora da faixa 1–900 voltam ao padrão.
 * Divergência além da tolerância NUNCA é resolvida com um palpite: o pedido fica PAYMENT_TIME_UNKNOWN e o ADMIN decide com os candidatos à vista.
 */
export type PaymentTimePolicyMode = 'strict' | 'webhook-agreement';

export interface PaymentTimeConfig {
  readonly mode: PaymentTimePolicyMode;
  readonly toleranceSeconds: number;
}

export const DEFAULT_TOLERANCE_SECONDS = 120;
export const MIN_TOLERANCE_SECONDS = 1;
export const MAX_TOLERANCE_SECONDS = 900;
export const STRICT_PAYMENT_TIME_CONFIG: PaymentTimeConfig = { mode: 'strict', toleranceSeconds: DEFAULT_TOLERANCE_SECONDS };

export function paymentTimeConfigFromEnv(env: Record<string, string | undefined> = process.env): PaymentTimeConfig {
  const mode: PaymentTimePolicyMode = env.VALE_PASS_PAYMENT_TIME_POLICY?.trim().toLowerCase() === 'webhook-agreement' ? 'webhook-agreement' : 'strict';
  const raw = Number(env.VALE_PASS_PAYMENT_TIME_TOLERANCE_SECONDS);
  const toleranceSeconds = Number.isInteger(raw) && raw >= MIN_TOLERANCE_SECONDS && raw <= MAX_TOLERANCE_SECONDS ? raw : DEFAULT_TOLERANCE_SECONDS;
  return { mode, toleranceSeconds };
}

/** Sinais do webhook `orders/paid`, já validados individualmente (ver `resolveWebhookSignal`). */
export interface WebhookSignal {
  readonly triggered: Date | null;
  readonly updated: Date | null;
}

/** O que a Admin API (transações) concluiu. `instant` nulo = não há como afirmar o horário. */
export interface TransactionEvidence {
  readonly instant: Date | null;
  readonly reason: string;
}

export type PaymentTimeSource = 'WEBHOOK_AGREEMENT' | 'ADMIN_API_TRANSACTION';
export type PaymentTimeUnknownReason =
  | 'NO_SIGNAL' // nenhum sinal válido do webhook nem transação
  | 'WEBHOOK_UNCONFIRMED_STRICT' // política estrita: o webhook sozinho não confirma
  | 'WEBHOOK_INCOMPLETE' // falta um dos dois sinais
  | 'WEBHOOK_DISAGREE' // cabeçalho e updated_at divergem além da tolerância
  | 'TRANSACTION_DIVERGENT' // a transação divergiu do webhook além da tolerância
  | 'TRANSACTION_UNAVAILABLE'; // a Admin API não conseguiu afirmar (ver reason da evidência)

export type PaymentTimeDecision =
  | { readonly trusted: Date; readonly source: PaymentTimeSource; readonly reason: 'OK' }
  | { readonly trusted: null; readonly source: null; readonly reason: PaymentTimeUnknownReason };

const diffSeconds = (a: Date, b: Date): number => Math.abs(a.getTime() - b.getTime()) / 1000;

export function decidePaymentTime(input: { config: PaymentTimeConfig; webhook: WebhookSignal | null; transaction: TransactionEvidence | null }): PaymentTimeDecision {
  const { config, webhook, transaction } = input;
  const tolerance = config.toleranceSeconds;
  const triggered = webhook?.triggered ?? null;
  const updated = webhook?.updated ?? null;

  // 1) A transação financeira é a fonte autoritativa. Se há sinal de webhook, os dois precisam concordar; senão, o ADMIN decide.
  if (transaction) {
    if (!transaction.instant) return { trusted: null, source: null, reason: 'TRANSACTION_UNAVAILABLE' };
    // Com sinais de webhook, a transação precisa ser CORROBORADA por pelo menos um deles (o cabeçalho OU o updated_at): numa reentrega tardia o cabeçalho pode ser
    // o do novo disparo, mas o updated_at original continua batendo com a transação. Se nenhum concorda, é divergência de verdade e o ADMIN decide.
    const signals = [triggered, updated].filter((signal): signal is Date => signal !== null);
    if (signals.length > 0 && !signals.some((signal) => diffSeconds(transaction.instant as Date, signal) <= tolerance)) return { trusted: null, source: null, reason: 'TRANSACTION_DIVERGENT' };
    return { trusted: transaction.instant, source: 'ADMIN_API_TRANSACTION', reason: 'OK' };
  }

  // 2) Só webhook.
  if (!triggered && !updated) return { trusted: null, source: null, reason: 'NO_SIGNAL' };
  if (config.mode === 'strict') return { trusted: null, source: null, reason: 'WEBHOOK_UNCONFIRMED_STRICT' };
  if (!triggered || !updated) return { trusted: null, source: null, reason: 'WEBHOOK_INCOMPLETE' };
  if (diffSeconds(triggered, updated) > tolerance) return { trusted: null, source: null, reason: 'WEBHOOK_DISAGREE' };
  return { trusted: new Date(Math.min(triggered.getTime(), updated.getTime())), source: 'WEBHOOK_AGREEMENT', reason: 'OK' };
}
