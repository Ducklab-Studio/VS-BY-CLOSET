import { describe, expect, test } from 'vitest';
import { extractCustomerName, extractCustomerPhone, type ShopifyOrderPayload } from './shopify-order-payload';

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

describe('extractCustomerName', () => {
  test('monta o nome completo a partir de customer.first_name + last_name', () => {
    expect(extractCustomerName(order({ customer: { first_name: 'Ana', last_name: 'Pereira' } }))).toBe('Ana Pereira');
  });

  test('usa só o first_name quando last_name não existe', () => {
    expect(extractCustomerName(order({ customer: { first_name: 'Ana' } }))).toBe('Ana');
  });

  test('prioriza customer sobre shipping_address e billing_address', () => {
    expect(
      extractCustomerName(
        order({
          customer: { first_name: 'Ana', last_name: 'Pereira' },
          shipping_address: { first_name: 'Outro', last_name: 'Nome' },
          billing_address: { first_name: 'Terceiro', last_name: 'Nome' },
        }),
      ),
    ).toBe('Ana Pereira');
  });

  test('sem customer, usa shipping_address como fallback', () => {
    expect(extractCustomerName(order({ shipping_address: { first_name: 'Carlos', last_name: 'Nunes' } }))).toBe('Carlos Nunes');
  });

  test('sem customer nem shipping_address, usa billing_address como último fallback', () => {
    expect(extractCustomerName(order({ billing_address: { first_name: 'Beatriz', last_name: 'Lima' } }))).toBe('Beatriz Lima');
  });

  test('sem first_name/last_name, usa o "name" já concatenado do endereço', () => {
    expect(extractCustomerName(order({ shipping_address: { name: 'João da Silva' } }))).toBe('João da Silva');
  });

  test('espaços em branco não contam como nome válido', () => {
    expect(extractCustomerName(order({ customer: { first_name: '   ', last_name: '  ' }, shipping_address: { name: '   ' } }))).toBeNull();
  });

  test('retorna null quando nenhum campo de nome existe em nenhum container', () => {
    expect(extractCustomerName(order({ email: 'cliente@example.com' }))).toBeNull();
  });
});
