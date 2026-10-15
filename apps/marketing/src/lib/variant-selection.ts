/**
 * Escolha da variante (tamanho) na página da peça. Arquivo puro (sem imports)
 * para test/variant-selection.test.mjs.
 *
 * A Shopify é a fonte das variantes: Anderson cadastra "P / M / G" lá e a
 * página passa a oferecer a escolha, sem cadastro duplicado. O vínculo com a
 * peça física continua sendo SEMPRE o ID da variante (nunca o título nem o SKU).
 */

export interface PickableVariant {
  readonly id: string;
  readonly title: string;
  readonly availableForSale?: boolean;
}

/** Título que a Shopify usa quando o produto não tem opções ("Default Title"). */
export function isDefaultVariantTitle(title: string | null | undefined): boolean {
  return !title || title.trim().toLocaleLowerCase() === 'default title';
}

/** Só vale a pena mostrar o seletor quando há mais de uma variante. */
export function needsVariantPicker(variants: readonly PickableVariant[]): boolean {
  return variants.length > 1;
}

/**
 * Variante inicial: a pedida pela URL/estado, se existir; senão a primeira que
 * está à venda; senão a primeira. Nunca devolve um ID que não está na lista.
 */
export function initialVariantId(variants: readonly PickableVariant[], preferredId?: string | null): string | null {
  if (variants.length === 0) return null;
  if (preferredId && variants.some((variant) => variant.id === preferredId)) return preferredId;
  return (variants.find((variant) => variant.availableForSale !== false) ?? variants[0]).id;
}
