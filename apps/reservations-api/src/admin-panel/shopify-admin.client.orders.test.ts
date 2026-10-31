import { describe, expect, test } from 'vitest';
import { ShopifyAdminClient } from './shopify-admin.client';

/**
 * Paginação e normalização dos pedidos com linhas (reconciliação do Valle
 * Pass). Sem rede: a chamada GraphQL é substituída por páginas simuladas.
 */
type Call = { query: string; variables: Record<string, unknown> };

function clientWith(respond: (call: Call, index: number) => unknown) {
  const client = new ShopifyAdminClient();
  const calls: Call[] = [];
  (client as unknown as { graphql: (query: string, variables: Record<string, unknown>) => Promise<unknown> }).graphql = async (query, variables) => {
    calls.push({ query, variables });
    return respond({ query, variables }, calls.length - 1);
  };
  return { client, calls };
}

const rawOrder = (id: number, extra: Partial<Record<string, unknown>> = {}) => ({
  id: `gid://shopify/Order/${id}`,
  name: `#${id}`,
  createdAt: '2026-09-20T10:00:00Z',
  updatedAt: '2026-09-20T11:00:00Z',
  cancelledAt: null,
  cancelReason: null,
  displayFinancialStatus: 'PENDING',
  lineItems: { nodes: [{ quantity: 1, variant: { id: 'gid://shopify/ProductVariant/49174518595684' }, product: { id: 'gid://shopify/Product/8723909804132' } }] },
  ...extra,
});

const page = (ids: number[], next: string | null) => ({ orders: { nodes: ids.map((id) => rawOrder(id)), pageInfo: { hasNextPage: next !== null, endCursor: next } } });

describe('ShopifyAdminClient.listOrdersWithLinesUpdatedSince', () => {
  test('segue o cursor até a última página e filtra por data de ALTERAÇÃO (pega pendente, pago, expirado, cancelado)', async () => {
    const pages = [page([1, 2], 'c1'), page([3, 4], 'c2'), page([5], null)];
    const { client, calls } = clientWith((_call, index) => pages[index]);

    const result = await client.listOrdersWithLinesUpdatedSince('2026-09-01T00:00:00.000Z', 50);

    expect(result.truncated).toBe(false);
    expect(result.orders.map((o) => o.orderId)).toEqual(['1', '2', '3', '4', '5']);
    expect(calls.map((c) => c.variables.after)).toEqual([null, 'c1', 'c2']);
    expect(calls[0].variables.query).toBe("updated_at:>='2026-09-01T00:00:00.000Z'");
    expect(calls[0].query).toContain('sortKey: UPDATED_AT');
  });

  test('para no teto de páginas e avisa `truncated`', async () => {
    const { client, calls } = clientWith((_call, index) => page([index * 10 + 1], `c${index + 1}`));
    const result = await client.listOrdersWithLinesUpdatedSince('2026-09-01T00:00:00.000Z', 3);
    expect(calls).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.orders).toHaveLength(3);
  });

  test('normaliza: ids numéricos, status minúsculo, linha sem variante/produto (excluídos) vira null', async () => {
    const { client } = clientWith(() => ({
      orders: {
        nodes: [
          rawOrder(7, {
            cancelledAt: '2026-09-21T00:00:00Z',
            cancelReason: 'DECLINED',
            displayFinancialStatus: 'VOIDED',
            lineItems: { nodes: [{ quantity: 2, variant: null, product: null }] },
          }),
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }));
    const [order] = (await client.listOrdersWithLinesUpdatedSince('2026-09-01T00:00:00.000Z', 5)).orders;
    expect(order).toMatchObject({ orderId: '7', gid: 'gid://shopify/Order/7', name: '#7', cancelReason: 'declined', financialStatus: 'voided' });
    expect(order.lines).toEqual([{ variantId: null, productId: null, quantity: 2 }]);
  });
});

describe('ShopifyAdminClient.getOrdersWithLinesByGid', () => {
  test('consulta em lotes pequenos e devolve null para pedido que a Shopify não retornou', async () => {
    const gids = Array.from({ length: 23 }, (_, i) => `gid://shopify/Order/${100 + i}`);
    const { client, calls } = clientWith((call) => ({
      nodes: (call.variables.ids as string[]).map((gid) => (gid.endsWith('/105') ? null : rawOrder(Number(gid.split('/').pop()), { displayFinancialStatus: 'EXPIRED' }))),
    }));

    const result = await client.getOrdersWithLinesByGid(gids);

    expect(calls.map((c) => (c.variables.ids as string[]).length)).toEqual([10, 10, 3]);
    expect(result.get('gid://shopify/Order/105')).toBeNull();
    expect(result.get('gid://shopify/Order/100')).toMatchObject({ orderId: '100', financialStatus: 'expired' });
    expect(result.size).toBe(23);
  });
});

describe('ShopifyAdminClient.getOrderPaymentTransactions — eventos de confirmação do pagamento', () => {
  const raw = (events: unknown) => ({
    order: {
      id: 'gid://shopify/Order/1',
      currentTotalPriceSet: { shopMoney: { amount: '350.0', currencyCode: 'BRL' } },
      transactions: [{ id: 'gid://shopify/OrderTransaction/1', kind: 'SALE', status: 'SUCCESS', test: false, gateway: 'Gateway Pix', processedAt: '2026-10-30T04:40:01Z', amountSet: { shopMoney: { amount: '350.0', currencyCode: 'BRL' } } }],
      ...(events === undefined ? {} : { events }),
    },
  });

  test('a consulta pede a linha do tempo e só os eventos de confirmação (sale_success/capture_success) passam; ruído e nós sem ação são descartados', async () => {
    const { client, calls } = clientWith(() =>
      raw({ nodes: [{ action: 'sale_pending', createdAt: '2026-10-30T04:40:34Z' }, {}, { action: 'mail_sent', createdAt: '2026-10-30T04:42:01Z' }, { action: 'sale_success', createdAt: '2026-10-30T04:42:00Z' }, { action: 'capture_success' }] }),
    );
    const result = await client.getOrderPaymentTransactions('gid://shopify/Order/1');
    expect(calls[0].query).toContain('events(first: 50)');
    expect(calls[0].query).not.toMatch(/mutation/i);
    expect(result?.successEvents).toEqual([{ action: 'sale_success', createdAt: '2026-10-30T04:42:00Z' }]);
    expect(result?.transactions[0].processedAt).toBe('2026-10-30T04:40:01Z');
  });

  test('sem linha do tempo (events nulo ou ausente): lista VAZIA — nunca undefined —, para o consumidor falhar fechado em vez de cair no processedAt da cobrança', async () => {
    for (const events of [null, undefined, { nodes: [] }]) {
      const { client } = clientWith(() => raw(events));
      expect((await client.getOrderPaymentTransactions('gid://shopify/Order/1'))?.successEvents).toEqual([]);
    }
  });

  test('pedido não devolvido pela Shopify → null', async () => {
    const { client } = clientWith(() => ({ order: null }));
    expect(await client.getOrderPaymentTransactions('gid://shopify/Order/1')).toBeNull();
  });
});
