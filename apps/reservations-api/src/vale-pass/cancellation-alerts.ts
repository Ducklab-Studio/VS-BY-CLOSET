/**
 * Alerta de pedido CANCELADO/REEMBOLSADO cujos vouchers já tiveram crédito utilizado (puro, sem banco). Só INFORMA: nunca altera saldo, voucher, reembolso nem a regra
 * de cancelamento. O retrato guarda empresa, valores e status — jamais código de voucher ou dado pessoal.
 */
export type AlertCompany = 'VALLE_SHOWROOM' | 'VS_BY_CLOSET' | 'LEGACY';

export interface AlertVoucherFact {
  /** `null` = voucher legado (sem empresa, sem saldo parcial). */
  readonly company: 'VALLE_SHOWROOM' | 'VS_BY_CLOSET' | null;
  readonly status: 'ACTIVE' | 'USED' | 'EXPIRED' | 'CANCELLED';
  readonly amountCents: number;
  readonly balanceCents: number;
}

export interface AlertCompanyLine {
  readonly company: AlertCompany;
  /** Vouchers da empresa no pedido. */
  readonly vouchers: number;
  readonly amountCents: number;
  readonly usedCents: number;
  readonly balanceCents: number;
}

export interface CancellationAlertDetail {
  readonly lines: readonly AlertCompanyLine[];
  /** Vouchers que tiveram qualquer uso. */
  readonly vouchersWithUse: number;
}

/**
 * Quanto já foi utilizado de cada voucher: no modelo com saldo, `valor − saldo`; no legado (sem empresa), o voucher USADO conta por inteiro e os demais, zero.
 * Devolve `null` quando nada foi utilizado (nenhum alerta).
 */
export function summarizeUsedCredit(vouchers: readonly AlertVoucherFact[]): { usedCents: number; detail: CancellationAlertDetail } | null {
  const byCompany = new Map<AlertCompany, { vouchers: number; amountCents: number; usedCents: number; balanceCents: number }>();
  let usedTotal = 0;
  let withUse = 0;
  for (const voucher of vouchers) {
    const used = voucher.company === null ? (voucher.status === 'USED' ? voucher.amountCents : 0) : Math.max(0, voucher.amountCents - voucher.balanceCents);
    const key: AlertCompany = voucher.company ?? 'LEGACY';
    const line = byCompany.get(key) ?? { vouchers: 0, amountCents: 0, usedCents: 0, balanceCents: 0 };
    line.vouchers += 1;
    line.amountCents += voucher.amountCents;
    line.usedCents += used;
    line.balanceCents += voucher.company === null ? (voucher.status === 'USED' ? 0 : voucher.amountCents) : voucher.balanceCents;
    byCompany.set(key, line);
    usedTotal += used;
    if (used > 0) withUse += 1;
  }
  if (usedTotal <= 0) return null;
  const order: AlertCompany[] = ['VALLE_SHOWROOM', 'VS_BY_CLOSET', 'LEGACY'];
  return {
    usedCents: usedTotal,
    detail: { lines: order.filter((key) => byCompany.has(key)).map((key) => ({ company: key, ...(byCompany.get(key) as NonNullable<ReturnType<typeof byCompany.get>>) })), vouchersWithUse: withUse },
  };
}
