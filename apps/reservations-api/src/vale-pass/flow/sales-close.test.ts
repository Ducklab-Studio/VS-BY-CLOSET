import { describe, expect, test } from 'vitest';
import { evaluateSalesClose, salesCloseInstant, SALES_CLOSED, SALES_ORDER_DATE_UNKNOWN } from './sales-close';
import { envFlowFlags } from './flow-flags';

const END = new Date('2027-05-31T00:00:00.000Z');
const TZ = 'America/Sao_Paulo';

describe('encerramento das vendas (função pura)', () => {
  test('o corte é 00:00 do dia seguinte no fuso do negócio (03:00Z em Brasília)', () => {
    expect(salesCloseInstant(END, TZ).toISOString()).toBe('2027-06-01T03:00:00.000Z');
  });
  test('desligada ou sem data: nunca retém', () => {
    const late = new Date('2030-01-01T00:00:00Z');
    expect(evaluateSalesClose({ enabled: false, salesEndDate: END, orderCreatedAt: late, timeZone: TZ })).toEqual({ ok: true });
    expect(evaluateSalesClose({ enabled: true, salesEndDate: null, orderCreatedAt: late, timeZone: TZ })).toEqual({ ok: true });
  });
  test('fronteira exata', () => {
    expect(evaluateSalesClose({ enabled: true, salesEndDate: END, orderCreatedAt: new Date('2027-06-01T02:59:59.999Z'), timeZone: TZ })).toEqual({ ok: true });
    expect(evaluateSalesClose({ enabled: true, salesEndDate: END, orderCreatedAt: new Date('2027-06-01T03:00:00.000Z'), timeZone: TZ })).toMatchObject({ ok: false, code: SALES_CLOSED });
  });
  test('data ausente ou inválida é ambígua: revisão, nunca emissão às cegas', () => {
    expect(evaluateSalesClose({ enabled: true, salesEndDate: END, orderCreatedAt: null, timeZone: TZ })).toMatchObject({ ok: false, code: SALES_ORDER_DATE_UNKNOWN });
    expect(evaluateSalesClose({ enabled: true, salesEndDate: END, orderCreatedAt: new Date('invalid'), timeZone: TZ })).toMatchObject({ ok: false, code: SALES_ORDER_DATE_UNKNOWN });
  });
  test('a chave vem do ambiente e é DESLIGADA por padrão (só "on" liga)', () => {
    expect(envFlowFlags({}).salesCloseGuard?.()).toBe(false);
    expect(envFlowFlags({ VALE_PASS_SALES_CLOSE_GUARD: 'true' }).salesCloseGuard?.()).toBe(false);
    expect(envFlowFlags({ VALE_PASS_SALES_CLOSE_GUARD: 'on' }).salesCloseGuard?.()).toBe(true);
  });
});
