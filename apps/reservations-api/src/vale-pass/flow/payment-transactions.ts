import { parseMoneyCents } from '../financial/money';
import { isManualOrTestGateway } from '../financial/gateway';
import type { TransactionEvidence } from './payment-time-policy';

/**
 * Horário do pagamento a partir das TRANSAÇÕES financeiras da Shopify (Admin API GraphQL, `Order.transactions`) — a fonte autoritativa do Valle Pass 2027.
 *
 * Regras (conservadoras, todas fail-closed):
 *  - só contam transações `SALE` (autorização + captura) ou `CAPTURE` (captura posterior de uma `AUTHORIZATION`) com status `SUCCESS`. `AUTHORIZATION` isolada,
 *    `PENDING` (Pix/boleto ainda não pagos), `AWAITING_RESPONSE`, `FAILURE`, `ERROR`, `VOID` e `REFUND` NUNCA confirmam pagamento;
 *  - transação de TESTE não conta (a menos que o ensaio em loja de desenvolvimento a libere explicitamente);
 *  - o instante é o `processedAt` da transação que, somada às anteriores (em ordem de `processedAt`), COBRE o total do pedido — pagamento dividido (cartão + vale)
 *    só está confirmado quando o último pedaço entra; se a soma não cobre o total (ou o total é indefinido), o horário é desconhecido;
 *  - moeda diferente entre transações e pedido, valor ilegível ou `processedAt` ausente/ilegível → desconhecido.
 * O que a documentação da Shopify NÃO garante (e o ensaio precisa comprovar): se o `processedAt` de uma transação assíncrona (Pix) é o momento do SUCCESS ou o da
 * criação da transação pendente. Por isso o resultado só vale se concordar com o sinal do webhook; divergência vai para o ADMIN (ver `decidePaymentTime`).
 */
export interface ShopifyTransaction {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly test: boolean;
  readonly processedAt: string | null;
  readonly amount: string | null;
  readonly currency: string | null;
  /** Gateway da transação (ex.: "gateway_pix", "manual"). Ausente = a fonte não informou. */
  readonly gateway?: string | null;
}

export interface ShopifyOrderTransactions {
  /** GID que a Shopify devolveu; conferido contra `expectedOrderGid` quando informado. */
  readonly orderGid?: string | null;
  readonly totalAmount: string | null;
  readonly currency: string | null;
  readonly transactions: readonly ShopifyTransaction[];
}

export interface TransactionVerdict extends TransactionEvidence {
  /** Quantas transações elegíveis foram somadas até cobrir o total. */
  readonly used: number;
}

/** A Shopify devolve no máximo `first: 50`; com 50 itens pode haver mais: ambíguo. */
export const TRANSACTIONS_PAGE_LIMIT = 50;

export function paymentInstantFromTransactions(order: ShopifyOrderTransactions, options: { allowTest?: boolean; expectedOrderGid?: string | null } = {}): TransactionVerdict {
  const unknown = (reason: string): TransactionVerdict => ({ instant: null, reason, used: 0 });
  if (options.expectedOrderGid && order.orderGid !== options.expectedOrderGid) return unknown('ORDER_MISMATCH');
  if (order.transactions.length >= TRANSACTIONS_PAGE_LIMIT) return unknown('TOO_MANY_TRANSACTIONS');
  const total = parseMoneyCents(order.totalAmount);
  if (total === null || total <= 0) return unknown('TOTAL_UNKNOWN');
  const eligibleKinds = new Set(['SALE', 'CAPTURE']);
  const succeeded = order.transactions.filter((tx) => eligibleKinds.has(tx.kind) && tx.status === 'SUCCESS');
  // Estorno bem-sucedido: o pagamento deixou de ser integral/estável; o caso é do fluxo de reembolso, nunca de confirmação automática.
  if (order.transactions.some((tx) => tx.kind === 'REFUND' && tx.status === 'SUCCESS')) return unknown('REFUND_TRANSACTION_PRESENT');
  if (succeeded.length === 0) return unknown('NO_SUCCESS_TRANSACTION');
  const real = succeeded.filter((tx) => options.allowTest || !tx.test);
  if (real.length === 0) return unknown('ONLY_TEST_TRANSACTIONS');
  if (real.length !== succeeded.length) return unknown('MIXED_TEST_TRANSACTION');
  // Pagamento manual (gateway manual/teste/offline) não é prova comercial de pagamento.
  if (!options.allowTest && real.some((tx) => isManualOrTestGateway(tx.gateway))) return unknown('MANUAL_TRANSACTION');

  const dated: { at: Date; cents: number }[] = [];
  for (const tx of real) {
    const at = tx.processedAt ? new Date(tx.processedAt) : null;
    const cents = parseMoneyCents(tx.amount);
    if (!at || Number.isNaN(at.getTime())) return unknown('PROCESSED_AT_UNKNOWN');
    if (cents === null) return unknown('AMOUNT_UNKNOWN');
    if (order.currency && tx.currency && tx.currency !== order.currency) return unknown('CURRENCY_MISMATCH');
    dated.push({ at, cents });
  }
  dated.sort((a, b) => a.at.getTime() - b.at.getTime());
  let sum = 0;
  for (let i = 0; i < dated.length; i++) {
    sum += dated[i].cents;
    if (sum >= total) {
      // Soma de TODAS as transações elegíveis diferente do total (pagou a mais) é ambígua: não confirma sozinho.
      const all = dated.reduce((acc, item) => acc + item.cents, 0);
      if (all !== total) return unknown('AMBIGUOUS_OVERPAYMENT');
      return { instant: dated[i].at, reason: 'OK', used: i + 1 };
    }
  }
  return unknown('PARTIAL_PAYMENT');
}
