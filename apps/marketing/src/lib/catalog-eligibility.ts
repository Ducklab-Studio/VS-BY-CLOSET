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

/** Estado de aluguel de um produto na vitrine. */
export type RentalCatalogStatus = 'available' | 'awaiting';

export interface CatalogVariantState {
  /** Variantes com ao menos uma peça ativa e reservável online. */
  readonly rentable: ReadonlySet<string>;
  /**
   * Variantes que JÁ tiveram alguma peça cadastrada (ativa ou não). `null` = API
   * antiga, que não informa isto: o catálogo volta a esconder tudo que não é reservável.
   */
  readonly registered: ReadonlySet<string> | null;
}

/**
 * Lê a resposta COMPLETA de /availability/catalog-variants. Mesma regra de
 * `parseRentableVariantIds` (resposta inútil → `null`, o chamador falha aberto);
 * `registeredVariantIds` é opcional e ausente em APIs antigas.
 */
export function parseCatalogVariantState(payload: unknown): CatalogVariantState | null {
  const rentable = parseRentableVariantIds(payload);
  if (rentable === null) return null;
  const ids = (payload as { registeredVariantIds?: unknown }).registeredVariantIds;
  if (!Array.isArray(ids)) return { rentable, registered: null };
  return { rentable, registered: new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0)) };
}

/**
 * Três destinos para um produto de aluguel:
 *  - `available`: alguma variante tem peça física reservável → aparece normal;
 *  - `awaiting`: ao menos uma variante nunca teve peça cadastrada e nenhuma está em
 *    operação → aparece como indisponível até o inventário físico existir (o estoque
 *    da Shopify NUNCA vira peça);
 *  - `null`: todas as variantes já tiveram peça e ela saiu de operação
 *    (desativada/arquivada) → some da vitrine, como antes.
 * Compra direta (Valle Pass) é sempre `available`.
 */
export function rentalCatalogStatus(
  product: EligibleProduct,
  state: CatalogVariantState,
  directPurchase: boolean,
): RentalCatalogStatus | null {
  if (directPurchase) return 'available';
  const variants = product.variants?.nodes ?? [];
  if (variants.some((variant) => state.rentable.has(variant.id))) return 'available';
  if (state.registered === null) return null;
  const registered = state.registered;
  // Some só quando TODAS as variantes já tiveram peça (e nenhuma está em operação); uma variante nova, ainda sem peça, mantém o produto visível.
  return variants.every((variant) => registered.has(variant.id)) ? null : 'awaiting';
}

/** Produtos visíveis, cada um com o seu estado. `state === null` (API fora) devolve tudo como disponível. */
export function catalogWithStatus<T extends EligibleProduct>(
  products: readonly T[],
  state: CatalogVariantState | null,
  isDirectPurchase: (product: T) => boolean,
  options: { readonly includeAwaiting: boolean },
): (T & { rentalStatus: RentalCatalogStatus })[] {
  if (state === null) return products.map((product) => ({ ...product, rentalStatus: 'available' as const }));
  const out: (T & { rentalStatus: RentalCatalogStatus })[] = [];
  for (const product of products) {
    const status = rentalCatalogStatus(product, state, isDirectPurchase(product));
    if (status === 'available' || (status === 'awaiting' && options.includeAwaiting)) out.push({ ...product, rentalStatus: status });
  }
  return out;
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
