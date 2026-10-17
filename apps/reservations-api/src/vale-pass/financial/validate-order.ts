import { formatCentsBRL, multiplyCents } from './money';
import type { FinancialLineFacts, OrderFinancialFacts } from './order-facts';

/**
 * Validação financeira de um pedido de Valle Pass — função PURA e determinística (mesma entrada, mesmo veredito; reentrega, atraso e ordem
 * dos webhooks não mudam o resultado). Política FAIL-CLOSED: qualquer fato indefinido, inconsistente ou fora do esperado produz um problema;
 * só um pedido sem NENHUM problema é "válido". Este módulo não emite, não cancela, não retém e não reembolsa: só diz o que está errado. Quem o usar
 * (integração futura) decide levar o pedido à fila de resolução administrativa — nunca descarta o pagamento.
 *
 * Valores esperados vêm de configuração comercial CONFIÁVEL (preço da campanha no banco, moeda fixa, teto de quantidade), nunca do payload.
 */
export const EXPECTED_CURRENCY = 'BRL';
export const DEFAULT_MAX_UNITS_PER_ORDER = 10;

export type FinancialIssueCode =
  | 'FINANCIALS_UNDEFINED' // o pedido não traz nenhum dado financeiro (ex.: consulta antiga da Admin API)
  | 'NOT_FULLY_PAID' // pendente (Pix aguardando), autorizado, parcialmente pago, estornado, anulado...
  | 'ORDER_CANCELLED'
  | 'OUTSTANDING_BALANCE' // saldo em aberto
  | 'OUTSTANDING_UNDEFINED'
  | 'CURRENCY_MISMATCH'
  | 'CURRENCY_UNDEFINED'
  | 'NO_VALLE_PASS_LINE'
  | 'MIXED_CART' // linhas que não são Valle Pass no mesmo pedido (não suportado)
  | 'UNKNOWN_VALE_PASS_VARIANT' // variante/produto do Valle Pass sem campanha com preço configurado
  | 'PRICE_UNDEFINED'
  | 'PRICE_MISMATCH'
  | 'DISCOUNT_PRESENT'
  | 'DISCOUNT_UNDEFINED'
  | 'QUANTITY_INVALID'
  | 'QUANTITY_UNDEFINED'
  | 'QUANTITY_OUT_OF_RANGE'
  | 'QUANTITY_CHANGED' // unidades removidas/reembolsadas depois do pedido
  | 'REFUND_PRESENT'
  | 'EXTRA_CHARGES' // frete
  | 'TOTAL_UNDEFINED'
  | 'TOTAL_MISMATCH';

export interface FinancialIssue {
  readonly code: FinancialIssueCode;
  /** Sem dados pessoais: códigos, centavos, nomes de status e ids numéricos de variante. */
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
}

export type FinancialVerdict =
  | { readonly ok: true; readonly units: number; readonly passTotalCents: number }
  | { readonly ok: false; readonly issues: readonly FinancialIssue[]; readonly units: number | null; readonly passTotalCents: number | null };

export interface FinancialExpectations {
  /** Preço unitário esperado, em centavos, por variante (chave = id numérico da variante). Vem da campanha (banco). */
  readonly unitPriceByVariant: ReadonlyMap<string, number>;
  /** Linhas deste produto/variante conhecidos também são Valle Pass (mesma regra de `valePassUnits`). */
  readonly isValePassLine: (line: FinancialLineFacts) => boolean;
  readonly maxUnitsPerOrder: number;
}

const hasNoFinancialData = (facts: OrderFinancialFacts): boolean =>
  facts.currency === null &&
  facts.currentTotalCents === null &&
  facts.totalOutstandingCents === null &&
  facts.lines.every((line) => line.unitPriceCents === null && line.discountCents === null);

export function validateValePassFinancials(facts: OrderFinancialFacts, expected: FinancialExpectations): FinancialVerdict {
  const issues: FinancialIssue[] = [];
  const add = (code: FinancialIssueCode, detail?: FinancialIssue['detail']) => issues.push(detail ? { code, detail } : { code });

  // Pedido sem NENHUM dado financeiro (ex.: payload montado pela reconciliação antiga): não dá para validar → recusa explícita.
  if (hasNoFinancialData(facts)) {
    add('FINANCIALS_UNDEFINED', { source: facts.source });
    return { ok: false, issues, units: null, passTotalCents: null };
  }

  // 1) Pagamento: só `paid` conta. Pix aguardando = pending; cartão só autorizado = authorized; parcial, estornado ou anulado não valem.
  if (facts.financialStatus !== 'paid') add('NOT_FULLY_PAID', { status: facts.financialStatus });
  if (facts.cancelled) add('ORDER_CANCELLED');
  if (facts.totalOutstandingCents === null) add('OUTSTANDING_UNDEFINED');
  else if (facts.totalOutstandingCents > 0) add('OUTSTANDING_BALANCE', { outstandingCents: facts.totalOutstandingCents });
  if (facts.refundCount !== null && facts.refundCount > 0) add('REFUND_PRESENT', { refunds: facts.refundCount });

  // 2) Moeda: a da loja e a que o cliente viu precisam ser BRL.
  for (const [field, value] of [['shop', facts.currency], ['presentment', facts.presentmentCurrency]] as const) {
    if (value === null) add('CURRENCY_UNDEFINED', { field });
    else if (value !== EXPECTED_CURRENCY) add('CURRENCY_MISMATCH', { field, currency: value });
  }

  // 3) Linhas.
  const valeLines = facts.lines.filter((line) => expected.isValePassLine(line));
  const otherLines = facts.lines.length - valeLines.length;
  if (valeLines.length === 0) add('NO_VALLE_PASS_LINE');
  if (otherLines > 0) add('MIXED_CART', { otherLines });

  let units = 0;
  let expectedTotal: number | null = 0;
  for (const line of valeLines) {
    const variant = line.variantId;
    const unitExpected = variant ? expected.unitPriceByVariant.get(variant) : undefined;
    const lineRef = { variant: variant ?? null };

    if (line.quantity === null) add('QUANTITY_UNDEFINED', lineRef);
    else if (!Number.isInteger(line.quantity) || line.quantity < 1) add('QUANTITY_INVALID', { ...lineRef, quantity: line.quantity });
    else {
      if (line.quantity > expected.maxUnitsPerOrder) add('QUANTITY_OUT_OF_RANGE', { ...lineRef, quantity: line.quantity, max: expected.maxUnitsPerOrder });
      units += line.quantity;
      if (line.currentQuantity === null) add('QUANTITY_UNDEFINED', { ...lineRef, field: 'current_quantity' });
      else if (line.currentQuantity !== line.quantity) add('QUANTITY_CHANGED', { ...lineRef, quantity: line.quantity, currentQuantity: line.currentQuantity });
    }

    if (unitExpected === undefined) {
      add('UNKNOWN_VALE_PASS_VARIANT', lineRef);
      expectedTotal = null;
    } else {
      if (line.unitPriceCents === null) add('PRICE_UNDEFINED', lineRef);
      else if (line.unitPriceCents !== unitExpected) add('PRICE_MISMATCH', { ...lineRef, paidUnitCents: line.unitPriceCents, expectedUnitCents: unitExpected });
      if (line.unitPriceCurrency !== null && line.unitPriceCurrency !== EXPECTED_CURRENCY) add('CURRENCY_MISMATCH', { field: 'line', currency: line.unitPriceCurrency });
      if (line.unitPriceCurrency === null) add('CURRENCY_UNDEFINED', { field: 'line' });
      if (expectedTotal !== null && line.quantity !== null && Number.isInteger(line.quantity) && line.quantity >= 1) {
        const lineTotal = multiplyCents(unitExpected, line.quantity);
        expectedTotal = lineTotal === null ? null : expectedTotal + lineTotal;
      } else {
        expectedTotal = null;
      }
    }

    if (line.discountCents === null) add('DISCOUNT_UNDEFINED', lineRef);
    else if (line.discountCents > 0) add('DISCOUNT_PRESENT', { ...lineRef, discountCents: line.discountCents });
  }

  // 4) Descontos do pedido: HOJE nenhum desconto é aceito (cupons permitidos são uma decisão comercial pendente). Qualquer código de desconto ou
  //    desconto total > 0 — inclusive automático, sem código — vai para a resolução administrativa.
  if (facts.discountCodes.length > 0) add('DISCOUNT_PRESENT', { codes: facts.discountCodes.length });
  if (facts.totalDiscountsCents === null) add('DISCOUNT_UNDEFINED', { field: 'order' });
  else if (facts.totalDiscountsCents > 0) add('DISCOUNT_PRESENT', { totalDiscountsCents: facts.totalDiscountsCents });

  // 5) Frete e total: o total pago precisa ser EXATAMENTE unidades × preço da campanha.
  if (facts.totalShippingCents !== null && facts.totalShippingCents > 0) add('EXTRA_CHARGES', { shippingCents: facts.totalShippingCents });
  if (facts.currentTotalCents === null) add('TOTAL_UNDEFINED');
  else if (expectedTotal !== null && facts.currentTotalCents !== expectedTotal) {
    add('TOTAL_MISMATCH', { paidCents: facts.currentTotalCents, expectedCents: expectedTotal, message: `pago ${formatCentsBRL(facts.currentTotalCents)}, esperado ${formatCentsBRL(expectedTotal)}` });
  }

  if (issues.length === 0 && expectedTotal !== null) return { ok: true, units, passTotalCents: expectedTotal };
  return { ok: false, issues, units: units > 0 ? units : null, passTotalCents: expectedTotal };
}
