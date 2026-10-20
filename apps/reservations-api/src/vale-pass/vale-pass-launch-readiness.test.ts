import { describe, expect, test } from 'vitest';
import { evaluateLaunchReadiness, isReadyToSell, type ReadinessBenefit, type ReadinessInput } from './vale-pass-launch-readiness';

const voucher = (company: 'VALLE_SHOWROOM' | 'VS_BY_CLOSET', amountCents: number): ReadinessBenefit => ({ kind: 'VOUCHER', company, amountCents, discountPercent: null, terms: null, active: true });
const discount: ReadinessBenefit = { kind: 'DISCOUNT', company: null, amountCents: null, discountPercent: 10, terms: 'Condições aprovadas', active: true };
const ready: ReadinessInput = {
  campaign: { amountCents: 35_000, active: true, quantityLimit: null, globalLimit: 1_000, voucherValidFrom: '2026-12-01', voucherValidUntil: '2027-09-30' },
  benefits: [voucher('VALLE_SHOWROOM', 50_000), voucher('VS_BY_CLOSET', 5_000), discount],
  shopifyStock: 1_000,
  hasOpenLot: true,
};
const kinds = (input: ReadinessInput) => Object.fromEntries(evaluateLaunchReadiness(input).map((i) => [i.id, i.kind]));

describe('prontidão da campanha oficial', () => {
  test('configuração completa: só a prorrogação continua pendente (de propósito), então ainda não está "pronta para vender"', () => {
    expect(isReadyToSell(evaluateLaunchReadiness(ready))).toBe(false);
    const pending = Object.entries(kinds(ready)).filter(([, v]) => v !== 'OK').map(([id]) => id);
    expect(pending).toEqual(['extension']);
  });

  test('a campanha de teste atual (limite legado 10, sem benefícios nem validade) tem divergências e pendências', () => {
    const k = kinds({ campaign: { ...ready.campaign, globalLimit: null, quantityLimit: 10, voucherValidFrom: null, voucherValidUntil: null }, benefits: [], shopifyStock: 499, hasOpenLot: false });
    expect(k).toMatchObject({ price: 'OK', 'global-limit': 'DIVERGENCE', 'legacy-limit': 'DIVERGENCE', vouchers: 'DIVERGENCE', discount: 'DIVERGENCE', 'valid-until': 'DIVERGENCE', 'valid-from': 'PENDING', lot: 'PENDING', 'shopify-stock': 'PENDING' });
  });

  test('vouchers duplicados na mesma empresa ou valores trocados são divergência', () => {
    expect(kinds({ ...ready, benefits: [voucher('VALLE_SHOWROOM', 50_000), voucher('VALLE_SHOWROOM', 5_000), discount] }).vouchers).toBe('DIVERGENCE');
    expect(kinds({ ...ready, benefits: [voucher('VALLE_SHOWROOM', 5_000), voucher('VS_BY_CLOSET', 50_000), discount] }).vouchers).toBe('DIVERGENCE');
  });

  test('estoque Shopify acima da meta é divergência; abaixo é ajuste manual pendente; não consultado é pendência', () => {
    expect(kinds({ ...ready, shopifyStock: 1_200 })['shopify-stock']).toBe('DIVERGENCE');
    expect(kinds({ ...ready, shopifyStock: 499 })['shopify-stock']).toBe('PENDING');
    expect(kinds({ ...ready, shopifyStock: null })['shopify-stock']).toBe('PENDING');
  });

  test('desconto sem condições aprovadas é pendência (o sistema nunca interpreta o texto)', () => {
    const noTerms = { ...discount, terms: '  ' };
    expect(kinds({ ...ready, benefits: [voucher('VALLE_SHOWROOM', 50_000), voucher('VS_BY_CLOSET', 5_000), noTerms] })['discount-terms']).toBe('PENDING');
  });
});
