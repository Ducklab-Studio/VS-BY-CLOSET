export type ProductStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

export type OrderStatus =
  | 'PENDING'
  | 'IN_ANALYSIS'
  | 'PAID'
  | 'SEPARATING'
  | 'INVOICED'
  | 'SHIPPED'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'CANCELED'
  | 'REFUNDED';

export type UserRole = 'ADMIN' | 'MANAGER' | 'SUPPORT' | 'CUSTOMER';
export type UserStatusValue = 'ACTIVE' | 'BLOCKED' | 'PENDING_VERIFICATION';
export type ReviewStatusValue = 'PENDING' | 'APPROVED' | 'REJECTED';
export type CouponTypeValue = 'PERCENTAGE' | 'FIXED' | 'FREE_SHIPPING';

export interface Paginated<T> {
  items: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface DashboardStats {
  revenue: { total: number; last30d: number; changePct: number | null };
  orders: {
    total: number;
    last30d: number;
    paid30d: number;
    byStatus: { status: OrderStatus; count: number }[];
  };
  customers: { total: number; last30d: number };
  products: { active: number };
  pendingReviews: number;
}

export interface RevenuePoint {
  date: string;
  revenue: number;
  orders: number;
}

export interface TopProduct {
  name: string;
  sku: string;
  quantity: number;
  revenue: number;
}

export interface LowStockItem {
  sku: string;
  productName: string;
  color: string | null;
  size: string | null;
  quantity: number;
  lowStockAt: number;
}

export interface RecentOrder {
  id: string;
  number: string;
  status: OrderStatus;
  total: string;
  createdAt: string;
  user: { name: string; email: string };
}

export interface AdminInventory {
  quantity: number;
  reserved: number;
  lowStockAt: number;
}

export interface AdminVariant {
  id: string;
  sku: string;
  color: string | null;
  colorHex: string | null;
  size: string | null;
  price: string | null;
  promoPrice: string | null;
  isActive: boolean;
  inventory: AdminInventory | null;
}

export interface AdminMedia {
  id: string;
  url: string;
  alt: string | null;
  type: 'IMAGE' | 'VIDEO';
  position: number;
}

export interface AdminProduct {
  id: string;
  name: string;
  slug: string;
  sku: string;
  description: string;
  material: string | null;
  status: ProductStatus;
  isFeatured: boolean;
  isNewArrival: boolean;
  price: string;
  promoPrice: string | null;
  pixDiscountPct: string | null;
  maxInstallments: number;
  ratingAvg: string;
  ratingCount: number;
  soldCount: number;
  metaTitle: string | null;
  metaDescription: string | null;
  brandId: string | null;
  brand: { id?: string; name: string } | null;
  media: AdminMedia[];
  variants: AdminVariant[];
  categories?: { categoryId: string; category?: { id: string; name: string } }[];
  createdAt: string;
}

export interface AdminCategory {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  parentId: string | null;
  isActive: boolean;
  position: number;
  _count?: { products: number; children: number };
}

export interface AdminBrand {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  logoUrl: string | null;
  isActive: boolean;
  _count?: { products: number };
}

export interface AdminOrderListItem {
  id: string;
  number: string;
  status: OrderStatus;
  total: string;
  createdAt: string;
  user: { name: string; email: string };
  _count: { items: number };
}

export interface AdminOrderDetail {
  id: string;
  number: string;
  status: OrderStatus;
  subtotal: string;
  discountTotal: string;
  shippingTotal: string;
  total: string;
  shippingMethod: string | null;
  shippingCarrier: string | null;
  trackingCode: string | null;
  estimatedAt: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string; phone: string | null };
  items: {
    id: string;
    productName: string;
    variantName: string | null;
    sku: string;
    unitPrice: string;
    quantity: number;
    total: string;
  }[];
  payments: {
    id: string;
    provider: string;
    status: string;
    amount: string;
    installments: number;
    paidAt: string | null;
  }[];
  shippingAddress: AdminAddress | null;
  billingAddress: AdminAddress | null;
  coupon: { code: string; type: CouponTypeValue; value: string } | null;
  statusHistory: {
    id: string;
    status: OrderStatus;
    note: string | null;
    createdAt: string;
  }[];
}

export interface AdminAddress {
  id: string;
  recipient: string;
  zipCode: string;
  street: string;
  number: string;
  complement: string | null;
  district: string;
  city: string;
  state: string;
}

export interface AdminCoupon {
  id: string;
  code: string;
  description: string | null;
  type: CouponTypeValue;
  value: string;
  minOrderValue: string | null;
  maxUses: number | null;
  maxUsesPerUser: number;
  usedCount: number;
  startsAt: string | null;
  expiresAt: string | null;
  isActive: boolean;
}

export interface AdminUserListItem {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatusValue;
  createdAt: string;
  lastLoginAt: string | null;
  _count: { orders: number };
}

export interface AdminUserDetail {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  cpf: string | null;
  role: UserRole;
  status: UserStatusValue;
  createdAt: string;
  lastLoginAt: string | null;
  orders: { id: string; number: string; status: OrderStatus; total: string; createdAt: string }[];
  addresses: AdminAddress[];
}

export interface AdminReview {
  id: string;
  rating: number;
  title: string | null;
  comment: string | null;
  status: ReviewStatusValue;
  storeReply: string | null;
  createdAt: string;
  user: { name: string; email: string };
  product: { name: string; slug: string };
}
