import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { KNOWN_VALE_PASS_PRODUCT_ID, KNOWN_VALE_PASS_VARIANT_ID, numericShopifyId } from '../vale-pass-order-status';
import type { FinancialLineFacts, OrderFinancialFacts } from './order-facts';
import { DEFAULT_MAX_UNITS_PER_ORDER, validateValePassFinancials, type FinancialIssue, type FinancialVerdict } from './validate-order';

type Reader = Pick<Prisma.TransactionClient, 'valePassCampaign'>;

export type GuardedVerdict = FinancialVerdict & {
  /** Campanhas das linhas de Valle Pass do pedido (para a fila de resolução saber onde reter). */
  readonly campaignIds: readonly string[];
};

/** Teto de unidades por pedido: configuração comercial (padrão 10). Valor inválido volta ao padrão — nunca a "sem limite". */
export function maxUnitsPerOrder(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.VALE_PASS_MAX_UNITS_PER_ORDER);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000 ? parsed : DEFAULT_MAX_UNITS_PER_ORDER;
}

/**
 * Valida o pedido contra a configuração comercial CONFIÁVEL (preço da campanha no banco). ISOLADO: nada do fluxo ativo o chama.
 *
 * PONTO DE INTEGRAÇÃO FUTURO (PR F, só com autorização): dentro de `ValePassWebhookService.handleOrderPaid`, depois de resolver as campanhas das linhas
 * e ANTES de emitir:
 *
 *   const verdict = await this.financialGuard.evaluate(tx, factsFromWebhookPayload(order));
 *   if (!verdict.ok) { await this.issuance.holdForFinancialReview(tx, { ... }); return events; }   // fila de resolução, nunca descarte
 *
 * No caminho da reconciliação, a consulta da Admin API precisa incluir `ADMIN_ORDER_FINANCIAL_FIELDS`; sem isso o veredito é `FINANCIALS_UNDEFINED`
 * (fail-closed) e o pedido pago vai para a fila.
 */
@Injectable()
export class ValePassFinancialGuard {
  async evaluate(db: Reader, facts: OrderFinancialFacts, options: { maxUnits?: number } = {}): Promise<GuardedVerdict> {
    const campaigns = await db.valePassCampaign.findMany({ select: { id: true, shopifyVariantId: true, amountCents: true } });
    const unitPriceByVariant = new Map<string, number>();
    const campaignByVariant = new Map<string, string>();
    for (const campaign of campaigns) {
      const variant = numericShopifyId(campaign.shopifyVariantId);
      if (variant) {
        unitPriceByVariant.set(variant, campaign.amountCents);
        campaignByVariant.set(variant, campaign.id);
      }
    }
    const isValePassLine = (line: FinancialLineFacts): boolean => {
      const variant = numericShopifyId(line.variantId);
      const product = numericShopifyId(line.productId);
      return (variant !== null && (unitPriceByVariant.has(variant) || variant === KNOWN_VALE_PASS_VARIANT_ID)) || product === KNOWN_VALE_PASS_PRODUCT_ID;
    };
    // O preço esperado usa o id NUMÉRICO da variante (o webhook manda número; o Admin manda gid): normaliza as linhas antes de validar.
    const normalized: OrderFinancialFacts = { ...facts, lines: facts.lines.map((line) => ({ ...line, variantId: numericShopifyId(line.variantId), productId: numericShopifyId(line.productId) })) };
    const verdict = validateValePassFinancials(normalized, { unitPriceByVariant, isValePassLine, maxUnitsPerOrder: options.maxUnits ?? maxUnitsPerOrder() });
    const campaignIds = [...new Set(normalized.lines.filter(isValePassLine).map((line) => (line.variantId ? campaignByVariant.get(line.variantId) : undefined)).filter((id): id is string => Boolean(id)))];
    return { ...verdict, campaignIds };
  }
}

/** Resumo SEM dados pessoais, para a fila de resolução e a auditoria. */
export function summarizeIssues(issues: readonly FinancialIssue[]): { code: string; detail?: Record<string, string | number | boolean | null> }[] {
  return issues.map((issue) => ({ code: issue.code, ...(issue.detail ? { detail: { ...issue.detail } } : {}) }));
}
