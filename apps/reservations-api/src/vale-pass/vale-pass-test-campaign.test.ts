import { describe, expect, test } from 'vitest';
import { isTestCampaign, TEST_CAMPAIGN_ID, TEST_CAMPAIGN_VARIANT_ID } from './vale-pass-test-campaign';

describe('identificação da campanha de TESTE (ID e/ou Variant ID; nunca nome, preço ou rótulo)', () => {
  test('bate pelo ID da campanha, pela variante (número ou GID) ou pelos dois', () => {
    expect(isTestCampaign({ id: TEST_CAMPAIGN_ID, shopifyVariantId: TEST_CAMPAIGN_VARIANT_ID })).toBe(true);
    expect(isTestCampaign({ id: TEST_CAMPAIGN_ID, shopifyVariantId: '999' })).toBe(true); // ID bate, variante trocada: continua sem valor comercial
    expect(isTestCampaign({ id: TEST_CAMPAIGN_ID })).toBe(true);
    expect(isTestCampaign({ id: 'qualquer-outro-id', shopifyVariantId: TEST_CAMPAIGN_VARIANT_ID })).toBe(true); // variante bate, ID diferente
    expect(isTestCampaign({ id: 'qualquer-outro-id', shopifyVariantId: `gid://shopify/ProductVariant/${TEST_CAMPAIGN_VARIANT_ID}` })).toBe(true);
  });

  test('a campanha OFICIAL e qualquer outra variante nunca são identificadas como de teste', () => {
    expect(isTestCampaign({ id: '01ce04c2-dd85-4fb4-bf08-de446e8280aa', shopifyVariantId: '49174518595684' })).toBe(false);
    expect(isTestCampaign({ id: '01ce04c2-dd85-4fb4-bf08-de446e8280aa', shopifyVariantId: 'gid://shopify/ProductVariant/49174518595684' })).toBe(false);
    expect(isTestCampaign({ id: 'x', shopifyVariantId: '6791637116528' })).toBe(false); // um dígito a menos
    expect(isTestCampaign({ id: 'x', shopifyVariantId: '167916371165284' })).toBe(false); // um dígito a mais
    expect(isTestCampaign({ id: 'x', shopifyVariantId: null })).toBe(false);
  });

  test('constantes fixas (idênticas às do ClosetAdmin): não há chave de ambiente para desligar o bloqueio', () => {
    expect(TEST_CAMPAIGN_ID).toBe('f6f16b3b-2ed0-4e8b-9420-e856adc1bf93');
    expect(TEST_CAMPAIGN_VARIANT_ID).toBe('67916371165284');
  });
});
