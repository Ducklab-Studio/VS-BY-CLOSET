import { describe, expect, test } from 'vitest';
import { planCampaignUpdate, type CampaignCurrent, type CampaignUpdateContext } from './vale-pass-campaign-update';

const CURRENT: CampaignCurrent = {
  name: 'Teste Valle Pass',
  amountCents: 35_000,
  validityDays: 30,
  quantityLimit: 10,
  globalLimit: null,
  voucherValidFrom: null,
  voucherValidUntil: null,
  salesEndDate: null,
};
const NO_SALES: CampaignUpdateContext = { issued: 0, sold: 0, openLot: null };

const ok = (input: Parameters<typeof planCampaignUpdate>[1], context = NO_SALES, current = CURRENT) => {
  const plan = planCampaignUpdate(current, input, context);
  if (!plan.ok) throw new Error(`esperava ok: ${plan.errors.join(' | ')}`);
  return plan;
};
const errors = (input: Parameters<typeof planCampaignUpdate>[1], context = NO_SALES, current = CURRENT) => {
  const plan = planCampaignUpdate(current, input, context);
  if (plan.ok) throw new Error('esperava erro');
  return plan.errors;
};

describe('planCampaignUpdate — só muda o que foi pedido', () => {
  test('campo ausente não muda nada; valor igual ao atual não conta como mudança', () => {
    expect(ok({}).changed).toEqual([]);
    expect(ok({ name: 'Teste Valle Pass', amountCents: 35_000, quantityLimit: 10 }).changed).toEqual([]);
  });

  test('mudanças registram antes e depois, só dos campos alterados', () => {
    const plan = ok({ name: '  Valle Pass 2027  ', amountCents: 35_000, validityDays: 365, globalLimit: 1000, quantityLimit: null });
    expect(plan.changed).toEqual(['name', 'validityDays', 'quantityLimit', 'globalLimit']);
    expect(plan.before).toEqual({ name: 'Teste Valle Pass', validityDays: 30, quantityLimit: 10, globalLimit: null });
    expect(plan.after).toEqual({ name: 'Valle Pass 2027', validityDays: 365, quantityLimit: null, globalLimit: 1000 });
    expect(plan.data).toMatchObject({ name: 'Valle Pass 2027', validityDays: 365, quantityLimit: null, globalLimit: 1000 });
    expect(plan.data).not.toHaveProperty('amountCents');
  });

  test('nome, valor e validade em dias nunca ficam vazios', () => {
    expect(errors({ name: '   ' })).toHaveLength(1);
    expect(errors({ name: null })).toHaveLength(1);
    expect(errors({ amountCents: null })).toHaveLength(1);
    expect(errors({ validityDays: null })).toHaveLength(1);
  });
});

describe('limite legado × limite global (nunca confundidos)', () => {
  test('o limite legado não pode ficar abaixo do já emitido (inclui cancelados); vazio remove', () => {
    expect(errors({ quantityLimit: 5 }, { issued: 7, sold: 6, openLot: null })[0]).toMatch(/próximo pagamento ficaria sem passe/);
    expect(ok({ quantityLimit: 7 }, { issued: 7, sold: 6, openLot: null }).changed).toEqual(['quantityLimit']);
    expect(ok({ quantityLimit: null }, { issued: 70, sold: 60, openLot: null }).after).toEqual({ quantityLimit: null });
  });

  test('o limite global não pode ficar abaixo do vendido (cancelados não contam)', () => {
    expect(errors({ globalLimit: 5 }, { issued: 8, sold: 6, openLot: null })[0]).toMatch(/menor que os 6 passes já vendidos/);
    expect(ok({ globalLimit: 6 }, { issued: 8, sold: 6, openLot: null }).changed).toEqual(['globalLimit']);
  });

  test('o limite global do Valle Pass 2027 não passa de 1.000 unidades', () => {
    expect(errors({ globalLimit: 1001 })).toEqual(['O limite global do Valle Pass 2027 não pode passar de 1000 unidades.']);
    expect(ok({ globalLimit: 1000 }).data.globalLimit).toBe(1000);
  });

  test('o limite global precisa comportar o saldo do lote aberto', () => {
    const context: CampaignUpdateContext = { issued: 40, sold: 40, openLot: { quantity: 100, sold: 30 } };
    // vendido 40 + restante do lote 70 = 110
    expect(errors({ globalLimit: 109 }, context)[0]).toMatch(/não comporta o saldo do lote aberto.*= 110/);
    expect(ok({ globalLimit: 110 }, context).changed).toEqual(['globalLimit']);
  });
});

describe('validade fixa dos vouchers e fim das vendas', () => {
  test('2027 inteiro é aceito; as duas datas juntas ou nenhuma; início ≤ fim; calendário real', () => {
    const plan = ok({ voucherValidFrom: '2027-01-01', voucherValidUntil: '2027-12-31' });
    expect(plan.after).toEqual({ voucherValidFrom: '2027-01-01', voucherValidUntil: '2027-12-31' });
    expect(errors({ voucherValidFrom: '2027-01-01' })[0]).toMatch(/as duas datas/);
    expect(errors({ voucherValidFrom: '2027-12-31', voucherValidUntil: '2027-01-01' })[0]).toMatch(/não pode ser depois/);
    for (const bad of ['2027-02-30', '2027-13-01', '27-01-01', '2027/01/01', '1999-01-01', '2101-01-01']) {
      expect(errors({ voucherValidFrom: bad, voucherValidUntil: '2027-12-31' })[0], bad).toMatch(/inválida/);
    }
  });

  test('alterar só uma das datas usa a outra do estado atual; limpar as duas remove a janela', () => {
    const withWindow: CampaignCurrent = { ...CURRENT, voucherValidFrom: new Date('2027-01-01T00:00:00Z'), voucherValidUntil: new Date('2027-12-31T00:00:00Z') };
    expect(ok({ voucherValidUntil: '2027-06-30' }, NO_SALES, withWindow).after).toEqual({ voucherValidUntil: '2027-06-30' });
    expect(errors({ voucherValidFrom: '2028-01-01' }, NO_SALES, withWindow)[0]).toMatch(/não pode ser depois/);
    expect(ok({ voucherValidFrom: null, voucherValidUntil: null }, NO_SALES, withWindow).after).toEqual({ voucherValidFrom: null, voucherValidUntil: null });
    expect(errors({ voucherValidFrom: null }, NO_SALES, withWindow)[0]).toMatch(/as duas datas/);
  });

  test('o fim das vendas é informativo: aceita qualquer data real (o ano ainda não foi confirmado) e pode ser limpo', () => {
    expect(ok({ salesEndDate: '2027-05-30' }).after).toEqual({ salesEndDate: '2027-05-30' });
    expect(ok({ salesEndDate: '2026-05-30' }).after).toEqual({ salesEndDate: '2026-05-30' });
    expect(errors({ salesEndDate: '2027-02-31' })).toEqual(['Data de encerramento das vendas inválida.']);
    const withEnd: CampaignCurrent = { ...CURRENT, salesEndDate: new Date('2027-05-30T00:00:00Z') };
    expect(ok({ salesEndDate: null }, NO_SALES, withEnd).after).toEqual({ salesEndDate: null });
  });

  test('todos os erros vêm juntos', () => {
    expect(errors({ name: '', quantityLimit: 1, salesEndDate: 'x' }, { issued: 5, sold: 5, openLot: null })).toHaveLength(3);
  });
});
