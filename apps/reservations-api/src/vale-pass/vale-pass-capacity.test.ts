import { describe, expect, test } from 'vitest';
import { formatIsoDate, globalRemaining, parseIsoDate, recommendedShopifyStock, toLotView, totalsFromStatusCounts } from './vale-pass-capacity';

describe('totais e saldo global', () => {
  test('vendido = emitido − cancelado; usado e expirado continuam contando', () => {
    expect(totalsFromStatusCounts({ ACTIVE: 10, USED: 3, EXPIRED: 2, CANCELLED: 4 })).toEqual({ issued: 19, cancelled: 4, sold: 15, active: 10, used: 3, expired: 2 });
    expect(totalsFromStatusCounts({})).toEqual({ issued: 0, cancelled: 0, sold: 0, active: 0, used: 0, expired: 0 });
  });

  test('saldo global: nulo sem limite, nunca negativo', () => {
    expect(globalRemaining(null, 500)).toBeNull();
    expect(globalRemaining(1000, 400)).toBe(600);
    expect(globalRemaining(1000, 1000)).toBe(0);
    expect(globalRemaining(1000, 1003)).toBe(0); // vendido acima do limite aparece como 0 (e o painel alerta)
  });
});

describe('visão do lote e estoque recomendado', () => {
  const lot = (quantity: number) => ({ id: 'l', name: 'Lote 1', quantity, status: 'OPEN' as const, openedAt: new Date('2026-11-01T10:00:00Z'), closedAt: null, updatedAt: new Date('2026-11-01T10:00:00Z') });

  test('restante e esgotado', () => {
    expect(toLotView(lot(100), 40)).toMatchObject({ sold: 40, remaining: 60, soldOut: false, openedAt: '2026-11-01T10:00:00.000Z', closedAt: null });
    expect(toLotView(lot(100), 100)).toMatchObject({ remaining: 0, soldOut: true });
    expect(toLotView(lot(100), 103)).toMatchObject({ remaining: 0, soldOut: true }); // nunca negativo
  });

  test('estoque recomendado na Shopify: saldo do lote aberto, limitado ao saldo global; sem lote aberto = 0', () => {
    const open = toLotView(lot(200), 50); // restam 150
    expect(recommendedShopifyStock(open, null)).toBe(150);
    expect(recommendedShopifyStock(open, 900)).toBe(150);
    expect(recommendedShopifyStock(open, 80)).toBe(80);
    expect(recommendedShopifyStock(null, 900)).toBe(0);
  });
});

describe('datas', () => {
  test('parseIsoDate é estrito', () => {
    expect(parseIsoDate('2027-12-31')?.toISOString()).toBe('2027-12-31T00:00:00.000Z');
    for (const bad of ['2027-02-29', '2027-13-01', '2027-1-1', ' 2027-01-01', '2027-01-01T00:00:00Z', '', null, undefined, 20270101, '1999-12-31', '2101-01-01']) {
      expect(parseIsoDate(bad), String(bad)).toBeNull();
    }
    expect(parseIsoDate('2028-02-29')).not.toBeNull(); // bissexto
  });

  test('formatIsoDate ida e volta', () => {
    expect(formatIsoDate(parseIsoDate('2027-01-01'))).toBe('2027-01-01');
    expect(formatIsoDate(null)).toBeNull();
  });
});
