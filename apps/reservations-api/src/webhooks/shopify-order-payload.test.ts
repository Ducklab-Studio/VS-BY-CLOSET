import { describe, expect, test } from 'vitest';
import { extractCustomerPhone, type ShopifyOrderPayload } from './shopify-order-payload';

function order(partial: Partial<ShopifyOrderPayload>): ShopifyOrderPayload {
  return {
    id: 1,
    admin_graphql_api_id: 'gid://shopify/Order/1',
    ...partial,
  };
}

describe('extractCustomerPhone', () => {
  test('prioriza o telefone principal do pedido', () => {
    expect(
      extractCustomerPhone(
        order({
          phone: '+55 82 99999-1111',
          customer: { phone: '+55 82 99999-2222' },
          shipping_address: { phone: '+55 82 99999-3333' },
        }),
      ),
    ).toBe('+55 82 99999-1111');
  });

  test('usa customer e endereços como fallback', () => {
    expect(extractCustomerPhone(order({ customer: { phone: ' +56 9 1111 2222 ' } }))).toBe('+56 9 1111 2222');
    expect(extractCustomerPhone(order({ shipping_address: { phone: '+55 82 98888-7777' } }))).toBe('+55 82 98888-7777');
    expect(extractCustomerPhone(order({ billing_address: { phone: '+55 82 97777-6666' } }))).toBe('+55 82 97777-6666');
  });

  test('retorna null quando nenhum telefone útil existe', () => {
    expect(extractCustomerPhone(order({ phone: '   ', customer: { phone: null } }))).toBeNull();
  });
});
