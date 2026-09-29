import { describe, expect, test } from 'vitest';
import {
  KNOWN_VALE_PASS_PRODUCT_ID,
  KNOWN_VALE_PASS_VARIANT_ID,
  canReplaceValePassOrderStatus,
  compareFreshness,
  deriveValePassOrderStatus,
  valePassUnits,
} from './vale-pass-order-status';

const state = (financialStatus: string | null, cancelledAt: string | null = null, cancelReason: string | null = null) => ({ financialStatus, cancelledAt, cancelReason });

describe('deriveValePassOrderStatus — status do pedido a partir da Shopify', () => {
  test.each([
    ['pending', 'PENDING'],
    ['authorized', 'PENDING'],
    ['partially_paid', 'PENDING'],
    [null, 'PENDING'],
    ['PAID', 'CONFIRMED'],
    ['paid', 'CONFIRMED'],
    ['expired', 'EXPIRED'],
    ['voided', 'DECLINED'],
    ['refunded', 'REFUNDED'],
    ['partially_refunded', 'REFUNDED'],
  ] as const)('%s sem cancelamento → %s', (financial, expected) => {
    expect(deriveValePassOrderStatus(state(financial))).toBe(expected);
  });

  test('pendente nunca é tratado como pago', () => {
    for (const financial of ['pending', 'authorized', 'partially_paid', 'unpaid', '']) {
      expect(deriveValePassOrderStatus(state(financial))).not.toBe('CONFIRMED');
    }
  });

  test('cancelado: expirado continua EXPIRED, recusado vira DECLINED, o resto CANCELLED — nunca CONFIRMED', () => {
    const at = '2026-09-20T10:00:00Z';
    expect(deriveValePassOrderStatus(state('expired', at, 'other'))).toBe('EXPIRED');
    expect(deriveValePassOrderStatus(state('pending', at, 'declined'))).toBe('DECLINED');
    expect(deriveValePassOrderStatus(state('voided', at, 'other'))).toBe('DECLINED');
    expect(deriveValePassOrderStatus(state('pending', at, 'customer'))).toBe('CANCELLED');
    expect(deriveValePassOrderStatus(state('paid', at, 'customer'))).toBe('CANCELLED');
    expect(deriveValePassOrderStatus(state('refunded', at, 'customer'))).toBe('CANCELLED');
  });
});

describe('canReplaceValePassOrderStatus — fora de ordem e repetição', () => {
  test('estado mais antigo nunca substitui o aplicado', () => {
    expect(canReplaceValePassOrderStatus('PENDING', 'CONFIRMED', 'older')).toBe(false);
    expect(canReplaceValePassOrderStatus('CONFIRMED', 'CANCELLED', 'older')).toBe(false);
  });

  test('nunca volta para PENDING', () => {
    for (const freshness of ['newer', 'same', 'unknown'] as const) {
      expect(canReplaceValePassOrderStatus('CONFIRMED', 'PENDING', freshness)).toBe(false);
      expect(canReplaceValePassOrderStatus('EXPIRED', 'PENDING', freshness)).toBe(false);
    }
  });

  test('estado mais novo da Shopify vale: confirmado que expira deixa de estar confirmado', () => {
    expect(canReplaceValePassOrderStatus('CONFIRMED', 'EXPIRED', 'newer')).toBe(true);
    expect(canReplaceValePassOrderStatus('PENDING', 'CONFIRMED', 'newer')).toBe(true);
    expect(canReplaceValePassOrderStatus('EXPIRED', 'CONFIRMED', 'newer')).toBe(true);
  });

  test('sem data para comparar: só avança (pendente → pago → final), nunca recua', () => {
    expect(canReplaceValePassOrderStatus('PENDING', 'CONFIRMED', 'unknown')).toBe(true);
    expect(canReplaceValePassOrderStatus('CONFIRMED', 'REFUNDED', 'same')).toBe(true);
    expect(canReplaceValePassOrderStatus('EXPIRED', 'CONFIRMED', 'unknown')).toBe(false);
    expect(canReplaceValePassOrderStatus('CANCELLED', 'REFUNDED', 'same')).toBe(false);
  });

  test('compareFreshness', () => {
    const a = new Date('2026-09-20T10:00:00Z');
    const b = new Date('2026-09-20T10:05:00Z');
    expect(compareFreshness(a, b)).toBe('newer');
    expect(compareFreshness(b, a)).toBe('older');
    expect(compareFreshness(a, new Date(a))).toBe('same');
    expect(compareFreshness(null, a)).toBe('unknown');
    expect(compareFreshness(a, null)).toBe('unknown');
  });
});

describe('valePassUnits — só pedidos de Valle Pass são importados', () => {
  test('variante conhecida, produto conhecido (variante nova) e variante de campanha contam', () => {
    expect(valePassUnits([{ variantId: Number(KNOWN_VALE_PASS_VARIANT_ID), quantity: 2 }], [])).toBe(2);
    expect(valePassUnits([{ variantId: '123', productId: `gid://shopify/Product/${KNOWN_VALE_PASS_PRODUCT_ID}`, quantity: 1 }], [])).toBe(1);
    expect(valePassUnits([{ variantId: 'gid://shopify/ProductVariant/555', quantity: 3 }], ['555'])).toBe(3);
  });

  test('pedido de aluguel ou de outro produto → 0 (não importado)', () => {
    expect(valePassUnits([{ variantId: 777, productId: 888, quantity: 1 }], ['555'])).toBe(0);
    expect(valePassUnits([], ['555'])).toBe(0);
    expect(valePassUnits([{ variantId: null, productId: null, quantity: 1 }], ['555'])).toBe(0);
  });

  test('pedido misto conta só as linhas de Valle Pass; quantidade inválida é ignorada', () => {
    expect(valePassUnits([{ variantId: 555, quantity: 1 }, { variantId: 777, quantity: 4 }, { variantId: 555, quantity: 0 }], ['555'])).toBe(1);
  });
});
