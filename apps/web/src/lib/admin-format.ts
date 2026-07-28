import type { BadgeTone } from '@/components/admin/ui';
import type {
  CouponTypeValue,
  OrderStatus,
  ProductStatus,
  ReviewStatusValue,
  UserRole,
  UserStatusValue,
} from './admin-types';

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('pt-BR').format(value);
}

export const ORDER_STATUS: Record<OrderStatus, { label: string; tone: BadgeTone }> = {
  PENDING: { label: 'Pendente', tone: 'warning' },
  IN_ANALYSIS: { label: 'Em análise', tone: 'warning' },
  PAID: { label: 'Pago', tone: 'success' },
  SEPARATING: { label: 'Separando', tone: 'info' },
  INVOICED: { label: 'Faturado', tone: 'info' },
  SHIPPED: { label: 'Enviado', tone: 'info' },
  OUT_FOR_DELIVERY: { label: 'Saiu p/ entrega', tone: 'info' },
  DELIVERED: { label: 'Entregue', tone: 'success' },
  CANCELED: { label: 'Cancelado', tone: 'danger' },
  REFUNDED: { label: 'Reembolsado', tone: 'danger' },
};

export const ORDER_STATUS_OPTIONS = Object.entries(ORDER_STATUS).map(([value, v]) => ({
  value: value as OrderStatus,
  label: v.label,
}));

export const PRODUCT_STATUS: Record<ProductStatus, { label: string; tone: BadgeTone }> = {
  DRAFT: { label: 'Rascunho', tone: 'warning' },
  ACTIVE: { label: 'Ativo', tone: 'success' },
  ARCHIVED: { label: 'Arquivado', tone: 'neutral' },
};

export const USER_ROLE: Record<UserRole, { label: string; tone: BadgeTone }> = {
  ADMIN: { label: 'Administrador', tone: 'danger' },
  MANAGER: { label: 'Gerente', tone: 'info' },
  SUPPORT: { label: 'Atendente', tone: 'warning' },
  CUSTOMER: { label: 'Cliente', tone: 'neutral' },
};

export const USER_STATUS: Record<UserStatusValue, { label: string; tone: BadgeTone }> = {
  ACTIVE: { label: 'Ativo', tone: 'success' },
  BLOCKED: { label: 'Bloqueado', tone: 'danger' },
  PENDING_VERIFICATION: { label: 'Pendente', tone: 'warning' },
};

export const REVIEW_STATUS: Record<ReviewStatusValue, { label: string; tone: BadgeTone }> = {
  PENDING: { label: 'Pendente', tone: 'warning' },
  APPROVED: { label: 'Aprovada', tone: 'success' },
  REJECTED: { label: 'Rejeitada', tone: 'danger' },
};

export const COUPON_TYPE: Record<CouponTypeValue, string> = {
  PERCENTAGE: 'Percentual',
  FIXED: 'Valor fixo',
  FREE_SHIPPING: 'Frete grátis',
};
