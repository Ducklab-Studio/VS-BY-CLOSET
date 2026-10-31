import { cache } from 'react';
import { formatPrice, getProductVariantsById } from './shopify';
import { VALE_PASS_FALLBACK_PRICE_LABEL, valePassPageGate, type ValePassPageGateReason } from './vale-pass-offer';
import { VALE_PASS_PRODUCT_ID, VALE_PASS_VARIANT_ID, normalizeShopifyId } from './vale-pass-product';
import { valePassSaleState, type ValePassSaleState } from './vale-pass-sale';
import { VALE_PASS_TERMS_HREF } from './vale-pass-terms';

export interface ValePassOffer {
  /** O que a Shopify informa para a variante (fail closed: qualquer falha = `closed`). */
  readonly saleState: ValePassSaleState;
  readonly priceLabel: string;
  /** Só é preenchido quando a oferta está PRONTA para compra (venda aberta E termos publicados); fechada, o endereço do checkout nem existe no HTML. */
  readonly checkoutVariantId: string | null;
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
  const gate = valePassPageGate({ saleState, termsHref });
  return {
    saleState,
    priceLabel: variant?.price ? formatPrice(variant.price.amount, variant.price.currencyCode) : VALE_PASS_FALLBACK_PRICE_LABEL,
    checkoutVariantId: gate.purchasable && variant ? variant.id : null,
    termsHref,
    purchasable: gate.purchasable,
    gateReason: gate.reason,
  };
});
