import { describe, expect, test } from 'vitest';
import { VALE_PASS_GLOBAL_LIMIT, VALE_PASS_LOT_UNITS } from './vale-pass-capacity';
import { buildLaunchChecklist, type ChecklistInput } from './vale-pass-launch-checklist';
import { evaluateLaunchReadiness, OFFICIAL_SPEC, type ReadinessBenefit } from './vale-pass-launch-readiness';

// Regressão das decisões do Anderson (26 e 27/10/2026): só o que está CONFIRMADO vira regra; o resto continua pendente.

const voucher = (company: 'VALLE_SHOWROOM' | 'VS_BY_CLOSET', amountCents: number): ReadinessBenefit => ({ kind: 'VOUCHER', company, amountCents, discountPercent: null, terms: null, active: true });
const discountNoTerms: ReadinessBenefit = { kind: 'DISCOUNT', company: null, amountCents: null, discountPercent: 10, terms: null, active: true };
const campaign = { amountCents: 35_000, active: true, quantityLimit: null, globalLimit: 1_000, voucherValidFrom: '2027-04-01', voucherValidUntil: '2027-10-15', salesEndDate: '2027-05-31' };
const input: ChecklistInput = {
  campaign,
  benefits: [voucher('VALLE_SHOWROOM', 50_000), voucher('VS_BY_CLOSET', 5_000), discountNoTerms],
  hasOpenLot: false,
  shopifyStock: null,
  capacity: { openHolds: 0, refundReviews: 0, cancellationAlerts: 0, paidOrdersWithoutVoucher: 0 },
  flags: { twoVoucher: true, autoVerify: false, emailMode: 'dry-run', emailDomainVerified: true, alertsMode: 'off' },
};
const ref = { id: 'c1', name: 'Valle Pass 2027' };
const byId = <T extends { id: string }>(items: readonly T[]) => Object.fromEntries(items.map((i) => [i.id, i]));

describe('decisões confirmadas do Anderson', () => {
  test('a especificação oficial bate com as constantes de capacidade: R$ 350, 1.000 passes, lotes de 100 (10 lotes)', () => {
    expect(OFFICIAL_SPEC.amountCents).toBe(35_000);
    expect(OFFICIAL_SPEC.globalLimit).toBe(VALE_PASS_GLOBAL_LIMIT);
    expect(OFFICIAL_SPEC.lotUnits).toBe(VALE_PASS_LOT_UNITS);
    expect(OFFICIAL_SPEC.globalLimit / OFFICIAL_SPEC.lotUnits).toBe(10);
  });

  test('validade 01/04/2027 a 15/10/2027, encerramento 31/05/2027 e dois vouchers independentes (R$ 500 e R$ 50)', () => {
    expect(OFFICIAL_SPEC.voucherValidFrom).toBe('2027-04-01');
    expect(OFFICIAL_SPEC.voucherValidUntil).toBe('2027-10-15');
    expect(OFFICIAL_SPEC.salesEndLastDay).toBe('2027-05-31');
    expect(OFFICIAL_SPEC.vouchers).toEqual([
      { company: 'VALLE_SHOWROOM', amountCents: 50_000 },
      { company: 'VS_BY_CLOSET', amountCents: 5_000 },
    ]);
  });

  test('os 10% são manuais, sobre o valor final do orçamento, só em passeios e transfers da Valle Experience; nada além disso é definido', () => {
    expect(OFFICIAL_SPEC.discountPercent).toBe(10);
    expect(OFFICIAL_SPEC.discountApplication).toBe('manual');
    expect(OFFICIAL_SPEC.discountBase).toBe('valor final do orçamento');
    expect(OFFICIAL_SPEC.discountScope).toBe('passeios e transfers da Valle Experience');
    // Nenhuma regra indefinida foi inventada na especificação.
    for (const chave of ['frequency', 'perUse', 'people', 'maxUses', 'eligibility', 'refundEffect']) expect(OFFICIAL_SPEC).not.toHaveProperty(chave);
    const termos = evaluateLaunchReadiness({ campaign, benefits: input.benefits, shopifyStock: null, hasOpenLot: false }).find((i) => i.id === 'discount-terms');
    expect(termos?.kind).toBe('PENDING');
    expect(termos?.message).toMatch(/manualmente/);
    expect(termos?.message).toMatch(/Indefinido \(não presumir\)/);
  });

  test('encerramento: a mensagem registra a decisão (31/05/2027 ou esgotar as 1.000, o que vier primeiro) sem encerrar nada nem aprovar sozinho', () => {
    const list = buildLaunchChecklist(ref, input);
    const k = byId(list.items);
    expect(k['sales-end'].status).toBe('PENDING');
    expect(k['sales-end'].message).toMatch(/31\/05\/2027/);
    expect(k['sales-end'].message).toMatch(/esgotar as 1\.000 unidades/);
    expect(k['sales-end'].message).toMatch(/não encerra nada sozinho/);
    expect(k['sales-end'].message).not.toMatch(/ainda não a confirmou/);
  });

  test('titular das retenções é o Anderson, mas substituto e canal seguem indefinidos: o item continua pendente', () => {
    const k = byId(buildLaunchChecklist(ref, input).items);
    expect(k['retention-owner'].status).toBe('PENDING');
    expect(k['retention-owner'].message).toMatch(/Titular: Anderson/);
    expect(k['retention-owner'].message).toMatch(/Substituto e canal de aviso ainda não definidos/);
  });

  test('reembolso informado fica REGISTRADO, mas não aprovado nem automatizado: continua pendente de parecer jurídico', () => {
    const k = byId(buildLaunchChecklist(ref, input).items);
    expect(k['refund-policy'].status).toBe('PENDING');
    expect(k['refund-policy'].owner).toBe('ANDERSON');
    expect(k['refund-policy'].nature).toBe('JURIDICO');
    expect(k['refund-policy'].message).toMatch(/R\$ 350,00 em até 3 dias úteis, pela mesma forma de pagamento/);
    expect(k['refund-policy'].message).toMatch(/NÃO automatizada nem aprovada/);
    expect(k['refund-policy'].message).toMatch(/parecer jurídico/);
    expect(k['legal-review'].status).toBe('PENDING');
  });

  test('nada comercial ou jurídico vira aprovado e as vendas continuam bloqueadas', () => {
    const list = buildLaunchChecklist(ref, input);
    const k = byId(list.items);
    for (const id of ['terms-approved', 'refund-policy', 'legal-review', 'retention-owner', 'staff-policy', 'validity-confirmed', 'commercial-authorization', 'lot', 'sales-start']) expect(k[id].status, id).not.toBe('APPROVED');
    expect(list.readyToSell).toBe(false);
  });
});
