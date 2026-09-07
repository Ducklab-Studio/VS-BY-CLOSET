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
  return adminPost('/admin/shopify/units', { ...input, adminUserId });
}
