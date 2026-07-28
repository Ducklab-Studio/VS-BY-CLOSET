export interface ProductMedia {
  id: string;
  type: 'IMAGE' | 'VIDEO';
  url: string;
  alt?: string | null;
}

export interface ProductVariant {
  id: string;
  sku: string;
  color?: string | null;
  colorHex?: string | null;
  size?: string | null;
  price?: string | null;
  promoPrice?: string | null;
  inventory?: { quantity: number; reserved: number } | null;
}

export interface Product {
  id: string;
  name: string;
  slug: string;
  sku: string;
  description: string;
  material?: string | null;
  price: string;
  promoPrice?: string | null;
  pixDiscountPct?: string | null;
  maxInstallments: number;
  ratingAvg: string;
  ratingCount: number;
  isFeatured: boolean;
  isNewArrival: boolean;
  brand?: { name: string; slug: string } | null;
  media: ProductMedia[];
  variants?: ProductVariant[];
}

export interface Paginated<T> {
  items: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}
