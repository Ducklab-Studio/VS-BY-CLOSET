import { cache } from 'react';
import { formatPrice, getProductVariantsById } from './shopify';
import { VALE_PASS_FALLBACK_PRICE_LABEL, valePassPageGate, type ValePassPageGateReason } from './vale-pass-offer';
import { VALE_PASS_PRODUCT_ID, VALE_PASS_VARIANT_ID, normalizeShopifyId, valePassCheckoutHref } from './vale-pass-product';
import { valePassSaleState, type ValePassSaleState } from './vale-pass-sale';
import { VALE_PASS_TERMS_HREF } from './vale-pass-terms';
import { TERMS_APPROVED } from './vale-pass-terms-draft';

export interface ValePassCheckoutDecision {
  readonly purchasable: boolean;
  readonly gateReason: ValePassPageGateReason;
  /** Endereço do checkout. SÓ existe quando a oferta foi liberada (Shopify aberta + termos publicados e aprovados); fechada, é `null` e nunca chega ao HTML. */
  readonly href: string | null;
}

/**
 * ÚNICO caminho que produz o endereço de checkout do Valle Pass: o cartão da página do produto e a página /valle-pass chamam esta função. Nenhum outro código
 * pode chamar `valePassCheckoutHref` (um teste estático garante isso), então nenhum dos dois caminhos oferece checkout antes da liberação comercial.
 */
export function resolveValePassCheckout(input: { saleState: ValePassSaleState; variantId: string | null | undefined }): ValePassCheckoutDecision {
  const gate = valePassPageGate({ saleState: input.saleState, termsHref: VALE_PASS_TERMS_HREF, termsApproved: TERMS_APPROVED });
  const href = gate.purchasable && input.variantId ? valePassCheckoutHref(input.variantId) : null;
  return { purchasable: href !== null, gateReason: href !== null ? 'ok' : gate.purchasable ? 'sale_closed' : gate.reason, href };
}

export interface ValePassOffer {
  /** O que a Shopify informa para a variante (fail closed: qualquer falha = `closed`). */
  readonly saleState: ValePassSaleState;
  readonly priceLabel: string;
  /** Só é preenchido quando a oferta está PRONTA para compra (venda aberta, termos publicados E aprovados); fechada, o endereço do checkout nem existe no HTML. */
  readonly checkoutHref: string | null;
  readonly termsHref: string | null;
  readonly purchasable: boolean;
  readonly gateReason: ValePassPageGateReason;
}

/**
 * Lê (somente leitura) a disponibilidade e o preço do Valle Pass na Shopify e aplica as regras da página. Qualquer erro, produto ausente ou resposta
 * sem informação mantém a venda FECHADA e o preço aprovado de referência. Memoizado por requisição (metadata e página compartilham a mesma consulta).
 */
export const getValePassOffer = cache(async (): Promise<ValePassOffer> => {
  let variants: Awaited<ReturnType<typeof getProductVariantsById>> = null;
  try {
    variants = await getProductVariantsById(VALE_PASS_PRODUCT_ID);
  } catch {
    variants = null;
  }
  const variant = variants?.find((candidate) => normalizeShopifyId(candidate.id) === VALE_PASS_VARIANT_ID) ?? variants?.[0] ?? null;
  const saleState = valePassSaleState(variant);
  const termsHref = VALE_PASS_TERMS_HREF;
  const decision = resolveValePassCheckout({ saleState, variantId: variant?.id });
  return {
    saleState,
    priceLabel: variant?.price ? formatPrice(variant.price.amount, variant.price.currencyCode) : VALE_PASS_FALLBACK_PRICE_LABEL,
    checkoutHref: decision.href,
    termsHref,
    purchasable: decision.purchasable,
    gateReason: decision.gateReason,
  };
});
