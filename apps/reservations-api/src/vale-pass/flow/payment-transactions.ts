import { parseMoneyCents } from '../financial/money';
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
}

export interface ShopifyOrderTransactions {
  readonly totalAmount: string | null;
  readonly currency: string | null;
  readonly transactions: readonly ShopifyTransaction[];
}

export interface TransactionVerdict extends TransactionEvidence {
  /** Quantas transações elegíveis foram somadas até cobrir o total. */
  readonly used: number;
}

export function paymentInstantFromTransactions(order: ShopifyOrderTransactions, options: { allowTest?: boolean } = {}): TransactionVerdict {
  const unknown = (reason: string): TransactionVerdict => ({ instant: null, reason, used: 0 });
  const total = parseMoneyCents(order.totalAmount);
  if (total === null || total <= 0) return unknown('TOTAL_UNKNOWN');
  const eligibleKinds = new Set(['SALE', 'CAPTURE']);
  const succeeded = order.transactions.filter((tx) => eligibleKinds.has(tx.kind) && tx.status === 'SUCCESS');
  if (succeeded.length === 0) return unknown('NO_SUCCESS_TRANSACTION');
  const real = succeeded.filter((tx) => options.allowTest || !tx.test);
  if (real.length === 0) return unknown('ONLY_TEST_TRANSACTIONS');

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
    if (sum >= total) return { instant: dated[i].at, reason: 'OK', used: i + 1 };
  }
  return unknown('PARTIAL_PAYMENT');
}
