import { describe, expect, test } from 'vitest';
import { DEFAULT_VALIDITY_TIMEZONE, resolveValidityTimezone, voucherWindow, zonedMidnightUtc } from './vale-pass-validity';
import { MAX_BENEFITS_PER_CAMPAIGN, validateBenefits, type BenefitInput } from './vale-pass-benefits';

describe('validade dos vouchers (fuso provisório)', () => {
  test('padrão é America/Sao_Paulo e o ambiente pode trocar; fuso inexistente falha claro', () => {
    expect(resolveValidityTimezone({})).toBe(DEFAULT_VALIDITY_TIMEZONE);
    expect(resolveValidityTimezone({ VALE_PASS_VALIDITY_TIMEZONE: ' America/Manaus ' })).toBe('America/Manaus');
    expect(() => resolveValidityTimezone({ VALE_PASS_VALIDITY_TIMEZONE: 'Marte/Olimpo' })).toThrow(RangeError);
  });

  test('"durante 2027" em São Paulo (UTC−3): vale a partir de 01/01/2027 00:00 e expira em 01/01/2028 00:00 locais', () => {
    const w = voucherWindow('2027-01-01', '2027-12-31', 'America/Sao_Paulo');
    expect(w.validFrom.toISOString()).toBe('2027-01-01T03:00:00.000Z');
    expect(w.expiresAt.toISOString()).toBe('2028-01-01T03:00:00.000Z');
  });

  test('o último dia vale por inteiro (expira à meia-noite do dia seguinte), inclusive em fim de mês/ano bissexto', () => {
    expect(voucherWindow('2028-02-28', '2028-02-29', 'UTC').expiresAt.toISOString()).toBe('2028-03-01T00:00:00.000Z');
    expect(voucherWindow('2027-06-10', '2027-06-10', 'UTC')).toEqual({ validFrom: new Date('2027-06-10T00:00:00Z'), expiresAt: new Date('2027-06-11T00:00:00Z') });
  });

  test('fusos com horário de verão resolvem o deslocamento do dia, não o de hoje', () => {
    expect(zonedMidnightUtc('2027-01-15', 'America/Santiago').toISOString()).toBe('2027-01-15T03:00:00.000Z'); // verão: UTC−3
    expect(zonedMidnightUtc('2027-07-15', 'America/Santiago').toISOString()).toBe('2027-07-15T04:00:00.000Z'); // inverno: UTC−4
    expect(zonedMidnightUtc('2027-01-01', 'Asia/Kolkata').toISOString()).toBe('2026-12-31T18:30:00.000Z');
  });

  test('entradas inválidas são recusadas', () => {
    expect(() => zonedMidnightUtc('01/01/2027', 'UTC')).toThrow(RangeError);
    expect(() => voucherWindow('2027-12-31', '2027-01-01', 'UTC')).toThrow(/anterior/);
  });
});

describe('validação da configuração de benefícios', () => {
  const showroom: BenefitInput = { code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000 };
  const closet: BenefitInput = { code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000 };
  const discount: BenefitInput = { code: 'desconto_passeios', kind: 'DISCOUNT', label: '10% em passeios', discountPercent: 10, terms: 'Condições a definir' };

  test('a configuração do Valle Pass 2027 é válida', () => {
    expect(validateBenefits([showroom, closet, discount])).toEqual([]);
  });

  test('voucher exige empresa e valor positivo; desconto não tem empresa nem valor', () => {
    expect(validateBenefits([{ ...showroom, company: null }]).join(' ')).toMatch(/empresa/);
    expect(validateBenefits([{ ...showroom, amountCents: 0 }]).length).toBeGreaterThan(0);
    expect(validateBenefits([{ ...showroom, amountCents: 1.5 }]).length).toBeGreaterThan(0);
    expect(validateBenefits([{ ...discount, company: 'VS_BY_CLOSET' }]).join(' ')).toMatch(/não pertence a uma empresa/);
    expect(validateBenefits([{ ...discount, amountCents: 100 }]).length).toBeGreaterThan(0);
    expect(validateBenefits([{ ...discount, discountPercent: 0 }]).length).toBeGreaterThan(0);
    expect(validateBenefits([{ ...discount, discountPercent: 101 }]).length).toBeGreaterThan(0);
  });

  test('código válido e único, um voucher por empresa, limite de itens, rótulo obrigatório', () => {
    expect(validateBenefits([{ ...showroom, code: 'Código Ruim' }]).length).toBeGreaterThan(0);
    expect(validateBenefits([showroom, { ...closet, code: showroom.code }]).join(' ')).toMatch(/repetid|único/i);
    expect(validateBenefits([showroom, { ...closet, company: 'VALLE_SHOWROOM' }]).join(' ')).toMatch(/um por empresa/);
    expect(validateBenefits([{ ...showroom, label: '  ' }]).length).toBeGreaterThan(0);
    const many = Array.from({ length: MAX_BENEFITS_PER_CAMPAIGN + 1 }, (_, i) => ({ ...discount, code: `d${i}` }));
    expect(validateBenefits(many).length).toBeGreaterThan(0);
  });
});
