/**
 * Quem pode aparecer no catálogo público — UMA regra para destaques, listagem
 * e filtros por categoria. Arquivo puro (sem imports) para
 * test/catalog-eligibility.test.mjs.
 *
 * Um produto de aluguel só aparece quando existe ao menos uma peça física
 * ATIVA e reservável online ligada a uma de suas variantes (a lista vem de
 * GET /availability/catalog-variants, do reservations-api). SKU sincronizado
 * e estoque na Shopify NÃO bastam: sem peça física cadastrada no ClosetAdmin
 * não há o que reservar. O Valle Pass (compra direta) é sempre preservado.
 *
 * Falha aberta de propósito: se a API de reservas estiver fora ou responder
 * algo que não é a lista, o catálogo continua mostrando o que a Shopify tem
 * (uma queda não pode esvaziar a loja). A página do produto, ao consultar a
 * disponibilidade, mostra o estado real de cada peça.
 */

export interface EligibleProduct {
  readonly id: string;
  readonly variants?: { readonly nodes: readonly { readonly id: string }[] } | null;
}

export interface CategoryLike {
  readonly productIds?: readonly string[];
  readonly productType?: string;
}

/**
 * Lê a resposta de /availability/catalog-variants. `null` = resposta inútil
 * (outro formato, versão antiga da API, HTML de erro) → o chamador falha aberto.
 * Lista vazia é válida: significa "nenhuma peça reservável cadastrada".
 */
export function parseRentableVariantIds(payload: unknown): Set<string> | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const ids = (payload as { variantIds?: unknown }).variantIds;
  if (!Array.isArray(ids)) return null;
  return new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0));
}

/** O produto tem alguma variante com peça reservável (ou é de compra direta)? */
export function isRentableProduct(product: EligibleProduct, rentable: ReadonlySet<string>, directPurchase: boolean): boolean {
  if (directPurchase) return true;
  return (product.variants?.nodes ?? []).some((variant) => rentable.has(variant.id));
}

/** Aplica a regra à lista. `rentable === null` (API indisponível) devolve tudo. */
export function filterRentableProducts<T extends EligibleProduct>(
  products: readonly T[],
  rentable: ReadonlySet<string> | null,
  isDirectPurchase: (product: T) => boolean,
): T[] {
  if (rentable === null) return [...products];
  return products.filter((product) => isRentableProduct(product, rentable, isDirectPurchase(product)));
}

/** Produtos de uma categoria: pelos ids da coleção da Shopify ou, sem ids, pelo tipo do produto. */
export function productsInCategory<T extends EligibleProduct & { readonly productType?: string }>(
  products: readonly T[],
  category: CategoryLike,
): T[] {
  return products.filter((product) =>
    category.productIds
      ? category.productIds.includes(product.id)
      : (product.productType ?? '').trim().toLocaleLowerCase() === category.productType?.toLocaleLowerCase(),
  );
}
