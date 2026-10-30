import type { ValePassBenefitInput } from './admin-data';

/**
 * Benefícios SIMBÓLICOS da campanha de TESTE do Valle Pass ("VALLE PASS TESTE"), usados só para provar, com pagamento real de centavos, o fluxo
 * checkout → webhook → emissão dos dois vouchers → e-mail → cancelamento. Nunca valem como crédito comercial.
 *
 * ISOLAMENTO: a opção só existe para UMA campanha, identificada pelo ID dela E pelo Variant ID da Shopify (nome e preço baixo NÃO bastam).
 * A campanha oficial do Valle Pass 2027 e o modelo oficial (R$ 500 + R$ 50 + 10%) não são tocados: o botão oficial continua igual para qualquer
 * outra campanha, e o modelo de teste é recusado em qualquer campanha que não seja esta (ver `actions.ts`, que reaplica estas regras no servidor).
 */
export const TEST_CAMPAIGN_ID = 'f6f16b3b-2ed0-4e8b-9420-e856adc1bf93';
export const TEST_CAMPAIGN_VARIANT_ID = '67916371165284';
export const TEST_BENEFIT_TERMS = 'Voucher de teste, sem valor comercial';
export const TEST_LABEL_PREFIX = 'TESTE — ';

export const VALLE_PASS_TEST_PRESET: readonly ValePassBenefitInput[] = [
  { code: 'teste_showroom', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: `${TEST_LABEL_PREFIX}Voucher Valle Showroom (sem valor comercial)`, amountCents: 500, terms: TEST_BENEFIT_TERMS, sortOrder: 0 },
  { code: 'teste_closet', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: `${TEST_LABEL_PREFIX}Voucher VS BY CLOSET (sem valor comercial)`, amountCents: 50, terms: TEST_BENEFIT_TERMS, sortOrder: 1 },
];

/** Só dígitos finais do ID da Shopify ("gid://shopify/ProductVariant/123" e "123" são a mesma variante). */
function numericId(value: string | null | undefined): string | null {
  const match = /(\d+)\s*$/.exec(value ?? '');
  return match ? match[1] : null;
}

/** É a campanha de teste específica? (ID da campanha E variante da Shopify, os dois.) */
export function isTestCampaign(campaign: { readonly id: string; readonly shopifyVariantId?: string | null }): boolean {
  return campaign.id === TEST_CAMPAIGN_ID && numericId(campaign.shopifyVariantId) === TEST_CAMPAIGN_VARIANT_ID;
}

/** A lista de benefícios é exatamente o modelo de teste (códigos, empresas, valores, rótulos e condições)? */
export function isTestPreset(benefits: readonly ValePassBenefitInput[]): boolean {
  if (benefits.length !== VALLE_PASS_TEST_PRESET.length) return false;
  return VALLE_PASS_TEST_PRESET.every((expected, index) => {
    const given = benefits[index];
    return (
      given.code === expected.code &&
      given.kind === expected.kind &&
      (given.company ?? null) === (expected.company ?? null) &&
      given.amountCents === expected.amountCents &&
      given.label === expected.label &&
      (given.terms ?? null) === (expected.terms ?? null) &&
      (given.discountPercent ?? null) === null
    );
  });
}

/** Qualquer lista que mencione os códigos do modelo de teste conta como "tentativa de usar o modelo de teste". */
export const touchesTestBenefits = (benefits: readonly ValePassBenefitInput[]): boolean => benefits.some((b) => b.code.startsWith('teste_'));

/** O rótulo do benefício marca o voucher como de teste (usado para avisar o operador na consulta de saldo). */
export const isTestBenefitLabel = (label: string | null | undefined): boolean => typeof label === 'string' && label.startsWith(TEST_LABEL_PREFIX);

/** Texto que o ADMIN precisa digitar para confirmar o cadastro. */
export const TEST_CONFIRMATION_WORD = 'TESTE';
