import { parseMoneyCents } from '../financial/money';
import { EXPECTED_CURRENCY } from '../financial/validate-order';
import { PAYMENT_INSTANT_SKEW_MS } from './payment-instant';
import { paymentInstantFromTransactions, type ShopifyOrderTransactions } from './payment-transactions';
import { decidePaymentTime, type PaymentTimeConfig } from './payment-time-policy';

/**
 * Decisão PURA da verificação financeira automática do Valle Pass 2027. Só devolve `confirm: true` quando TUDO abaixo é verdade; qualquer dúvida
 * (dados insuficientes, divergência, ambiguidade) devolve o motivo e a retenção continua para o ADMIN. Confirmar o horário NÃO emite nada: a retomada
 * seguinte repete a validação financeira completa (preço, quantidade, desconto, frete, saldo, reembolso, teste, pagamento manual, capacidade).
 *
 *  1. as transações vêm do MESMO pedido consultado (GID conferido);
 *  2. SALE/CAPTURE com SUCCESS, não-teste, gateway não-manual, sem estorno, soma exatamente igual ao total (ver `paymentInstantFromTransactions`);
 *  3. moeda BRL;
 *  4. total pago = preço unitário da campanha × quantidade registrada (sem desconto, frete ou taxa);
 *  5. há ao menos um sinal do webhook e a transação o corrobora dentro da tolerância (sem webhook para comparar, não se confirma sozinho);
 *  6. o instante não está no futuro nem antes da criação do pedido.
 */
export interface AutoVerifyInput {
  readonly fetched: ShopifyOrderTransactions & { readonly orderGid?: string | null };
  readonly expectedOrderGid: string;
  readonly unitPriceCents: number;
  readonly quantity: number;
  readonly webhook: { readonly triggered: Date | null; readonly updated: Date | null };
  readonly orderCreatedAt: Date | null;
  readonly config: PaymentTimeConfig;
  readonly now: Date;
}

export type AutoVerifyDecision =
  | { readonly confirm: true; readonly instant: Date; readonly used: number }
  | { readonly confirm: false; readonly reason: string; readonly retryable: boolean; readonly instant: Date | null };

/** Motivos que costumam se resolver sozinhos (Pix ainda não pago, pagamento parcial a caminho): a tentativa se repete em intervalos curtos. */
const RETRYABLE = new Set(['NO_SUCCESS_TRANSACTION', 'PARTIAL_PAYMENT', 'SHOPIFY_UNAVAILABLE', 'SUCCESS_EVENT_MISMATCH']);

export function decideAutoVerification(input: AutoVerifyInput): AutoVerifyDecision {
  const no = (reason: string, instant: Date | null = null): AutoVerifyDecision => ({ confirm: false, reason, retryable: RETRYABLE.has(reason), instant });
  const verdict = paymentInstantFromTransactions(input.fetched, { expectedOrderGid: input.expectedOrderGid });
  if (!verdict.instant) return no(verdict.reason);
  if (input.fetched.currency !== EXPECTED_CURRENCY) return no('CURRENCY_NOT_BRL', verdict.instant);
  const total = parseMoneyCents(input.fetched.totalAmount);
  if (!Number.isInteger(input.quantity) || input.quantity <= 0 || !Number.isInteger(input.unitPriceCents) || input.unitPriceCents <= 0) return no('REGISTRY_QUANTITY_INVALID', verdict.instant);
  if (total === null || total !== input.unitPriceCents * input.quantity) return no('ORDER_TOTAL_MISMATCH', verdict.instant);
  if (!input.webhook.triggered && !input.webhook.updated) return no('NO_CORROBORATION', verdict.instant);
  const decision = decidePaymentTime({ config: input.config, webhook: input.webhook, transaction: { instant: verdict.instant, reason: verdict.reason } });
  if (!decision.trusted) return no(decision.reason, verdict.instant);
  if (decision.trusted.getTime() > input.now.getTime() + PAYMENT_INSTANT_SKEW_MS) return no('INSTANT_IN_FUTURE', verdict.instant);
  if (input.orderCreatedAt && decision.trusted.getTime() < input.orderCreatedAt.getTime() - PAYMENT_INSTANT_SKEW_MS) return no('INSTANT_BEFORE_ORDER', verdict.instant);
  return { confirm: true, instant: decision.trusted, used: verdict.used };
}

/** Escada de novas tentativas (minutos) para motivos que se resolvem sozinhos; os demais voltam a ser olhados só a cada 6 h (um ADMIN pode ter corrigido algo). */
const LADDER_MINUTES = [1, 2, 5, 10, 30, 60] as const;
export const TERMINAL_RETRY_MINUTES = 360;

export function nextAttemptAt(now: Date, attempts: number, retryable: boolean): Date {
  const minutes = retryable ? LADDER_MINUTES[Math.min(Math.max(attempts - 1, 0), LADDER_MINUTES.length - 1)] : TERMINAL_RETRY_MINUTES;
  return new Date(now.getTime() + minutes * 60_000);
}
