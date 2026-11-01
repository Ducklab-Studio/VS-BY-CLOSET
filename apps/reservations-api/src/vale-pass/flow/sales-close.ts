import { resolveValidityTimezone, voucherWindow } from '../vale-pass-validity';
import { formatIsoDate } from '../vale-pass-capacity';

/**
 * Proteção contra venda DEPOIS do encerramento (31/05/2027, confirmado pelo Anderson) — só quando a chave `VALE_PASS_SALES_CLOSE_GUARD=on`.
 *
 * O que ela FAZ: um pagamento confirmado de pedido CRIADO depois do fim do dia `salesEndDate` (fuso do negócio) NÃO emite voucher: vira retenção visível
 * (`FINANCIAL_MISMATCH` com o código `SALES_CLOSED`), para um ADMIN decidir. Pedido sem data de criação confiável também é retido (`SALES_ORDER_DATE_UNKNOWN`).
 * O que ela NÃO faz: não cancela, não reembolsa, não descarta, não impede a compra na Shopify e não altera estoque. Pedido criado ATÉ o fim do dia 31/05
 * e pago depois (ex.: Pix tardio) segue emitindo normalmente — o critério é o momento do pedido, nunca o do pagamento.
 *
 * Limite: esta regra só roda DEPOIS do pagamento, no webhook. Quem barra a compra é o estoque da variante na Shopify (esgotamento = estoque 0). O encerramento
 * por esgotamento das 1.000 unidades é o limite global da emissão (retenção `CAPACITY_EXCEEDED`), que já existe e independe desta chave.
 */
export const SALES_CLOSED = 'SALES_CLOSED';
export const SALES_ORDER_DATE_UNKNOWN = 'SALES_ORDER_DATE_UNKNOWN';

export type SalesCloseVerdict = { readonly ok: true } | { readonly ok: false; readonly code: typeof SALES_CLOSED | typeof SALES_ORDER_DATE_UNKNOWN; readonly detail: Record<string, unknown> };

/** Primeiro instante em que a venda JÁ está encerrada: 00:00 do dia seguinte a `salesEndDate`, no fuso do negócio. */
export function salesCloseInstant(salesEndDate: Date, timeZone: string = resolveValidityTimezone()): Date {
  const day = formatIsoDate(salesEndDate) as string;
  return voucherWindow(day, day, timeZone).expiresAt;
}

export function evaluateSalesClose(input: { enabled: boolean; salesEndDate: Date | null; orderCreatedAt: Date | null; timeZone?: string }): SalesCloseVerdict {
  if (!input.enabled || !input.salesEndDate) return { ok: true };
  const cutoff = salesCloseInstant(input.salesEndDate, input.timeZone);
  const salesEndDate = formatIsoDate(input.salesEndDate);
  if (!input.orderCreatedAt || Number.isNaN(input.orderCreatedAt.getTime())) return { ok: false, code: SALES_ORDER_DATE_UNKNOWN, detail: { salesEndDate } };
  if (input.orderCreatedAt.getTime() >= cutoff.getTime()) return { ok: false, code: SALES_CLOSED, detail: { salesEndDate, orderCreatedAt: input.orderCreatedAt.toISOString() } };
  return { ok: true };
}
