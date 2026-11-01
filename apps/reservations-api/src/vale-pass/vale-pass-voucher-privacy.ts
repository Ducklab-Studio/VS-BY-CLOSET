import type { AdminRole } from '@prisma/client';
import { maskEmail } from './email/email-mask';
import { maskCode } from './vale-pass-code-mask';
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

/**
 * LISTA (não a consulta por código): quem não é administrador não recebe o código completo (`VALLE-AB12-****`), para que a lista não sirva de catálogo de códigos
 * utilizáveis. O atendimento continua: o cliente apresenta o código e o operador o digita na consulta de saldo.
 */
export function forListRole<T extends VoucherCustomerFields & { readonly code: string }>(item: T, role: AdminRole): T {
  const base = forRole(item, role);
  return canSeeCustomerData(role) ? base : { ...base, code: maskCode(item.code) };
}

export function forRole<T extends VoucherCustomerFields>(item: T, role: AdminRole): T {
  if (canSeeCustomerData(role)) return item;
  return { ...item, customerName: maskName(item.customerName), customerPhone: maskPhone(item.customerPhone), customerEmail: item.customerEmail ? maskEmail(item.customerEmail) : null };
}
