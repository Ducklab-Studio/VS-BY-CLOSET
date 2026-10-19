import { describe, expect, test } from 'vitest';
import { formatCentsBRL, multiplyCents, parseMoneyCents, sumCents } from './money';
import { ADMIN_ORDER_FINANCIAL_FIELDS, factsFromAdminOrder, factsFromWebhookPayload, type FinancialLineFacts } from './order-facts';
import { DEFAULT_MAX_UNITS_PER_ORDER, validateValePassFinancials, type FinancialExpectations, type FinancialIssueCode } from './validate-order';

const VARIANT = '49174518595684';
const PRODUCT = '8723909804132';
const money = (amount: string, currency = 'BRL') => ({ shop_money: { amount, currency_code: currency }, presentment_money: { amount, currency_code: currency } });

/** Pedido REST do webhook (`orders/paid`) de Valle Pass: R$ 350,00 × quantidade, BRL, sem desconto, pago. */
function webhookOrder(over: Record<string, unknown> = {}, lineOver: Record<string, unknown> = {}, quantity = 1): Record<string, unknown> {
  const total = (35000 * quantity) / 100;
  return {
    id: 5551234567890,
    admin_graphql_api_id: 'gid://shopify/Order/5551234567890',
    name: '#1042',
    financial_status: 'paid',
    cancelled_at: null,
    currency: 'BRL',
    presentment_currency: 'BRL',
    current_total_price: total.toFixed(2),
    total_outstanding: '0.00',
    total_discounts: '0.00',
    discount_codes: [],
    taxes_included: true,
    total_shipping_price_set: money('0.00'),
    refunds: [],
    line_items: [
      { variant_id: Number(VARIANT), product_id: Number(PRODUCT), quantity, current_quantity: quantity, price: '350.00', price_set: money('350.00'), discount_allocations: [], gift_card: false, ...lineOver },
    ],
    ...over,
  };
}

/** O MESMO pedido como o Admin GraphQL o devolve (reconciliação). */
function adminOrder(quantity = 1, over: Record<string, unknown> = {}): Record<string, unknown> {
  const set = (amount: string, currencyCode = 'BRL') => ({ shopMoney: { amount, currencyCode } });
  return {
    id: 'gid://shopify/Order/5551234567890',
    currencyCode: 'BRL',
    presentmentCurrencyCode: 'BRL',
    displayFinancialStatus: 'PAID',
    cancelledAt: null,
    discountCodes: [],
    taxesIncluded: true,
    currentTotalPriceSet: set(((35000 * quantity) / 100).toFixed(2)),
    totalOutstandingSet: set('0.00'),
    totalDiscountsSet: set('0.00'),
    totalShippingPriceSet: set('0.00'),
    lineItems: { nodes: [{ quantity, currentQuantity: quantity, variant: { id: `gid://shopify/ProductVariant/${VARIANT}` }, product: { id: `gid://shopify/Product/${PRODUCT}` }, originalUnitPriceSet: set('350.00'), discountAllocations: [] }] },
    ...over,
  };
}

const expected: FinancialExpectations = {
  unitPriceByVariant: new Map([[VARIANT, 35000]]),
  isValePassLine: (line: FinancialLineFacts) => line.variantId === VARIANT || line.productId === PRODUCT,
  maxUnitsPerOrder: DEFAULT_MAX_UNITS_PER_ORDER,
};
const verdictOf = (payload: unknown) => validateValePassFinancials(factsFromWebhookPayload(payload), expected);
const codesOf = (payload: unknown): FinancialIssueCode[] => {
  const verdict = verdictOf(payload);
  return verdict.ok ? [] : verdict.issues.map((issue) => issue.code);
};

describe('dinheiro em centavos inteiros (sem float)', () => {
  test('aceita decimais não negativos com até 2 casas significativas', () => {
    const valid: [unknown, number][] = [['350.00', 35000], ['350', 35000], ['350.5', 35050], ['350.50', 35050], ['0', 0], ['0.00', 0], ['0.01', 1], [' 350.00 ', 35000], ['350.000', 35000], ['1234567.89', 123456789], [350, 35000], [350.5, 35050], [0.07, 7]];
    for (const [input, cents] of valid) expect(parseMoneyCents(input), String(input)).toBe(cents);
  });

  test('qualquer coisa duvidosa é INDEFINIDA (null), nunca zero nem o valor esperado', () => {
    const invalid: unknown[] = ['350,00', '-1', '-0.01', '', ' ', 'abc', '1e3', '350.005', '350.001', '3.5.0', '१२३', null, undefined, {}, [], true, Number.NaN, Number.POSITIVE_INFINITY, 0.1 + 0.2, '9999999999999999', '90071992547409.93', '$350.00', '350.00 BRL'];
    for (const input of invalid) expect(parseMoneyCents(input), String(input)).toBeNull();
  });

  test('soma e multiplicação seguras; indefinido ou estouro → null', () => {
    expect(sumCents([35000, 5000])).toBe(40000);
    expect(sumCents([])).toBe(0);
    expect(sumCents([35000, null])).toBeNull();
    expect(sumCents([Number.MAX_SAFE_INTEGER, 1])).toBeNull();
    expect(multiplyCents(35000, 3)).toBe(105000);
    expect(multiplyCents(35000, 0.5)).toBeNull();
    expect(multiplyCents(Number.MAX_SAFE_INTEGER, 2)).toBeNull();
    expect(formatCentsBRL(35000)).toBe('R$ 350,00');
    expect(formatCentsBRL(5)).toBe('R$ 0,05');
    expect(formatCentsBRL(123456789)).toBe('R$ 1.234.567,89');
  });
});

describe('fatos financeiros: webhook (REST) e Admin (GraphQL) dizem a mesma coisa', () => {
  test('extração do webhook', () => {
    const facts = factsFromWebhookPayload(webhookOrder({}, {}, 3));
    expect(facts).toMatchObject({ source: 'webhook', orderId: '5551234567890', financialStatus: 'paid', cancelled: false, currency: 'BRL', presentmentCurrency: 'BRL', currentTotalCents: 105000, totalOutstandingCents: 0, totalDiscountsCents: 0, totalShippingCents: 0, discountCodes: [], refundCount: 0 });
    expect(facts.lines).toEqual([{ variantId: VARIANT, productId: PRODUCT, quantity: 3, currentQuantity: 3, unitPriceCents: 35000, unitPriceCurrency: 'BRL', discountCents: 0 }]);
  });

  test('extração do Admin GraphQL (status em maiúsculas, ids em GID)', () => {
    const facts = factsFromAdminOrder(adminOrder(3));
    expect(facts).toMatchObject({ source: 'admin', orderId: '5551234567890', financialStatus: 'paid', currency: 'BRL', presentmentCurrency: 'BRL', currentTotalCents: 105000, totalOutstandingCents: 0, totalDiscountsCents: 0 });
    expect(facts.lines).toEqual([{ variantId: VARIANT, productId: PRODUCT, quantity: 3, currentQuantity: 3, unitPriceCents: 35000, unitPriceCurrency: 'BRL', discountCents: 0 }]);
  });

  test('o mesmo pedido pelos dois caminhos produz o MESMO veredito (webhook × reconciliação)', () => {
    for (const quantity of [1, 2, 3, 10]) {
      const fromWebhook = validateValePassFinancials(factsFromWebhookPayload(webhookOrder({}, {}, quantity)), expected);
      const fromAdmin = validateValePassFinancials(factsFromAdminOrder(adminOrder(quantity)), expected);
      expect(fromAdmin).toEqual(fromWebhook);
      expect(fromAdmin).toMatchObject({ ok: true, units: quantity, passTotalCents: 35000 * quantity });
    }
    // e o mesmo erro pelos dois caminhos
    const discounted = { currentTotalPriceSet: { shopMoney: { amount: '315.00', currencyCode: 'BRL' } }, totalDiscountsSet: { shopMoney: { amount: '35.00', currencyCode: 'BRL' } } };
    const adminBad = factsFromAdminOrder({ ...adminOrder(1), ...discounted, discountCodes: ['PROMO10'] });
    const webhookBad = factsFromWebhookPayload(webhookOrder({ current_total_price: '315.00', total_discounts: '35.00', discount_codes: [{ code: 'PROMO10', amount: '35.00', type: 'fixed_amount' }] }));
    const codes = (facts: ReturnType<typeof factsFromAdminOrder>) => { const v = validateValePassFinancials(facts, expected); return v.ok ? [] : [...new Set(v.issues.map((i) => i.code))].sort(); };
    expect(codes(adminBad)).toEqual(codes(webhookBad));
    expect(codes(adminBad)).toContain('DISCOUNT_PRESENT');
  });

  test('consulta de campos financeiros documentada para a integração futura (não é a consulta ativa)', () => {
    for (const field of ['currencyCode', 'presentmentCurrencyCode', 'displayFinancialStatus', 'currentTotalPriceSet', 'totalOutstandingSet', 'totalDiscountsSet', 'discountCodes', 'currentQuantity', 'originalUnitPriceSet', 'allocatedAmountSet']) {
      expect(ADMIN_ORDER_FINANCIAL_FIELDS).toContain(field);
    }
  });

  test('entrada lixo não quebra nada: tudo vira indefinido', () => {
    for (const junk of [null, undefined, 42, 'texto', [], {}]) {
      const facts = factsFromWebhookPayload(junk);
      expect(facts.lines).toEqual([]);
      expect(facts.currentTotalCents).toBeNull();
      expect(validateValePassFinancials(facts, expected).ok).toBe(false);
    }
  });
});

describe('validação: o caso válido', () => {
  test('R$ 350,00 × 1, 2, 3 e 10 unidades, BRL, pago, sem desconto', () => {
    for (const quantity of [1, 2, 3, 10]) {
      expect(verdictOf(webhookOrder({}, {}, quantity))).toEqual({ ok: true, units: quantity, passTotalCents: 35000 * quantity });
    }
  });

  test('determinismo: reentrega do mesmo pedido e ordem das linhas não mudam o veredito', () => {
    const payload = webhookOrder();
    const first = verdictOf(payload);
    for (let i = 0; i < 20; i++) expect(verdictOf(JSON.parse(JSON.stringify(payload)))).toEqual(first);
    const bad = webhookOrder({ current_total_price: '300.00' });
    expect(verdictOf(bad)).toEqual(verdictOf(JSON.parse(JSON.stringify(bad))));
  });
});

describe('validação: pagamento (Pix, cartão, parcial, estorno)', () => {
  test('Pix aguardando, cartão só autorizado, pagamento parcial, estornado, anulado → não é compra válida', () => {
    for (const status of ['pending', 'authorized', 'partially_paid', 'partially_refunded', 'refunded', 'voided', 'expired']) {
      expect(codesOf(webhookOrder({ financial_status: status })), status).toContain('NOT_FULLY_PAID');
    }
    expect(codesOf(webhookOrder({ financial_status: undefined }))).toContain('NOT_FULLY_PAID');
  });

  test('pago pela metade: saldo em aberto é bloqueado mesmo se o status disser paid', () => {
    expect(codesOf(webhookOrder({ total_outstanding: '175.00' }))).toContain('OUTSTANDING_BALANCE');
    expect(codesOf(webhookOrder({ total_outstanding: undefined }))).toContain('OUTSTANDING_UNDEFINED');
  });

  test('pedido cancelado e pedido com reembolso', () => {
    expect(codesOf(webhookOrder({ cancelled_at: '2026-10-19T10:00:00-03:00' }))).toContain('ORDER_CANCELLED');
    expect(codesOf(webhookOrder({ refunds: [{ id: 1 }] }))).toContain('REFUND_PRESENT');
  });
});

describe('validação: moeda, preço, quantidade, desconto e total', () => {
  test('moeda da loja ou de apresentação diferente de BRL, ou ausente', () => {
    expect(codesOf(webhookOrder({ currency: 'USD' }))).toContain('CURRENCY_MISMATCH');
    expect(codesOf(webhookOrder({ presentment_currency: 'USD' }))).toContain('CURRENCY_MISMATCH');
    expect(codesOf(webhookOrder({ currency: undefined }))).toContain('CURRENCY_UNDEFINED');
    expect(codesOf(webhookOrder({ presentment_currency: undefined }))).toContain('CURRENCY_UNDEFINED');
    expect(codesOf(webhookOrder({}, { price_set: money('350.00', 'USD') }))).toContain('CURRENCY_MISMATCH');
  });

  test('preço da linha diferente do configurado (a mais ou a menos) ou ilegível', () => {
    expect(codesOf(webhookOrder({ current_total_price: '349.99' }, { price: '349.99', price_set: money('349.99') }))).toEqual(expect.arrayContaining(['PRICE_MISMATCH', 'TOTAL_MISMATCH']));
    expect(codesOf(webhookOrder({ current_total_price: '351.00' }, { price: '351.00', price_set: money('351.00') }))).toContain('PRICE_MISMATCH');
    expect(codesOf(webhookOrder({}, { price: '350,00', price_set: undefined }))).toContain('PRICE_UNDEFINED');
    expect(codesOf(webhookOrder({}, { price: undefined, price_set: undefined }))).toContain('PRICE_UNDEFINED');
  });

  test('total pago diferente de unidades × preço (valor diferente do pedido)', () => {
    expect(codesOf(webhookOrder({ current_total_price: '340.00' }))).toContain('TOTAL_MISMATCH');
    expect(codesOf(webhookOrder({ current_total_price: '350.01' }))).toContain('TOTAL_MISMATCH');
    expect(codesOf(webhookOrder({ current_total_price: undefined }))).toContain('TOTAL_UNDEFINED');
    expect(codesOf(webhookOrder({ current_total_price: '700.00' }, {}, 1))).toContain('TOTAL_MISMATCH'); // pagou por 2 e o pedido tem 1
    expect(codesOf(webhookOrder({ total_shipping_price_set: money('15.00'), current_total_price: '365.00' }))).toEqual(expect.arrayContaining(['EXTRA_CHARGES', 'TOTAL_MISMATCH']));
  });

  test('descontos: código, desconto automático sem código, alocação na linha e ilegíveis', () => {
    expect(codesOf(webhookOrder({ discount_codes: [{ code: 'PROMO10', amount: '35.00', type: 'fixed_amount' }], total_discounts: '35.00', current_total_price: '315.00' }, { discount_allocations: [{ amount: '35.00', discount_application_index: 0 }] }))).toEqual(expect.arrayContaining(['DISCOUNT_PRESENT', 'TOTAL_MISMATCH']));
    expect(codesOf(webhookOrder({ total_discounts: '10.00', current_total_price: '340.00' }))).toContain('DISCOUNT_PRESENT'); // automático, sem código
    expect(codesOf(webhookOrder({}, { discount_allocations: [{ amount_set: money('5.00') }] }))).toContain('DISCOUNT_PRESENT');
    expect(codesOf(webhookOrder({ total_discounts: undefined }))).toContain('DISCOUNT_UNDEFINED');
    expect(codesOf(webhookOrder({}, { discount_allocations: undefined }))).toContain('DISCOUNT_UNDEFINED');
    expect(codesOf(webhookOrder({ discount_codes: [{ code: 'ZERO', amount: '0.00' }] }))).toContain('DISCOUNT_PRESENT'); // até cupom de valor zero é decisão humana
  });

  test('quantidade: inválida, acima do teto, alterada depois do pedido, indefinida', () => {
    expect(codesOf(webhookOrder({ current_total_price: '0.00' }, { quantity: 0, current_quantity: 0 }, 1))).toContain('QUANTITY_INVALID');
    expect(codesOf(webhookOrder({}, { quantity: 1.5 }))).toContain('QUANTITY_UNDEFINED');
    expect(codesOf(webhookOrder({}, {}, 11))).toContain('QUANTITY_OUT_OF_RANGE');
    expect(codesOf(webhookOrder({}, { current_quantity: 0 }, 1))).toContain('QUANTITY_CHANGED');
    expect(codesOf(webhookOrder({ current_total_price: '350.00' }, { quantity: 2, current_quantity: 1 }, 1))).toEqual(expect.arrayContaining(['QUANTITY_CHANGED', 'TOTAL_MISMATCH']));
    expect(codesOf(webhookOrder({}, { current_quantity: undefined }))).toContain('QUANTITY_UNDEFINED');
  });

  test('carrinho misto, variante desconhecida e pedido sem Valle Pass', () => {
    const mixed = webhookOrder();
    (mixed.line_items as unknown[]).push({ variant_id: 111, product_id: 222, quantity: 1, current_quantity: 1, price: '50.00', price_set: money('50.00'), discount_allocations: [] });
    expect(codesOf(mixed)).toContain('MIXED_CART');
    // produto conhecido do Valle Pass, mas variante sem preço configurado
    expect(codesOf(webhookOrder({}, { variant_id: 999 }))).toContain('UNKNOWN_VALE_PASS_VARIANT');
    expect(codesOf(webhookOrder({ line_items: [{ variant_id: 111, product_id: 222, quantity: 1, current_quantity: 1, price: '50.00', discount_allocations: [] }] }))).toContain('NO_VALLE_PASS_LINE');
  });

  test('o preço do payload NUNCA define o esperado: só a configuração comercial', () => {
    const cheap = webhookOrder({ current_total_price: '1.00' }, { price: '1.00', price_set: money('1.00') });
    expect(verdictOf(cheap).ok).toBe(false);
    const otherPrice = validateValePassFinancials(factsFromWebhookPayload(cheap), { ...expected, unitPriceByVariant: new Map([[VARIANT, 100]]) });
    expect(otherPrice.ok).toBe(true); // só muda se a CONFIGURAÇÃO (campanha) mudar
  });

  test('pedido montado pela reconciliação ANTIGA (sem dado financeiro) é recusado de forma explícita', () => {
    const legacyShape = { id: 5551234567890, admin_graphql_api_id: 'gid://shopify/Order/5551234567890', name: '#1042', financial_status: 'paid', cancelled_at: null, updated_at: '2026-10-19T10:00:00Z', line_items: [{ variant_id: VARIANT, product_id: PRODUCT, quantity: 1 }] };
    const verdict = verdictOf(legacyShape);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? [] : verdict.issues.map((issue) => issue.code)).toEqual(['FINANCIALS_UNDEFINED']);
  });
});

describe('fail-closed: remover QUALQUER campo obrigatório torna o pedido inválido', () => {
  const required: [string, (payload: Record<string, unknown>) => void][] = [
    ['financial_status', (p) => delete p.financial_status],
    ['currency', (p) => delete p.currency],
    ['presentment_currency', (p) => delete p.presentment_currency],
    ['current_total_price', (p) => delete p.current_total_price],
    ['total_outstanding', (p) => delete p.total_outstanding],
    ['total_discounts', (p) => delete p.total_discounts],
    ['line_items', (p) => delete p.line_items],
    ['line.quantity', (p) => delete (p.line_items as Record<string, unknown>[])[0].quantity],
    ['line.current_quantity', (p) => delete (p.line_items as Record<string, unknown>[])[0].current_quantity],
    ['line.price + price_set', (p) => { const l = (p.line_items as Record<string, unknown>[])[0]; delete l.price; delete l.price_set; }],
    ['line.discount_allocations', (p) => delete (p.line_items as Record<string, unknown>[])[0].discount_allocations],
    ['line.variant_id + product_id', (p) => { const l = (p.line_items as Record<string, unknown>[])[0]; delete l.variant_id; delete l.product_id; }],
  ];
  test.each(required)('sem %s', (_name, mutate) => {
    const payload = JSON.parse(JSON.stringify(webhookOrder()));
    mutate(payload);
    expect(validateValePassFinancials(factsFromWebhookPayload(payload), expected).ok).toBe(false);
  });

  test('valores corrompidos em cada campo numérico também recusam', () => {
    for (const field of ['current_total_price', 'total_outstanding', 'total_discounts']) {
      for (const bad of ['abc', '-1', '1e3', '', '350.005', null, {}]) {
        expect(verdictOf(webhookOrder({ [field]: bad })).ok, `${field}=${String(bad)}`).toBe(false);
      }
    }
  });

  test('todos os problemas são reportados juntos (a pessoa que resolve vê o quadro inteiro)', () => {
    const codes = codesOf(webhookOrder({ financial_status: 'partially_paid', currency: 'USD', total_outstanding: '100.00', discount_codes: [{ code: 'X' }], current_total_price: '250.00', total_discounts: '100.00' }));
    expect(codes).toEqual(expect.arrayContaining(['NOT_FULLY_PAID', 'CURRENCY_MISMATCH', 'OUTSTANDING_BALANCE', 'DISCOUNT_PRESENT', 'TOTAL_MISMATCH']));
  });
});

test('a consulta da Admin API pede os campos que decidem pedido de teste e pagamento manual', () => {
  expect(ADMIN_ORDER_FINANCIAL_FIELDS).toMatch(/test/);
  expect(ADMIN_ORDER_FINANCIAL_FIELDS).toContain('paymentGatewayNames');
});

describe('validação: pedido de TESTE e pagamento MANUAL nunca valem como compra comercial', () => {
  test('test: true → TEST_ORDER (webhook e Admin API); test: false/ausente não bloqueia', () => {
    expect(codesOf(webhookOrder({ test: true }))).toContain('TEST_ORDER');
    expect(codesOf(webhookOrder({ test: false }))).toEqual([]);
    expect(codesOf(webhookOrder())).toEqual([]);
    const admin = validateValePassFinancials(factsFromAdminOrder(adminOrder(1, { test: true })), expected);
    expect(admin.ok ? [] : admin.issues.map((issue) => issue.code)).toContain('TEST_ORDER');
  });

  test('gateway manual/teste/offline → MANUAL_PAYMENT; Pix e cartão reais não bloqueiam', () => {
    for (const gateways of [['manual'], ['Mercado Pago Pix', 'manual'], ['bogus'], ['Cash on Delivery (COD)'], ['Bank Deposit'], ['Money Order'], ['for testing']]) {
      expect(codesOf(webhookOrder({ payment_gateway_names: gateways })), gateways.join()).toContain('MANUAL_PAYMENT');
    }
    for (const gateways of [['Mercado Pago Pix'], ['shopify_payments'], ['mercado_pago'], []]) {
      expect(codesOf(webhookOrder({ payment_gateway_names: gateways })), gateways.join()).toEqual([]);
    }
    const admin = validateValePassFinancials(factsFromAdminOrder(adminOrder(1, { paymentGatewayNames: ['manual'] })), expected);
    expect(admin.ok ? [] : admin.issues.map((issue) => issue.code)).toContain('MANUAL_PAYMENT');
  });
});
