import { describe, expect, test } from 'vitest';
import { paymentInstantFromTransactions, type ShopifyOrderTransactions, type ShopifyTransaction } from './payment-transactions';

const tx = (over: Partial<ShopifyTransaction> = {}): ShopifyTransaction => ({ id: 'gid://shopify/OrderTransaction/' + Math.random(), kind: 'SALE', status: 'SUCCESS', test: false, processedAt: '2026-10-18T12:00:00Z', amount: '350.00', currency: 'BRL', ...over });
const order = (transactions: ShopifyTransaction[], totalAmount: string | null = '350.00'): ShopifyOrderTransactions => ({ totalAmount, currency: 'BRL', transactions });

describe('paymentInstantFromTransactions — horário do pagamento pela transação financeira bem-sucedida', () => {
  test('cartão: SALE com sucesso cobrindo o total → processedAt', () => {
    expect(paymentInstantFromTransactions(order([tx()]))).toMatchObject({ instant: new Date('2026-10-18T12:00:00Z'), reason: 'OK', used: 1 });
  });
  test('captura posterior: AUTHORIZATION não conta; vale o CAPTURE (a autorização sozinha NÃO é pagamento)', () => {
    const auth = tx({ kind: 'AUTHORIZATION', processedAt: '2026-10-15T10:00:00Z' });
    expect(paymentInstantFromTransactions(order([auth])).reason).toBe('NO_SUCCESS_TRANSACTION');
    const capture = tx({ kind: 'CAPTURE', processedAt: '2026-10-17T09:00:00Z' });
    expect(paymentInstantFromTransactions(order([auth, capture]))).toMatchObject({ instant: new Date('2026-10-17T09:00:00Z'), reason: 'OK' });
  });
  test('Pix: PENDING não conta; só o SUCCESS confirma', () => {
    expect(paymentInstantFromTransactions(order([tx({ status: 'PENDING', processedAt: '2026-10-18T08:00:00Z' })])).reason).toBe('NO_SUCCESS_TRANSACTION');
    expect(paymentInstantFromTransactions(order([tx({ status: 'PENDING' }), tx({ processedAt: '2026-10-18T17:00:00Z' })])).instant).toEqual(new Date('2026-10-18T17:00:00Z'));
  });
  test.each(['FAILURE', 'ERROR', 'AWAITING_RESPONSE', 'UNKNOWN'])('status %s nunca confirma', (status) => {
    expect(paymentInstantFromTransactions(order([tx({ status })])).instant).toBeNull();
  });
  test.each(['VOID', 'REFUND', 'CHANGE', 'SUGGESTED_REFUND', 'EMV_AUTHORIZATION', 'AUTHORIZATION'])('tipo %s nunca confirma pagamento', (kind) => {
    expect(paymentInstantFromTransactions(order([tx({ kind })])).instant).toBeNull();
  });
  test('pagamento DIVIDIDO (cartão + vale): confirmado só quando o último pedaço cobre o total; ordem pelo processedAt', () => {
    const a = tx({ amount: '100.00', processedAt: '2026-10-18T10:00:00Z' });
    const b = tx({ amount: '250.00', processedAt: '2026-10-18T10:30:00Z' });
    expect(paymentInstantFromTransactions(order([b, a]))).toMatchObject({ instant: new Date('2026-10-18T10:30:00Z'), used: 2 });
    expect(paymentInstantFromTransactions(order([a])).reason).toBe('PARTIAL_PAYMENT');
  });
  test('transação de teste não conta (a menos que o ensaio libere)', () => {
    expect(paymentInstantFromTransactions(order([tx({ test: true })])).reason).toBe('ONLY_TEST_TRANSACTIONS');
    expect(paymentInstantFromTransactions(order([tx({ test: true })]), { allowTest: true }).instant).not.toBeNull();
  });
  test('fail-closed: total ausente/zero, processedAt ausente/ilegível, valor ilegível, moeda diferente', () => {
    expect(paymentInstantFromTransactions(order([tx()], null)).reason).toBe('TOTAL_UNKNOWN');
    expect(paymentInstantFromTransactions(order([tx()], '0.00')).reason).toBe('TOTAL_UNKNOWN');
    expect(paymentInstantFromTransactions(order([tx({ processedAt: null })])).reason).toBe('PROCESSED_AT_UNKNOWN');
    expect(paymentInstantFromTransactions(order([tx({ processedAt: 'ontem' })])).reason).toBe('PROCESSED_AT_UNKNOWN');
    expect(paymentInstantFromTransactions(order([tx({ amount: 'abc' })])).reason).toBe('AMOUNT_UNKNOWN');
    expect(paymentInstantFromTransactions(order([tx({ currency: 'USD' })])).reason).toBe('CURRENCY_MISMATCH');
  });
  test('sem transações → NO_SUCCESS_TRANSACTION', () => {
    expect(paymentInstantFromTransactions(order([])).instant).toBeNull();
  });
});

describe('paymentInstantFromTransactions — instante EFETIVO da confirmação (Pix: a transação traz o horário da COBRANÇA)', () => {
  const sale = (at: string) => ({ action: 'sale_success', createdAt: at });
  const withEvents = (transactions: ShopifyTransaction[], events: { action: string; createdAt: string }[] | null, total = '350.00'): ShopifyOrderTransactions => ({ ...order(transactions, total), successEvents: events });

  test('Pix REAL medido em produção (#1013, 30/10/2026): transação em 04:40:01 (cobrança), sale_success em 04:42:00 → vale 04:42:00', () => {
    const pix = tx({ processedAt: '2026-10-30T04:40:01Z', gateway: 'Gateway Pix' });
    const verdict = paymentInstantFromTransactions(withEvents([pix], [sale('2026-10-30T04:42:00Z')]));
    expect(verdict).toMatchObject({ instant: new Date('2026-10-30T04:42:00Z'), reason: 'OK', used: 1, basis: 'SUCCESS_EVENT' });
  });
  test('Pix PAGO HORAS DEPOIS da cobrança: vale a confirmação (17:30), nunca a criação da cobrança (08:00)', () => {
    const verdict = paymentInstantFromTransactions(withEvents([tx({ processedAt: '2026-10-18T08:00:00Z' })], [sale('2026-10-18T17:30:00Z')]));
    expect(verdict.instant).toEqual(new Date('2026-10-18T17:30:00Z'));
  });
  test('cartão: o evento sai no mesmo segundo (ou 1 s depois) da transação → praticamente o mesmo instante', () => {
    expect(paymentInstantFromTransactions(withEvents([tx()], [sale('2026-10-18T12:00:00Z')])).instant).toEqual(new Date('2026-10-18T12:00:00Z'));
    expect(paymentInstantFromTransactions(withEvents([tx()], [sale('2026-10-18T12:00:01Z')])).instant).toEqual(new Date('2026-10-18T12:00:01Z'));
  });
  test('evento ANTERIOR à transação (anômalo): nunca antecipa o instante — vale o mais tardio', () => {
    expect(paymentInstantFromTransactions(withEvents([tx()], [sale('2026-10-18T11:00:00Z')])).instant).toEqual(new Date('2026-10-18T12:00:00Z'));
  });
  test('captura posterior (cartão): autorização + capture_success → vale o evento do capture', () => {
    const auth = tx({ kind: 'AUTHORIZATION', processedAt: '2026-10-15T10:00:00Z' });
    const capture = tx({ kind: 'CAPTURE', processedAt: '2026-10-17T09:00:00Z' });
    const events = [{ action: 'authorization_success', createdAt: '2026-10-15T10:00:00Z' }, { action: 'capture_success', createdAt: '2026-10-17T09:00:01Z' }];
    expect(paymentInstantFromTransactions(withEvents([auth, capture], events)).instant).toEqual(new Date('2026-10-17T09:00:01Z'));
  });
  test('eventos que não são de confirmação (sale_pending, mail_sent...) nunca contam; ordem e repetição da lista não mudam o resultado', () => {
    const noise = [{ action: 'sale_pending', createdAt: '2026-10-18T07:00:00Z' }, { action: 'mail_sent', createdAt: '2026-10-18T07:01:00Z' }];
    const a = paymentInstantFromTransactions(withEvents([tx({ processedAt: '2026-10-18T08:00:00Z' })], [...noise, sale('2026-10-18T17:30:00Z')]));
    const b = paymentInstantFromTransactions(withEvents([tx({ processedAt: '2026-10-18T08:00:00Z' })], [sale('2026-10-18T17:30:00Z'), ...noise.reverse()]));
    expect(a.instant).toEqual(new Date('2026-10-18T17:30:00Z'));
    expect(b.instant).toEqual(a.instant);
  });
  test('FAIL-CLOSED: transação de sucesso SEM evento de confirmação, evento DUPLICADO ou ilegível → horário desconhecido (volta ao ADMIN)', () => {
    expect(paymentInstantFromTransactions(withEvents([tx()], [])).reason).toBe('SUCCESS_EVENT_MISMATCH');
    expect(paymentInstantFromTransactions(withEvents([tx()], null)).reason).toBe('SUCCESS_EVENT_MISMATCH');
    expect(paymentInstantFromTransactions(withEvents([tx()], [sale('2026-10-18T12:00:00Z'), sale('2026-10-18T12:00:05Z')])).reason).toBe('SUCCESS_EVENT_MISMATCH');
    expect(paymentInstantFromTransactions(withEvents([tx()], [sale('quando?')])).reason).toBe('SUCCESS_EVENT_UNKNOWN');
    expect(paymentInstantFromTransactions(withEvents([tx()], [sale('quando?')])).instant).toBeNull();
  });
  test('Pix AINDA NÃO PAGO continua bloqueado: transação PENDING + só sale_pending → NO_SUCCESS_TRANSACTION; um sale_success sem transação de sucesso também não confirma', () => {
    const pending = withEvents([tx({ status: 'PENDING' })], [{ action: 'sale_pending', createdAt: '2026-10-18T08:00:00Z' }]);
    expect(paymentInstantFromTransactions(pending)).toMatchObject({ instant: null, reason: 'NO_SUCCESS_TRANSACTION' });
    expect(paymentInstantFromTransactions(withEvents([tx({ status: 'PENDING' })], [sale('2026-10-18T12:00:00Z')])).instant).toBeNull();
  });
  test('as demais travas valem com eventos: estorno, teste, gateway manual, pagamento parcial e pago a mais', () => {
    const ev = [sale('2026-10-18T12:00:00Z')];
    expect(paymentInstantFromTransactions(withEvents([tx(), tx({ kind: 'REFUND' })], ev)).reason).toBe('REFUND_TRANSACTION_PRESENT');
    expect(paymentInstantFromTransactions(withEvents([tx({ test: true })], ev)).reason).toBe('ONLY_TEST_TRANSACTIONS');
    expect(paymentInstantFromTransactions(withEvents([tx({ gateway: 'manual' })], ev)).reason).toBe('MANUAL_TRANSACTION');
    expect(paymentInstantFromTransactions(withEvents([tx({ amount: '100.00' })], ev)).reason).toBe('PARTIAL_PAYMENT');
    expect(paymentInstantFromTransactions(withEvents([tx(), tx({ processedAt: '2026-10-18T13:00:00Z' })], [...ev, sale('2026-10-18T13:00:00Z')])).reason).toBe('AMBIGUOUS_OVERPAYMENT');
  });
  test('pagamento DIVIDIDO: um evento por pedaço, alinhados por ordem cronológica; o instante é o do ÚLTIMO pedaço', () => {
    const a = tx({ amount: '100.00', processedAt: '2026-10-18T10:00:00Z' });
    const b = tx({ amount: '250.00', processedAt: '2026-10-18T10:30:00Z' });
    const verdict = paymentInstantFromTransactions(withEvents([b, a], [sale('2026-10-18T10:31:00Z'), sale('2026-10-18T10:00:02Z')]));
    expect(verdict).toMatchObject({ instant: new Date('2026-10-18T10:31:00Z'), used: 2 });
  });
  test('fonte que NÃO consultou os eventos (undefined: só legado/testes) mantém o processedAt da transação, marcado como basis TRANSACTION', () => {
    expect(paymentInstantFromTransactions(order([tx()]))).toMatchObject({ instant: new Date('2026-10-18T12:00:00Z'), basis: 'TRANSACTION' });
  });
});

const ptx = (processedAt: string, amount: string, over: Partial<ShopifyTransaction> = {}): ShopifyTransaction => ({ id: 'gid://shopify/OrderTransaction/' + processedAt + amount, kind: 'SALE', status: 'SUCCESS', test: false, processedAt, amount, currency: 'BRL', gateway: 'Gateway Pix', ...over });
const pev = (createdAt: string) => ({ action: 'sale_success', createdAt });
const permutations = <T,>(a: T[]): T[][] => (a.length <= 1 ? [a] : a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));

describe('associação cronológica evento ↔ transação: o instante não depende de qual evento casa com qual transação', () => {
  test('dois Pix pagos FORA DE ORDEM da criação: qualquer permutação das listas dá o mesmo instante = a ÚLTIMA confirmação', () => {
    const txs = [ptx('2026-10-18T10:00:00Z', '100.00'), ptx('2026-10-18T10:10:00Z', '250.00')];
    const events = [pev('2026-10-18T12:00:00Z'), pev('2026-10-18T11:00:00Z')]; // A pago às 12:00, B pago às 11:00
    const results = new Set<string>();
    for (const t of permutations(txs)) for (const e of permutations(events)) results.add(String(paymentInstantFromTransactions({ totalAmount: '350.00', currency: 'BRL', transactions: t, successEvents: e }).instant?.toISOString()));
    expect([...results]).toEqual(['2026-10-18T12:00:00.000Z']);
  });
  test('três pedaços (cartão + vale + Pix), eventos embaralhados: sempre o mais tardio; nunca antecipa', () => {
    const txs = [ptx('2026-10-18T09:00:00Z', '50.00', { gateway: 'card' }), ptx('2026-10-18T09:05:00Z', '100.00', { gateway: 'card' }), ptx('2026-10-18T09:10:00Z', '200.00')];
    const events = [pev('2026-10-18T09:00:01Z'), pev('2026-10-18T09:05:01Z'), pev('2026-10-18T13:45:00Z')];
    const results = new Set<string>();
    for (const t of permutations(txs)) for (const e of permutations(events)) results.add(String(paymentInstantFromTransactions({ totalAmount: '350.00', currency: 'BRL', transactions: t, successEvents: e }).instant?.toISOString()));
    expect([...results]).toEqual(['2026-10-18T13:45:00.000Z']);
  });
  test('um pedaço sem evento (2 transações, 1 evento) e evento sobrando (1 transação, 2 eventos) nunca confirmam', () => {
    const two = [ptx('2026-10-18T10:00:00Z', '100.00'), ptx('2026-10-18T10:10:00Z', '250.00')];
    expect(paymentInstantFromTransactions({ totalAmount: '350.00', currency: 'BRL', transactions: two, successEvents: [pev('2026-10-18T12:00:00Z')] }).reason).toBe('SUCCESS_EVENT_MISMATCH');
    expect(paymentInstantFromTransactions({ totalAmount: '350.00', currency: 'BRL', transactions: [ptx('2026-10-18T10:00:00Z', '350.00')], successEvents: [pev('2026-10-18T12:00:00Z'), pev('2026-10-18T12:00:03Z')] }).reason).toBe('SUCCESS_EVENT_MISMATCH');
  });
});

describe('eventos nunca de outro pedido nem de transação alheia', () => {
  test('a consulta é do pedido (Order.events): pedido devolvido com outro GID é recusado ANTES de olhar eventos; sem vínculo por transação, só a contagem exata e o webhook (±120 s) autorizam', () => {
    const base = { totalAmount: '350.00', currency: 'BRL', transactions: [ptx('2026-10-18T10:00:00Z', '350.00')], successEvents: [pev('2026-10-18T12:00:00Z')] };
    expect(paymentInstantFromTransactions({ ...base, orderGid: 'gid://shopify/Order/999' }, { expectedOrderGid: 'gid://shopify/Order/1' }).reason).toBe('ORDER_MISMATCH');
    expect(paymentInstantFromTransactions({ ...base, orderGid: 'gid://shopify/Order/1' }, { expectedOrderGid: 'gid://shopify/Order/1' }).instant).toEqual(new Date('2026-10-18T12:00:00Z'));
  });
});
