import type { AdminRole } from '@prisma/client';
import { maskEmail } from './email/email-mask';
import { maskName, maskPhone } from './vale-pass-pii-mask';

/**
 * Lista e consulta de vouchers (`/admin/vale-pass/vouchers`) só exigem o módulo VALLE_PASS, então STAFF as acessa. A consulta de saldo já mascara o cliente
 * para quem não é ADMIN; esta regra faz o mesmo aqui: só ADMIN/SUPER_ADMIN veem nome, telefone e e-mail completos. O código do voucher e os demais campos não mudam.
 */
export const canSeeCustomerData = (role: AdminRole): boolean => role === 'ADMIN' || role === 'SUPER_ADMIN';

export interface VoucherCustomerFields {
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly customerEmail: string | null;
}

export function forRole<T extends VoucherCustomerFields>(item: T, role: AdminRole): T {
  if (canSeeCustomerData(role)) return item;
  return { ...item, customerName: maskName(item.customerName), customerPhone: maskPhone(item.customerPhone), customerEmail: item.customerEmail ? maskEmail(item.customerEmail) : null };
}
