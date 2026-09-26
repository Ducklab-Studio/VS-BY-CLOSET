import { describe, expect, test } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { CatalogSyncSchedulerService, catalogSyncIntervalMinutes } from './catalog-sync-scheduler.service';
import type { ShopifyCatalogSyncService } from './shopify-catalog-sync.service';

const shopify = { SHOPIFY_STORE_DOMAIN: 'loja.myshopify.com', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'fixture' };

describe('Reconciliação automática do catálogo Shopify', () => {
  test('intervalo: padrão 30 min, mínimo 5, 0/inválido desliga; desligada em teste e sem credenciais', () => {
    expect(catalogSyncIntervalMinutes({ ...shopify })).toBe(30);
    expect(catalogSyncIntervalMinutes({ ...shopify, CATALOG_SYNC_INTERVAL_MINUTES: '60' })).toBe(60);
    expect(catalogSyncIntervalMinutes({ ...shopify, CATALOG_SYNC_INTERVAL_MINUTES: '1' })).toBe(5);
    expect(catalogSyncIntervalMinutes({ ...shopify, CATALOG_SYNC_INTERVAL_MINUTES: '0' })).toBeNull();
    expect(catalogSyncIntervalMinutes({ ...shopify, CATALOG_SYNC_INTERVAL_MINUTES: 'abc' })).toBeNull();
    expect(catalogSyncIntervalMinutes({ ...shopify, VITEST: 'true' })).toBeNull();
    expect(catalogSyncIntervalMinutes({ ...shopify, NODE_ENV: 'test' })).toBeNull();
    expect(catalogSyncIntervalMinutes({ SHOPIFY_STORE_DOMAIN: 'loja.myshopify.com' })).toBeNull();
  });

  test('rodada aplica a reconciliação completa; falha (ex.: Shopify vazia) só registra, nunca derruba', async () => {
    const calls: unknown[] = [];
    let fail = false;
    const sync = {
      reconcile: async (options: unknown) => {
        calls.push(options);
        if (fail) throw new ServiceUnavailableException('vazio');
        return { divergences: [] };
      },
    } as unknown as ShopifyCatalogSyncService;
    const scheduler = new CatalogSyncSchedulerService(sync);

    await scheduler.runOnce();
    expect(calls).toEqual([{ apply: true }]);
    fail = true;
    await expect(scheduler.runOnce()).resolves.toBeUndefined();
  });

  test('duas rodadas nunca se sobrepõem', async () => {
    let release!: () => void;
    let started = 0;
    const sync = {
      reconcile: () => {
        started++;
        return new Promise((resolve) => {
          release = () => resolve({ divergences: [] });
        });
      },
    } as unknown as ShopifyCatalogSyncService;
    const scheduler = new CatalogSyncSchedulerService(sync);

    const first = scheduler.runOnce();
    await scheduler.runOnce();
    expect(started).toBe(1);
    release();
    await first;
    const third = scheduler.runOnce();
    expect(started).toBe(2);
    release();
    await third;
  });
});
