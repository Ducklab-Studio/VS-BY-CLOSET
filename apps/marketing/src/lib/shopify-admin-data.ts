import 'server-only';

import { adminGet, adminPost } from './admin-api';

export interface ShopifyMappedUnit {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly active: boolean;
  readonly reservableOnline: boolean;
  readonly countsTowardRentalDuration: boolean;
}

export interface ShopifyCatalogItem {
  readonly id: string;
  readonly title: string;
  readonly sku: string | null;
  readonly inventoryQuantity: number | null;
  readonly imageUrl: string | null;
  readonly imageAlt: string | null;
  readonly selectedOptions: readonly { name: string; value: string }[];
  readonly product: {
    readonly id: string;
    readonly title: string;
    readonly handle: string;
    readonly productType: string;
    readonly status: string;
  };
  readonly mappedUnits: readonly ShopifyMappedUnit[];
  readonly physicalUnitsTotal: number;
  readonly physicalUnitsActive: number;
  readonly physicalUnitsReservableOnline: number;
}

export function listShopifyCatalog(adminUserId: string): Promise<ShopifyCatalogItem[]> {
  return adminGet('/admin/shopify/catalog', adminUserId);
}

export function importShopifyUnits(
  input: {
    shopifyVariantId: string;
    codes: string[];
    reservableOnline?: boolean;
    countsTowardRentalDuration?: boolean;
  },
  adminUserId: string,
): Promise<readonly ShopifyMappedUnit[]> {
  const path = `/admin/shopify/units?adminUserId=${encodeURIComponent(adminUserId)}`;
  return adminPost(path, input);
}

export type CatalogDivergenceKind = 'variant_missing' | 'variant_restored';

export interface CatalogDivergence {
  readonly kind: CatalogDivergenceKind;
  readonly rentalUnitId: string;
  readonly code: string;
  readonly name: string;
  readonly shopifyVariantId: string;
  readonly action: 'deactivate' | 'reactivate';
  readonly applied: boolean;
  readonly upcomingReservations: number;
  readonly note: string;
}

export interface CatalogSyncReport {
  readonly generatedAt: string;
  readonly mode: 'report' | 'apply';
  readonly totalRentalUnitsLinked: number;
  readonly totalShopifyVariants: number;
  readonly lastSyncedAt: string | null;
  readonly lastSyncedByName: string | null;
  readonly divergences: readonly CatalogDivergence[];
}

/** Item 11 — somente leitura, nunca altera nada. STAFF com módulo PIECES já pode ver. */
export function getCatalogReconciliation(adminUserId: string): Promise<CatalogSyncReport> {
  return adminGet('/admin/catalog/reconciliation', adminUserId);
}

/** Item 10 — ação administrativa protegida (ADMIN). Nenhum dado vem do cliente:
 *  o corpo é sempre vazio, o servidor decide tudo comparando banco × Shopify. */
export function syncCatalog(): Promise<CatalogSyncReport> {
  return adminPost('/admin/catalog/sync', {});
}
