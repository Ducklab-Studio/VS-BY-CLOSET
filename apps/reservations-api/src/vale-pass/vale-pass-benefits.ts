import type { ValePassBenefitKind, ValePassCompany } from '@prisma/client';

/**
 * Benefícios que cada unidade do Valle Pass concede (validação pura). `VOUCHER` = crédito nominal exclusivo de UMA empresa (gera voucher
 * com código e saldo próprios por unidade); `DISCOUNT` = direito comercial DESCRITIVO (ex.: 10% em passeios): não gera código, saldo nem
 * abatimento automático — as condições são texto livre aprovado pelo cliente e nunca são interpretadas pelo sistema.
 *
 * Nada aqui define regra de uso: uso parcial, cumulatividade, transferência, reembolso de saldo e forma de validação em cada empresa
 * continuam DECISÕES PENDENTES do Anderson e não são modelados.
 */

export const MAX_BENEFITS_PER_CAMPAIGN = 6;
export const MAX_VOUCHER_AMOUNT_CENTS = 10_000_000;
export const COMPANY_LABELS: Record<ValePassCompany, string> = { VALLE_SHOWROOM: 'Valle Showroom', VS_BY_CLOSET: 'VS BY CLOSET' };

export interface BenefitInput {
  readonly code: string;
  readonly kind: ValePassBenefitKind;
  readonly company?: ValePassCompany | null;
  readonly label: string;
  readonly amountCents?: number | null;
  readonly discountPercent?: number | null;
  readonly terms?: string | null;
  readonly active?: boolean;
  readonly sortOrder?: number;
}

const CODE = /^[a-z0-9_]{1,40}$/;

export function validateBenefits(items: readonly BenefitInput[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(items) || items.length === 0) return ['Informe ao menos um benefício.'];
  if (items.length > MAX_BENEFITS_PER_CAMPAIGN) errors.push(`No máximo ${MAX_BENEFITS_PER_CAMPAIGN} benefícios por campanha.`);

  const codes = new Set<string>();
  const companies = new Set<string>();
  for (const item of items) {
    const where = `Benefício "${item.code}"`;
    if (!CODE.test(item.code)) errors.push(`${where}: o código usa só letras minúsculas, números e "_" (até 40).`);
    if (codes.has(item.code)) errors.push(`${where}: código repetido.`);
    codes.add(item.code);
    if (typeof item.label !== 'string' || item.label.trim().length < 1 || item.label.length > 120) errors.push(`${where}: o nome precisa ter de 1 a 120 caracteres.`);
    if (item.terms != null && item.terms.length > 2000) errors.push(`${where}: as condições passam de 2.000 caracteres.`);

    if (item.kind === 'VOUCHER') {
      if (!item.company) errors.push(`${where}: um voucher precisa de empresa.`);
      else if (companies.has(item.company)) errors.push(`${where}: já existe outro voucher da ${COMPANY_LABELS[item.company as ValePassCompany]} nesta campanha (um por empresa).`);
      else companies.add(item.company);
      if (!Number.isInteger(item.amountCents) || (item.amountCents as number) < 1 || (item.amountCents as number) > MAX_VOUCHER_AMOUNT_CENTS) errors.push(`${where}: valor inválido (centavos, de 1 a ${MAX_VOUCHER_AMOUNT_CENTS}).`);
      if (item.discountPercent != null) errors.push(`${where}: um voucher não tem percentual de desconto.`);
    } else if (item.kind === 'DISCOUNT') {
      if (item.company) errors.push(`${where}: um desconto não pertence a uma empresa.`);
      if (item.amountCents != null) errors.push(`${where}: um desconto não tem valor em reais.`);
      if (!Number.isInteger(item.discountPercent) || (item.discountPercent as number) < 1 || (item.discountPercent as number) > 100) errors.push(`${where}: o percentual vai de 1 a 100.`);
    } else {
      errors.push(`${where}: tipo inválido.`);
    }
  }
  return errors;
}
