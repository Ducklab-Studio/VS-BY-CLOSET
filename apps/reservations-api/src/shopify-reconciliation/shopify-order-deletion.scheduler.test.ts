import { describe, expect, test, vi } from 'vitest';
import type { ShopifyReconciliationService } from './shopify-reconciliation.service';
import { ShopifyOrderDeletionScheduler, shopifyOrderDeletionSyncIntervalMinutes } from './shopify-order-deletion.scheduler';

const CREDS = { SHOPIFY_STORE_DOMAIN: 'loja-teste.myshopify.com', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'segredo' };

describe('verificação automática de pedidos excluídos na Shopify', () => {
  test('desligada em teste, sem credenciais ou com 0; padrão 30 min; mínimo 5', () => {
    expect(shopifyOrderDeletionSyncIntervalMinutes({ ...CREDS, VITEST: 'true' })).toBeNull();
    expect(shopifyOrderDeletionSyncIntervalMinutes({ ...CREDS, NODE_ENV: 'test' })).toBeNull();
    expect(shopifyOrderDeletionSyncIntervalMinutes({ SHOPIFY_STORE_DOMAIN: 'x', SHOPIFY_CLIENT_ID: 'id' })).toBeNull();
    expect(shopifyOrderDeletionSyncIntervalMinutes({ ...CREDS, SHOPIFY_ORDER_DELETION_SYNC_INTERVAL_MINUTES: '0' })).toBeNull();
    expect(shopifyOrderDeletionSyncIntervalMinutes({ ...CREDS, SHOPIFY_ORDER_DELETION_SYNC_INTERVAL_MINUTES: 'abc' })).toBeNull();
    expect(shopifyOrderDeletionSyncIntervalMinutes(CREDS)).toBe(30);
    expect(shopifyOrderDeletionSyncIntervalMinutes({ ...CREDS, SHOPIFY_ORDER_DELETION_SYNC_INTERVAL_MINUTES: '1' })).toBe(5);
    expect(shopifyOrderDeletionSyncIntervalMinutes({ ...CREDS, SHOPIFY_ORDER_DELETION_SYNC_INTERVAL_MINUTES: '45' })).toBe(45);
  });

  test('roda só exclusões, aplicando; nunca duas rodadas juntas; falha não derruba o processo', async () => {
    let release: () => void = () => undefined;
    const reconcile = vi.fn(() => new Promise<{ divergences: { applied: boolean }[] }>((resolve) => { release = () => resolve({ divergences: [{ applied: true }] }); }));
    const scheduler = new ShopifyOrderDeletionScheduler({ reconcile } as unknown as ShopifyReconciliationService);

    const first = scheduler.runOnce();
    await scheduler.runOnce();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith({ days: 30, apply: true, deletionsOnly: true });
    release();
    await first;

    reconcile.mockImplementationOnce(() => Promise.reject(new Error('Shopify fora')));
    await expect(scheduler.runOnce()).resolves.toBeUndefined();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});
