import type { RefundFacts, RefundLineFacts } from './refund-facts';

/**
 * Plano de tratamento de um reembolso — função PURA e determinística. Responde: este reembolso devolve quantas UNIDADES do Valle Pass, quais unidades
 * podem ser canceladas com segurança e o que depende de decisão humana. Cada unidade comercial = dois vouchers vinculados (mesmo `group_id`),
 * sempre cancelados juntos.
 *
 * Princípios:
 *  - Reembolso que não toca a linha do Valle Pass (frete, outro produto) NÃO mexe em nenhum voucher.
 *  - Reembolso de N unidades primeiro "absorve" as unidades PAGAS e AINDA NÃO EMITIDAS (não há voucher a cancelar: a emissão posterior as desconta).
 *    Só o que sobrar atinge unidades já emitidas. A Shopify NÃO diz qual unidade foi devolvida; por isso, na política provisória (ADMIN_CONFIRM) o
 *    sistema NÃO cancela voucher emitido sozinho: propõe as unidades mais novas e intocadas e espera a confirmação de um ADMIN (os vouchers propostos
 *    ficam bloqueados para uso enquanto isso). A política AUTO_NEWEST (cancelar sozinho as mais novas) existe, mas só pode ser ligada com aprovação do Anderson.
 *  - Voucher já usado (ou expirado) nunca é cancelado nem "desusado" automaticamente: o que faltar vira REVISÃO administrativa (fail-closed).
 *  - Valor devolvido sem unidade correspondente, quantidade/valor que não fecham ou dado ilegível: REVISÃO, nada automático.
 *  - Nunca reativa voucher cancelado e nunca toca em unidade que não foi reembolsada.
 */
export type VoucherStatus = 'ACTIVE' | 'USED' | 'EXPIRED' | 'CANCELLED';

export interface UnitState {
  readonly groupId: string;
  readonly createdAt: Date;
  readonly vouchers: readonly { readonly id: string; readonly status: VoucherStatus }[];
}

export type UnitStanding = 'UNUSED' | 'CANCELLED' | 'TOUCHED';

export function standingOf(unit: UnitState): UnitStanding {
  if (unit.vouchers.length === 0) return 'TOUCHED';
  if (unit.vouchers.every((voucher) => voucher.status === 'CANCELLED')) return 'CANCELLED';
  if (unit.vouchers.every((voucher) => voucher.status === 'ACTIVE')) return 'UNUSED';
  return 'TOUCHED'; // algum usado/expirado, ou metade cancelada: nunca decidido automaticamente
}

export type RefundClassification = 'UNRELATED' | 'UNITS' | 'AMOUNT_ONLY' | 'NO_UNITS';

/** ADMIN_CONFIRM = provisória e segura (padrão); AUTO_NEWEST = cancela sozinho as unidades intocadas mais novas — NÃO aprovada comercialmente. */
export type IssuedUnitPolicy = 'ADMIN_CONFIRM' | 'AUTO_NEWEST';
export const ISSUED_UNIT_CANCEL_POLICY: IssuedUnitPolicy = 'ADMIN_CONFIRM';

export type ReviewReason =
  | 'UNIT_CONFIRMATION_REQUIRED' // reembolso atinge unidade já emitida e a Shopify não diz qual: o ADMIN confirma
  | 'REFUND_UNDEFINED' // sem id do reembolso/pedido ou quantidade ilegível
  | 'TRANSACTION_UNDEFINED' // valor de transação ilegível
  | 'AMOUNT_ONLY_REFUND' // dinheiro devolvido sem linha de produto nem frete que o explique
  | 'PRICE_UNKNOWN' // variante sem preço configurado
  | 'AMOUNT_MISMATCH' // subtotal/preço da linha diferente de quantidade × preço da campanha
  | 'QUANTITY_EXCEEDS_UNITS' // mais unidades reembolsadas do que existem vivas
  | 'PAID_UNITS_EXCEEDED' // soma de reembolsos acima das unidades pagas
  | 'USED_VOUCHERS'; // faltam unidades intocadas para cancelar: restam unidades com voucher já usado

export interface RefundPlanInput {
  readonly refund: RefundFacts;
  readonly isValePassLine: (line: RefundLineFacts) => boolean;
  /** Preço unitário esperado por variante (id numérico), da campanha no banco. */
  readonly unitPriceByVariant: ReadonlyMap<string, number>;
  /** TODAS as unidades do pedido (inclusive as já canceladas). */
  readonly units: readonly UnitState[];
  /** Unidades já devolvidas por reembolsos anteriores deste pedido (trilha). */
  readonly alreadyRefundedUnits: number;
  /** Unidades pagas do pedido (registro). */
  readonly paidUnits: number;
  /** Unidades pagas ainda sem voucher e não descontadas por reembolso anterior. */
  readonly unissuedUnits?: number;
  readonly policy?: IssuedUnitPolicy;
}

export interface RefundPlan {
  readonly classification: RefundClassification;
  readonly refundedUnits: number;
  /** Unidades a cancelar AGORA (os dois vouchers de cada uma). */
  readonly cancelGroupIds: readonly string[];
  /** Unidades que dependem de decisão humana (voucher usado/expirado/meio cancelado). */
  readonly reviewGroupIds: readonly string[];
  readonly reviewReasons: readonly ReviewReason[];
  /** Quantas das unidades reembolsadas ficaram sem tratamento automático. */
  readonly unitsNeedingReview: number;
  /** Unidades pagas não emitidas que ESTE reembolso absorveu (a emissão posterior as desconta). */
  readonly unissuedAbsorbed: number;
  /** Em revisão: quantas unidades não emitidas seriam absorvidas se o ADMIN confirmar. */
  readonly unissuedProposed: number;
  /** Depois deste reembolso, todas as unidades pagas foram devolvidas. */
  readonly orderFullyRefunded: boolean;
}

const newestFirst = (a: UnitState, b: UnitState) => b.createdAt.getTime() - a.createdAt.getTime() || b.groupId.localeCompare(a.groupId);

export function planRefund(input: RefundPlanInput): RefundPlan {
  const { refund } = input;
  const reasons = new Set<ReviewReason>();
  const none = (classification: RefundClassification, refundedUnits = 0): RefundPlan => ({
    classification, refundedUnits, cancelGroupIds: [], reviewGroupIds: [], reviewReasons: [...reasons], unitsNeedingReview: 0, unissuedAbsorbed: 0, unissuedProposed: 0, orderFullyRefunded: false,
  });
  const unissued = Math.max(0, input.unissuedUnits ?? 0);
  const policy = input.policy ?? ISSUED_UNIT_CANCEL_POLICY;

  if (!refund.refundId || !refund.orderId) {
    reasons.add('REFUND_UNDEFINED');
    return none('NO_UNITS');
  }
  if (refund.transactionsCents === null) reasons.add('TRANSACTION_UNDEFINED');

  const valeLines = refund.lines.filter((line) => input.isValePassLine(line));

  // 1) Nenhuma linha de Valle Pass reembolsada.
  if (valeLines.length === 0) {
    const explained = refund.lines.length > 0 || (refund.shippingRefundCents !== null && refund.shippingRefundCents > 0) || refund.orderAdjustmentCount > 0;
    if (refund.transactionsCents !== null && refund.transactionsCents > 0 && !explained) reasons.add('AMOUNT_ONLY_REFUND');
    if (reasons.size > 0) return none(reasons.has('AMOUNT_ONLY_REFUND') ? 'AMOUNT_ONLY' : 'NO_UNITS');
    return none('UNRELATED'); // frete, outro produto ou cancelamento sem dinheiro: os vouchers não são tocados
  }

  // 2) Linhas de Valle Pass: quantidade e valores têm de fechar com a campanha.
  let refundedUnits = 0;
  for (const line of valeLines) {
    if (line.quantity === null || line.quantity < 1) {
      reasons.add('REFUND_UNDEFINED');
      continue;
    }
    refundedUnits += line.quantity;
    const expected = line.variantId ? input.unitPriceByVariant.get(line.variantId) : undefined;
    if (expected === undefined) {
      reasons.add('PRICE_UNKNOWN');
      continue;
    }
    if (line.unitPriceCents !== null && line.unitPriceCents !== expected) reasons.add('AMOUNT_MISMATCH');
    if (line.subtotalCents === null || line.subtotalCents !== expected * line.quantity) reasons.add('AMOUNT_MISMATCH');
  }

  const alive = input.units.filter((unit) => standingOf(unit) !== 'CANCELLED');
  if (refundedUnits > alive.length + unissued) reasons.add('QUANTITY_EXCEEDS_UNITS');
  if (input.alreadyRefundedUnits + refundedUnits > input.paidUnits) reasons.add('PAID_UNITS_EXCEEDED');

  // Qualquer dúvida sobre valores/quantidades: nada automático — o quadro inteiro vai para revisão.
  if (reasons.size > 0) {
    // PROPOSTA (não aplicada): as unidades mais novas, intocadas primeiro. O ADMIN decide se cancela os vouchers ativos delas ou mantém tudo.
    const proposedUnissued = Math.min(refundedUnits, unissued);
    const proposal = [...alive.filter((unit) => standingOf(unit) === 'UNUSED').sort(newestFirst), ...alive.filter((unit) => standingOf(unit) === 'TOUCHED').sort(newestFirst)];
    return {
      classification: 'UNITS', refundedUnits, cancelGroupIds: [], reviewGroupIds: proposal.slice(0, Math.min(refundedUnits - proposedUnissued, proposal.length)).map((unit) => unit.groupId), reviewReasons: [...reasons], unitsNeedingReview: refundedUnits, unissuedAbsorbed: 0, unissuedProposed: proposedUnissued, orderFullyRefunded: false,
    };
  }

  // 3) Primeiro as unidades pagas e não emitidas (nada a cancelar); depois as emitidas, intocadas e mais novas.
  const absorbed = Math.min(refundedUnits, unissued);
  const rest = refundedUnits - absorbed;
  const unused = input.units.filter((unit) => standingOf(unit) === 'UNUSED').sort(newestFirst);
  const touched = input.units.filter((unit) => standingOf(unit) === 'TOUCHED').sort(newestFirst);
  const cancelCount = Math.min(rest, unused.length);
  const shortfall = rest - cancelCount;
  const chosen = unused.slice(0, cancelCount).map((unit) => unit.groupId);
  const touchedForReview = shortfall > 0 ? touched.slice(0, shortfall).map((unit) => unit.groupId) : [];
  if (shortfall > 0) reasons.add('USED_VOUCHERS');
  const needsConfirmation = policy === 'ADMIN_CONFIRM' && chosen.length > 0;
  if (needsConfirmation) reasons.add('UNIT_CONFIRMATION_REQUIRED');

  return {
    classification: 'UNITS',
    refundedUnits,
    cancelGroupIds: needsConfirmation ? [] : chosen, // sem aprovação comercial, o sistema só PROPÕE
    reviewGroupIds: [...(needsConfirmation ? chosen : []), ...touchedForReview],
    reviewReasons: [...reasons],
    unitsNeedingReview: (needsConfirmation ? chosen.length : 0) + shortfall,
    unissuedAbsorbed: absorbed,
    unissuedProposed: 0,
    orderFullyRefunded: input.alreadyRefundedUnits + refundedUnits >= input.paidUnits,
  };
}

/**
 * Status do PEDIDO no registro depois de um reembolso. Hoje `partially_refunded` vira REFUNDED (o pedido deixa de contar como pago, o e-mail das
 * unidades que sobram é cancelado e a emissão/regularização recusa). Com reembolso parcial de uma compra de várias unidades, o pedido segue pago para
 * as unidades que restam. `null` = sem opinião (usar a regra de sempre).
 */
export function statusAfterRefund(input: { financialStatus: string | null; remainingUnits: number | null }): 'CONFIRMED' | 'REFUNDED' | null {
  const status = input.financialStatus?.trim().toLowerCase() ?? null;
  if (status === 'refunded') return 'REFUNDED';
  if (status === 'partially_refunded') {
    if (input.remainingUnits === null) return null; // sem a contagem atual: não adivinha
    return input.remainingUnits > 0 ? 'CONFIRMED' : 'REFUNDED';
  }
  return null;
}
