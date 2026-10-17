import { describe, expect, test } from 'vitest';
import { factsFromRefundWebhook, type RefundLineFacts } from './refund-facts';
import { planRefund, standingOf, statusAfterRefund, type RefundPlanInput, type UnitState, type VoucherStatus } from './refund-plan';

const VARIANT = '49174518595684';
const PRODUCT = '8723909804132';
const money = (amount: string) => ({ shop_money: { amount, currency_code: 'BRL' }, presentment_money: { amount, currency_code: 'BRL' } });

/** Reembolso REST no formato real do webhook `refunds/create` (valores numéricos em subtotal/total_tax, textos em preço e frete). */
function refundPayload(over: { lines?: Record<string, unknown>[]; shipping?: string[]; transactions?: Record<string, unknown>[]; adjustments?: unknown[]; id?: number | null; orderId?: number | null } = {}): Record<string, unknown> {
  const line = (quantity: number, extra: Record<string, unknown> = {}) => ({
    id: 9001, line_item_id: 7001, quantity, subtotal: 350 * quantity, total_tax: 50.85, restock_type: 'return', subtotal_set: money(String(350 * quantity)), total_tax_set: money('50.85'),
    line_item: { variant_id: Number(VARIANT), product_id: Number(PRODUCT), price: '350.00', quantity: 3 }, ...extra,
  });
  return {
    id: over.id === undefined ? 555001 : over.id,
    order_id: over.orderId === undefined ? 5551234567890 : over.orderId,
    note: null,
    refund_line_items: over.lines ?? [line(1)],
    refund_shipping_lines: (over.shipping ?? []).map((amount) => ({ id: 1, subtotal_amount_set: money(amount) })),
    transactions: over.transactions ?? [],
    order_adjustments: over.adjustments ?? [],
  };
}
const valeLine = (quantity: number, extra: Record<string, unknown> = {}) => ({
  id: 9001, line_item_id: 7001, quantity, subtotal: 350 * quantity, total_tax: 50.85, restock_type: 'return',
  line_item: { variant_id: Number(VARIANT), product_id: Number(PRODUCT), price: '350.00', quantity: 3 }, ...extra,
});
const otherLine = (quantity = 1) => ({ id: 9002, line_item_id: 7002, quantity, subtotal: 80 * quantity, total_tax: 0, restock_type: 'no_restock', line_item: { variant_id: 111, product_id: 222, price: '80.00', quantity: 1 } });

const unit = (groupId: string, minutes: number, statuses: VoucherStatus[] = ['ACTIVE', 'ACTIVE']): UnitState => ({
  groupId,
  createdAt: new Date(Date.UTC(2026, 9, 17, 12, minutes)),
  vouchers: statuses.map((status, index) => ({ id: `${groupId}-v${index}`, status })),
});
const isValePassLine = (line: RefundLineFacts) => line.variantId === VARIANT || line.productId === PRODUCT;
function plan(payload: unknown, units: UnitState[], over: Partial<RefundPlanInput> = {}) {
  return planRefund({ refund: factsFromRefundWebhook(payload), isValePassLine, unitPriceByVariant: new Map([[VARIANT, 35000]]), units, alreadyRefundedUnits: 0, paidUnits: units.length, ...over });
}
const three = [unit('g1', 1), unit('g2', 2), unit('g3', 3)];

describe('fatos do reembolso (formato real do webhook)', () => {
  test('extrai linhas, frete, transações e ajustes; subtotal numérico vira centavos inteiros', () => {
    const facts = factsFromRefundWebhook(refundPayload({ lines: [valeLine(2), otherLine()], shipping: ['22.00', '3.50'], transactions: [{ amount: '722.00', kind: 'refund', status: 'success', currency: 'BRL' }], adjustments: [{ kind: 'shipping_refund' }] }));
    expect(facts).toMatchObject({ refundId: '555001', orderId: '5551234567890', shippingRefundCents: 2550, transactionCount: 1, transactionsCents: 72200, orderAdjustmentCount: 1 });
    expect(facts.lines[0]).toEqual({ lineItemId: '7001', variantId: VARIANT, productId: PRODUCT, quantity: 2, subtotalCents: 70000, unitPriceCents: 35000, restockType: 'return' });
    expect(facts.lines[1]).toMatchObject({ variantId: '111', quantity: 1, subtotalCents: 8000 });
  });

  test('sem frete = 0; transação falha/pendente não conta; valor ilegível vira indefinido', () => {
    expect(factsFromRefundWebhook(refundPayload()).shippingRefundCents).toBe(0);
    expect(factsFromRefundWebhook(refundPayload({ transactions: [{ amount: '50.00', kind: 'refund', status: 'failure' }] })).transactionsCents).toBe(0);
    expect(factsFromRefundWebhook(refundPayload({ transactions: [{ amount: 'abc', kind: 'refund', status: 'success' }] })).transactionsCents).toBeNull();
    expect(factsFromRefundWebhook(refundPayload({ shipping: ['x'] })).shippingRefundCents).toBeNull();
  });

  test('entrada lixo não quebra: ids e linhas indefinidos', () => {
    for (const junk of [null, undefined, 42, 'texto', [], {}]) {
      const facts = factsFromRefundWebhook(junk);
      expect(facts).toMatchObject({ refundId: null, orderId: null, lines: [], transactionCount: 0 });
    }
  });
});

describe('plano: reembolso por UNIDADE (cada unidade = 2 vouchers vinculados)', () => {
  test('reembolso de 1 unidade cancela só a mais nova; as outras ficam intactas', () => {
    expect(plan(refundPayload({ lines: [valeLine(1)] }), three)).toMatchObject({ classification: 'UNITS', refundedUnits: 1, cancelGroupIds: ['g3'], reviewReasons: [], orderFullyRefunded: false });
  });

  test('2 de 3 → as 2 mais novas; 3 de 3 → todas e o pedido fica totalmente reembolsado', () => {
    expect(plan(refundPayload({ lines: [valeLine(2)] }), three).cancelGroupIds).toEqual(['g3', 'g2']);
    expect(plan(refundPayload({ lines: [valeLine(3)] }), three)).toMatchObject({ cancelGroupIds: ['g3', 'g2', 'g1'], orderFullyRefunded: true, reviewReasons: [] });
  });

  test('reembolsos em sequência: o acumulado decide se o pedido está totalmente reembolsado', () => {
    const afterFirst = [unit('g1', 1), unit('g2', 2), unit('g3', 3, ['CANCELLED', 'CANCELLED'])];
    expect(plan(refundPayload({ lines: [valeLine(1)], id: 2 }), afterFirst, { alreadyRefundedUnits: 1, paidUnits: 3 })).toMatchObject({ cancelGroupIds: ['g2'], orderFullyRefunded: false });
    const afterSecond = [unit('g1', 1), unit('g2', 2, ['CANCELLED', 'CANCELLED']), unit('g3', 3, ['CANCELLED', 'CANCELLED'])];
    expect(plan(refundPayload({ lines: [valeLine(1)], id: 3 }), afterSecond, { alreadyRefundedUnits: 2, paidUnits: 3 })).toMatchObject({ cancelGroupIds: ['g1'], orderFullyRefunded: true });
  });

  test('reembolso de FRETE, de outro produto ou cancelamento sem dinheiro NÃO toca nenhum voucher', () => {
    expect(plan(refundPayload({ lines: [], shipping: ['22.00'], transactions: [{ amount: '22.00', kind: 'refund', status: 'success' }], adjustments: [{ kind: 'shipping_refund' }] }), three)).toMatchObject({ classification: 'UNRELATED', cancelGroupIds: [], reviewReasons: [] });
    expect(plan(refundPayload({ lines: [otherLine()], transactions: [{ amount: '80.00', kind: 'refund', status: 'success' }] }), three)).toMatchObject({ classification: 'UNRELATED', cancelGroupIds: [] });
    expect(plan(refundPayload({ lines: [], transactions: [] }), three)).toMatchObject({ classification: 'UNRELATED', cancelGroupIds: [] });
  });

  test('reembolso misto (1 unidade de Valle Pass + outro produto + frete): só a unidade é cancelada', () => {
    const result = plan(refundPayload({ lines: [valeLine(1), otherLine()], shipping: ['10.00'] }), three);
    expect(result).toMatchObject({ classification: 'UNITS', refundedUnits: 1, cancelGroupIds: ['g3'], reviewReasons: [] });
  });

  test('desempate determinístico: mesma data → ordem por id da unidade', () => {
    const same = [unit('ga', 5), unit('gb', 5), unit('gc', 5)];
    expect(plan(refundPayload({ lines: [valeLine(2)] }), same).cancelGroupIds).toEqual(['gc', 'gb']);
    expect(plan(refundPayload({ lines: [valeLine(2)] }), [...same].reverse()).cancelGroupIds).toEqual(['gc', 'gb']);
  });
});

describe('plano: vouchers já usados — fail-closed', () => {
  test('a unidade mais nova foi usada: pula para as intocadas; nunca cancela voucher usado', () => {
    const units = [unit('g1', 1), unit('g2', 2), unit('g3', 3, ['USED', 'ACTIVE'])];
    expect(plan(refundPayload({ lines: [valeLine(1)] }), units)).toMatchObject({ cancelGroupIds: ['g2'], reviewReasons: [], reviewGroupIds: [] });
  });

  test('faltam unidades intocadas: cancela as que pode e o resto vai para REVISÃO com a unidade proposta', () => {
    const units = [unit('g1', 1), unit('g2', 2, ['USED', 'ACTIVE']), unit('g3', 3, ['USED', 'USED'])];
    const result = plan(refundPayload({ lines: [valeLine(3)] }), units);
    expect(result).toMatchObject({ cancelGroupIds: ['g1'], reviewReasons: ['USED_VOUCHERS'], unitsNeedingReview: 2, orderFullyRefunded: true });
    expect(result.reviewGroupIds).toEqual(['g3', 'g2']);
  });

  test('tudo usado: nada é cancelado; tudo vai para revisão', () => {
    const units = [unit('g1', 1, ['USED', 'USED']), unit('g2', 2, ['USED', 'ACTIVE'])];
    expect(plan(refundPayload({ lines: [valeLine(1)] }), units)).toMatchObject({ cancelGroupIds: [], reviewReasons: ['USED_VOUCHERS'], reviewGroupIds: ['g2'], unitsNeedingReview: 1 });
  });

  test('voucher expirado ou unidade cancelada pela metade também é "tocada" (nunca decidida sozinha)', () => {
    expect(standingOf(unit('x', 1, ['ACTIVE', 'EXPIRED']))).toBe('TOUCHED');
    expect(standingOf(unit('x', 1, ['ACTIVE', 'CANCELLED']))).toBe('TOUCHED');
    expect(standingOf(unit('x', 1, ['CANCELLED', 'CANCELLED']))).toBe('CANCELLED');
    expect(standingOf(unit('x', 1, ['ACTIVE', 'ACTIVE']))).toBe('UNUSED');
    expect(standingOf({ groupId: 'vazio', createdAt: new Date(), vouchers: [] })).toBe('TOUCHED');
  });

  test('unidade já cancelada nunca é tocada nem reativada; reembolso maior que as unidades vivas vai para revisão', () => {
    const units = [unit('g1', 1, ['CANCELLED', 'CANCELLED']), unit('g2', 2), unit('g3', 3)];
    expect(plan(refundPayload({ lines: [valeLine(2)] }), units).cancelGroupIds).toEqual(['g3', 'g2']);
    const tooMany = plan(refundPayload({ lines: [valeLine(3)] }), units);
    expect(tooMany).toMatchObject({ cancelGroupIds: [], reviewReasons: expect.arrayContaining(['QUANTITY_EXCEEDS_UNITS']) });
  });
});

describe('plano: valores, quantidades e dados indefinidos — nada automático', () => {
  test('subtotal ou preço diferentes de quantidade × campanha → AMOUNT_MISMATCH; sem cancelar; com proposta', () => {
    const lowSubtotal = plan(refundPayload({ lines: [valeLine(1, { subtotal: 300 })] }), three);
    expect(lowSubtotal).toMatchObject({ cancelGroupIds: [], reviewReasons: ['AMOUNT_MISMATCH'], unitsNeedingReview: 1, reviewGroupIds: ['g3'] });
    const otherPrice = plan(refundPayload({ lines: [valeLine(1, { line_item: { variant_id: Number(VARIANT), product_id: Number(PRODUCT), price: '349.99', quantity: 3 } })] }), three);
    expect(otherPrice.reviewReasons).toContain('AMOUNT_MISMATCH');
    expect(plan(refundPayload({ lines: [valeLine(1, { subtotal: 'abc' })] }), three).reviewReasons).toContain('AMOUNT_MISMATCH');
  });

  test('variante do Valle Pass sem preço configurado → PRICE_UNKNOWN', () => {
    const result = plan(refundPayload({ lines: [valeLine(1)] }), three, { unitPriceByVariant: new Map() });
    expect(result).toMatchObject({ cancelGroupIds: [], reviewReasons: ['PRICE_UNKNOWN'] });
  });

  test('dinheiro devolvido sem produto nem frete que o explique → AMOUNT_ONLY_REFUND (nenhum voucher mexe)', () => {
    expect(plan(refundPayload({ lines: [], transactions: [{ amount: '100.00', kind: 'refund', status: 'success' }] }), three)).toMatchObject({ classification: 'AMOUNT_ONLY', cancelGroupIds: [], reviewReasons: ['AMOUNT_ONLY_REFUND'] });
  });

  test('ids ausentes, quantidade ilegível ou transação ilegível', () => {
    expect(plan(refundPayload({ id: null }), three)).toMatchObject({ cancelGroupIds: [], reviewReasons: ['REFUND_UNDEFINED'] });
    expect(plan(refundPayload({ orderId: null }), three).reviewReasons).toContain('REFUND_UNDEFINED');
    expect(plan(refundPayload({ lines: [valeLine(1, { quantity: 'x' })] }), three).reviewReasons).toContain('REFUND_UNDEFINED');
    expect(plan(refundPayload({ lines: [valeLine(1, { quantity: 0 })] }), three).reviewReasons).toContain('REFUND_UNDEFINED');
    expect(plan(refundPayload({ transactions: [{ amount: 'abc', kind: 'refund', status: 'success' }] }), three)).toMatchObject({ cancelGroupIds: [], reviewReasons: ['TRANSACTION_UNDEFINED'] });
  });

  test('reembolsos acumulados acima das unidades pagas → PAID_UNITS_EXCEEDED (nada automático)', () => {
    const result = plan(refundPayload({ lines: [valeLine(1)] }), three, { alreadyRefundedUnits: 3, paidUnits: 3 });
    expect(result).toMatchObject({ cancelGroupIds: [], reviewReasons: ['PAID_UNITS_EXCEEDED'] });
  });
});

describe('propriedades (estados aleatórios com semente fixa)', () => {
  function lcg(seed: number) {
    let state = seed >>> 0;
    return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  }
  test('invariantes: só cancela unidades intocadas; nunca mais que o reembolsado; sem repetição; determinístico', () => {
    const random = lcg(20261019);
    const pool: VoucherStatus[][] = [['ACTIVE', 'ACTIVE'], ['ACTIVE', 'ACTIVE'], ['USED', 'ACTIVE'], ['USED', 'USED'], ['CANCELLED', 'CANCELLED'], ['ACTIVE', 'EXPIRED'], ['ACTIVE', 'CANCELLED']];
    for (let round = 0; round < 800; round++) {
      const count = 1 + Math.floor(random() * 6);
      const units = Array.from({ length: count }, (_v, i) => unit(`g${i}`, Math.floor(random() * 4), pool[Math.floor(random() * pool.length)]));
      const q = 1 + Math.floor(random() * 5);
      const already = Math.floor(random() * 3);
      const input = plan(refundPayload({ lines: [valeLine(q)] }), units, { alreadyRefundedUnits: already, paidUnits: count });
      const again = plan(refundPayload({ lines: [valeLine(q)] }), [...units].reverse(), { alreadyRefundedUnits: already, paidUnits: count });
      expect(again).toEqual(input); // a ordem de chegada das unidades não muda o resultado
      const byId = new Map(units.map((u) => [u.groupId, u]));
      for (const groupId of input.cancelGroupIds) expect(standingOf(byId.get(groupId)!)).toBe('UNUSED'); // nunca cancela usado/expirado/meio cancelado/já cancelado
      expect(new Set(input.cancelGroupIds).size).toBe(input.cancelGroupIds.length);
      expect(input.cancelGroupIds.length).toBeLessThanOrEqual(q);
      if (input.reviewReasons.length === 0) expect(input.cancelGroupIds.length + input.unitsNeedingReview).toBe(q); // ou cancela ou revisa cada unidade devolvida
    }
  });
});

describe('status do pedido depois do reembolso (hoje parcial vira REFUNDED)', () => {
  test('parcial com unidades restantes segue CONFIRMED; sem restantes ou total vira REFUNDED; sem contagem não adivinha', () => {
    expect(statusAfterRefund({ financialStatus: 'partially_refunded', remainingUnits: 2 })).toBe('CONFIRMED');
    expect(statusAfterRefund({ financialStatus: 'partially_refunded', remainingUnits: 0 })).toBe('REFUNDED');
    expect(statusAfterRefund({ financialStatus: 'partially_refunded', remainingUnits: null })).toBeNull();
    expect(statusAfterRefund({ financialStatus: 'refunded', remainingUnits: 5 })).toBe('REFUNDED');
    expect(statusAfterRefund({ financialStatus: 'paid', remainingUnits: 3 })).toBeNull();
    expect(statusAfterRefund({ financialStatus: null, remainingUnits: 1 })).toBeNull();
  });
});
