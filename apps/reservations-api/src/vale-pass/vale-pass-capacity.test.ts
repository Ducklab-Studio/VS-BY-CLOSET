import { describe, expect, test } from 'vitest';
import {
  awaitingProcessingCount,
  formatIsoDate,
  globalRemaining,
  parseIsoDate,
  pendingUnitsForCampaign,
  recommendedShopifyStock,
  shortfallsFrom,
  toLotView,
  totalsFrom,
  variantKey,
  type CampaignVariant,
  type PaidOrderRow,
} from './vale-pass-capacity';

describe('totais e saldo global', () => {
  test('consumido = vendido + pendente; cancelado = emitido − vendido', () => {
    expect(totalsFrom({ issued: 19, sold: 15, active: 10, used: 3, expired: 2 }, 0)).toEqual({ issued: 19, cancelled: 4, sold: 15, pending: 0, consumed: 15, active: 10, used: 3, expired: 2 });
    expect(totalsFrom({ issued: 1, sold: 1, active: 1, used: 0, expired: 0 }, 4)).toMatchObject({ sold: 1, pending: 4, consumed: 5 }); // o exemplo da auditoria: 5 pagas, 1 emitida
  });

  test('saldo global: nulo sem limite, nunca negativo, calculado sobre o CONSUMIDO', () => {
    expect(globalRemaining(null, 500)).toBeNull();
    expect(globalRemaining(1000, 400)).toBe(600);
    expect(globalRemaining(1000, 1000)).toBe(0);
    expect(globalRemaining(1000, 1003)).toBe(0); // acima do limite aparece como 0 (e o painel alerta como crítico)
    expect(globalRemaining(10, totalsFrom({ issued: 1, sold: 1, active: 1, used: 0, expired: 0 }, 4).consumed)).toBe(5);
  });
});

describe('visão do lote e estoque recomendado', () => {
  const lot = (quantity: number) => ({ id: 'l', name: 'Lote 1', quantity, status: 'OPEN' as const, openedAt: new Date('2026-11-01T10:00:00Z'), closedAt: null, updatedAt: new Date('2026-11-01T10:00:00Z') });

  test('restante e esgotado, com os pagos aguardando emissão cobrados do lote', () => {
    expect(toLotView(lot(100), 40)).toMatchObject({ sold: 40, pending: 0, remaining: 60, soldOut: false, openedAt: '2026-11-01T10:00:00.000Z', closedAt: null });
    expect(toLotView(lot(100), 40, 10)).toMatchObject({ sold: 40, pending: 10, remaining: 50, soldOut: false });
    expect(toLotView(lot(100), 90, 10)).toMatchObject({ remaining: 0, soldOut: true }); // vendido + pago esperando = lote cheio
    expect(toLotView(lot(100), 103)).toMatchObject({ remaining: 0, soldOut: true }); // nunca negativo
  });

  test('estoque recomendado na Shopify: saldo do lote aberto (já sem pendentes), limitado ao saldo global; sem lote aberto = 0', () => {
    const open = toLotView(lot(200), 50, 10); // restam 140
    expect(recommendedShopifyStock(open, null)).toBe(140);
    expect(recommendedShopifyStock(open, 900)).toBe(140);
    expect(recommendedShopifyStock(open, 80)).toBe(80);
    expect(recommendedShopifyStock(null, 900)).toBe(0);
  });
});

const ORDER_DEFAULTS = { orderName: null, campaignIds: [] as string[], processed: true, statusChangedAt: new Date('2026-11-01T10:00:00Z') };
const order = (over: Partial<PaidOrderRow> & Pick<PaidOrderRow, 'orderId' | 'quantity' | 'issuedUnits'>): PaidOrderRow => ({ ...ORDER_DEFAULTS, ...over });
const A: CampaignVariant = { campaignId: 'camp-a', variant: 'gid://shopify/ProductVariant/111' };
const B: CampaignVariant = { campaignId: 'camp-b', variant: '222' };

describe('unidades pagas aguardando emissão por campanha (função pura)', () => {
  test('exemplo da auditoria: pedido de 3 com 1 emitida + pedido de 2 sem emissão = 4 pendentes (5 consumidas com a emitida)', () => {
    const orders = [
      order({ orderId: 'o1', quantity: 3, issuedUnits: 1, campaignIds: ['camp-a'] }),
      order({ orderId: 'o2', quantity: 2, issuedUnits: 0, processed: false }),
    ];
    const variants = new Map([['o2', ['111']]]);
    expect(pendingUnitsForCampaign('camp-a', orders, [A], variants)).toBe(4);
  });

  test('só conta o que falta: pedido completo ou acima não gera pendência', () => {
    expect(pendingUnitsForCampaign('camp-a', [order({ orderId: 'o', quantity: 2, issuedUnits: 2, campaignIds: ['camp-a'] })], [A], new Map())).toBe(0);
    expect(pendingUnitsForCampaign('camp-a', [order({ orderId: 'o', quantity: 2, issuedUnits: 5, campaignIds: ['camp-a'] })], [A], new Map())).toBe(0);
  });

  test('emissão parcial → total: a pendência diminui exatamente o que foi emitido (sem contar duas vezes)', () => {
    const consumed = (issued: number) => issued + pendingUnitsForCampaign('camp-a', [order({ orderId: 'o', quantity: 5, issuedUnits: issued, campaignIds: issued > 0 ? ['camp-a'] : [] })], [A], new Map([['o', ['111']]]));
    expect([0, 1, 2, 3, 4, 5].map(consumed)).toEqual([5, 5, 5, 5, 5, 5]);
  });

  test('atribuição: pelos vales existentes, pela variante comprada ou, sem como saber, a todas as campanhas (lado seguro)', () => {
    const campaigns = [A, B];
    const bought = new Map([['o-b', ['222']], ['o-a', ['111']], ['o-ab', ['111', '222']]]);
    const orders = [
      order({ orderId: 'o-b', quantity: 2, issuedUnits: 0 }),
      order({ orderId: 'o-a', quantity: 1, issuedUnits: 0 }),
      order({ orderId: 'o-ab', quantity: 4, issuedUnits: 0 }),
      order({ orderId: 'o-only-b-voucher', quantity: 3, issuedUnits: 1, campaignIds: ['camp-b'] }),
      order({ orderId: 'o-unknown', quantity: 7, issuedUnits: 0 }), // sem payload: sem como saber a variante
    ];
    // A: o-a (1) + o-ab (4) + o-unknown (7); B: o-b (2) + o-ab (4) + o-only-b-voucher (2) + o-unknown (7)
    expect(pendingUnitsForCampaign('camp-a', orders, campaigns, bought)).toBe(12);
    expect(pendingUnitsForCampaign('camp-b', orders, campaigns, bought)).toBe(15);
  });

  test('variante em GID ou em número é a mesma', () => {
    expect(variantKey('gid://shopify/ProductVariant/49174518595684')).toBe('49174518595684');
    expect(variantKey('49174518595684')).toBe('49174518595684');
    expect(pendingUnitsForCampaign('camp-a', [order({ orderId: 'o', quantity: 1, issuedUnits: 0 })], [A, B], new Map([['o', ['111']]]))).toBe(1);
    expect(pendingUnitsForCampaign('camp-b', [order({ orderId: 'o', quantity: 1, issuedUnits: 0 })], [A, B], new Map([['o', ['111']]]))).toBe(0);
  });
});

describe('alertas a partir dos pedidos pagos', () => {
  test('falta emitir só aparece para pedido JÁ processado; sem processamento há mais de 15 min é outro alerta', () => {
    const now = new Date('2026-11-01T12:00:00Z');
    const orders = [
      order({ orderId: 'short', quantity: 3, issuedUnits: 1, campaignIds: ['camp-a'] }),
      order({ orderId: 'old', quantity: 1, issuedUnits: 0, processed: false, statusChangedAt: new Date('2026-11-01T11:00:00Z') }),
      order({ orderId: 'fresh', quantity: 1, issuedUnits: 0, processed: false, statusChangedAt: new Date('2026-11-01T11:55:00Z') }),
    ];
    expect(shortfallsFrom(orders)).toEqual([{ orderId: 'short', orderName: null, quantity: 3, issued: 1, absorbed: 0, missing: 2 }]);
    expect(awaitingProcessingCount(orders, now)).toBe(1);
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

  test('pendência após reembolso antes da emissão: pagas − emitidas − devolvidas = elegíveis (unidade devolvida não conta como emitida nem como elegível)', () => {
    const rows = [order({ orderId: 'r', quantity: 3, issuedUnits: 2, absorbedUnits: 1, processed: true })];
    expect(shortfallsFrom(rows)).toEqual([{ orderId: 'r', orderName: null, quantity: 3, issued: 1, absorbed: 1, missing: 1 }]);
    expect(shortfallsFrom([order({ orderId: 'z', quantity: 3, issuedUnits: 3, absorbedUnits: 2, processed: true })])).toEqual([]);
  });
});
