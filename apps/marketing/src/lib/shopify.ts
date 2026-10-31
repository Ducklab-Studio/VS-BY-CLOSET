/**
 * Cliente da Storefront API.
 *
 * Este site é a loja — não uma vitrine que linka pra outro lugar. Produto,
 * calendário de aluguel e carrinho acontecem aqui, com a identidade da
 * marca do início ao fim. A Shopify fica invisível por trás: guarda o
 * catálogo, soma o carrinho e cobra.
 *
 * O único momento em que o cliente sai daqui é o checkout — e isso é
 * proposital: a tela de pagamento é da Shopify porque é ela que processa
 * cartão e PIX, é certificada, e é onde ver "Shopify" passa segurança em
 * vez de estranheza.
 *
 * (Histórico: até agosto/2026 este arquivo linkava pro tema Liquid em
 * ../../theme, porque o widget de aluguel de terceiros só existia lá. Com
 * o calendário próprio, o desvio deixou de fazer sentido — mandar o
 * cliente pra um tema genérico no meio da decisão de compra custa venda.)
 */

import { assertShopifyNetworkAllowed } from './shopify-network-guard';
import { catalogWithStatus, parseCatalogVariantState, type RentalCatalogStatus } from './catalog-eligibility';

const STORE_DOMAIN = process.env.NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN ?? '';
const STOREFRONT_TOKEN = process.env.NEXT_PUBLIC_SHOPIFY_STOREFRONT_TOKEN ?? '';
// Versão estável suportada na data desta auditoria. Manter alinhada com
// cart.ts e reservations-api/src/checkout/shopify-storefront-cart.client.ts.
const API_VERSION = '2026-07';

/**
 * URL pública da Shopify, usada apenas nos poucos fluxos que ainda precisam
 * sair deste site (conta/políticas/rastreio). Produto e carrinho são internos.
 */
const STORE_URL = (process.env.NEXT_PUBLIC_SHOPIFY_STORE_URL ?? '').replace(/\/$/, '');

type StorefrontFetchOptions = {
  cache?: RequestCache;
  revalidate?: number;
};

export const isShopifyConfigured = STORE_DOMAIN.length > 0 && STOREFRONT_TOKEN.length > 0;

interface StorefrontResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function storefrontFetch<T>(
  query: string,
  variables?: Record<string, unknown>,
  options: StorefrontFetchOptions = {},
): Promise<T> {
  if (!isShopifyConfigured) {
    throw new Error(
      'Storefront API não configurada. Defina NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN e NEXT_PUBLIC_SHOPIFY_STOREFRONT_TOKEN.',
    );
  }
  assertShopifyNetworkAllowed(STORE_DOMAIN, process.env.NEXT_PUBLIC_SHOPIFY_NETWORK);

  const res = await fetch(`https://${STORE_DOMAIN}/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
    ...(options.cache === 'no-store'
      ? { cache: 'no-store' as const }
      : { next: { revalidate: options.revalidate ?? 60 } }),
  });

  if (!res.ok) {
    throw new Error(`Storefront API respondeu ${res.status}`);
  }

  const json = (await res.json()) as StorefrontResponse<T>;
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join('; '));
  }
  if (!json.data) {
    throw new Error('Storefront API não retornou dados.');
  }
  return json.data;
}

export interface StorefrontProduct {
  id: string;
  handle: string;
  title: string;
  description: string;
  /** Campo nativo da Shopify, preservado para exibição quando preenchido. */
  productType: string;
  images?: { nodes: { url: string; altText: string | null; width?: number | null; height?: number | null }[] };
  featuredImage: { url: string; altText: string | null; width?: number | null; height?: number | null } | null;
  priceRange: {
    minVariantPrice: { amount: string; currencyCode: string };
  };
  variants?: { nodes: { id: string }[] };
  /** Só na listagem: `awaiting` = sem peça física cadastrada, aparece como indisponível. */
  rentalStatus?: RentalCatalogStatus;
}

const PRODUCT_FIELDS = `
  id
  handle
  title
  description
  productType
  featuredImage { url altText width height }
  priceRange { minVariantPrice { amount currencyCode } }
`;

const CATALOG_VARIANT_IDS_FIELD = 'variants(first: 250) { nodes { id } }';

/**
 * Destaques. Mesma regra da listagem (lib/catalog-eligibility.ts): só entra peça
 * que tem peça física reservável cadastrada no ClosetAdmin. Antes os destaques
 * liam a Shopify crua e mostravam produtos que a listagem e os filtros
 * escondiam (ex.: produto com SKU sincronizado mas sem peça física).
 * Busca mais do que `first` porque parte dos mais vendidos pode ser filtrada.
 */
export async function listFeaturedProducts(first = 8): Promise<StorefrontProduct[]> {
  const data = await storefrontFetch<{ products: { nodes: StorefrontProduct[] } }>(
    `query FeaturedProducts($first: Int!) {
      products(first: $first, sortKey: BEST_SELLING) {
        nodes { ${PRODUCT_FIELDS} ${CATALOG_VARIANT_IDS_FIELD} images(first: 2) { nodes { url altText width height } } }
      }
    }`,
    { first: Math.min(Math.max(first * 4, 24), 50) },
  );
  // ISR de 60 s como o resto da home; o ClosetAdmin revalida a home ao cadastrar/alterar peça.
  const eligible = await filterPublicCatalogProducts(dedupeProducts(data.products.nodes), { revalidate: 60 }, { includeAwaiting: false });
  // Destaques da vitrine são estritamente para aluguel de looks/peças (exclui produtos de compra direta como o Valle Pass).
  const rentalProducts = eligible.filter((product) => !isDirectPurchaseProduct(product));
  return rentalProducts.slice(0, first);
}

export interface CatalogCategory {
  slug: string;
  label: string;
  productType?: string;
  productIds?: string[];
}

export interface Catalog {
  products: StorefrontProduct[];
  categories: CatalogCategory[];
}

function categorySlug(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function dedupeProducts(products: StorefrontProduct[]): StorefrontProduct[] {
  return [...new Map(products.map((product) => [product.id || product.handle, product])).values()];
}

export function categoriesFromProducts(products: StorefrontProduct[]): CatalogCategory[] {
  const byType = new Map<string, CatalogCategory>();
  for (const product of products) {
    const productType = product.productType?.trim();
    if (!productType) continue;
    const key = productType.toLocaleLowerCase();
    if (!byType.has(key)) {
      byType.set(key, { slug: categorySlug(productType), label: productType, productType });
    }
  }
  return [...byType.values()].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

export function categoriesFromCollections(
  collections: { handle: string; title: string; productIds: string[] }[],
): CatalogCategory[] {
  return collections
    .filter((collection) => collection.handle !== 'frontpage')
    .map((collection) => ({
      slug: collection.handle,
      label: collection.title,
      productIds: collection.productIds,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

/** Busca a fonte de categorias e produtos diretamente da Shopify.
 *
 * A vitrine usa as Collections, que são a classificação real cadastrada na
 * Shopify. Handles/títulos e os IDs associados são descobertos da resposta,
 * nunca de uma lista mantida no frontend. Sem cache aqui, alterações no Admin
 * aparecem na próxima requisição da vitrine.
 */
export async function listCatalog(first = 250): Promise<Catalog> {
  const products: StorefrontProduct[] = [];
  let collections: { handle: string; title: string; products: { nodes: { id: string }[] } }[] = [];
  let after: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data: {
      products: {
        nodes: StorefrontProduct[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
      collections: {
        nodes: { handle: string; title: string; products: { nodes: { id: string }[] } }[];
      };
    } = await storefrontFetch<{
      products: {
        nodes: StorefrontProduct[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
      collections: {
        nodes: { handle: string; title: string; products: { nodes: { id: string }[] } }[];
      };
    }>(
      `query Catalog($first: Int!, $after: String) {
        products(first: $first, after: $after, sortKey: TITLE) {
          nodes { ${PRODUCT_FIELDS} ${CATALOG_VARIANT_IDS_FIELD} }
          pageInfo { hasNextPage endCursor }
        }
        collections(first: 250) {
          nodes {
            handle
            title
            products(first: 250) { nodes { id } }
          }
        }
      }`,
      { first: Math.min(first, 250), after },
      { cache: 'no-store' },
    );
    products.push(...data.products.nodes);
    collections = data.collections.nodes;
    hasNextPage = data.products.pageInfo.hasNextPage;
    after = data.products.pageInfo.endCursor;
  }

  const uniqueProducts = await filterPublicCatalogProducts(dedupeProducts(products), { cache: 'no-store' }, { includeAwaiting: true });
  const categories = categoriesFromCollections(
    collections.map((collection) => ({
      handle: collection.handle,
      title: collection.title,
      productIds: collection.products.nodes.map((product) => product.id),
    })),
  );
  return { products: uniqueProducts, categories };
}

/**
 * O catálogo comercial vem da Storefront API (a Shopify é a fonte de título,
 * preço, fotos e descrição). Estado de aluguel por produto (ver
 * catalog-eligibility.ts): com peça reservável → normal; NUNCA cadastrado →
 * `awaiting` ("indisponível"), só na listagem; peça cadastrada e fora de
 * operação → some. Em caso de indisponibilidade do endpoint auxiliar, mantém-se
 * a resposta da Shopify para não transformar uma falha transitória em
 * catálogo vazio. O Valle Pass é sempre preservado por ser compra direta.
 */
async function filterPublicCatalogProducts(
  products: StorefrontProduct[],
  cacheMode: { cache: 'no-store' } | { revalidate: number },
  options: { includeAwaiting: boolean },
): Promise<StorefrontProduct[]> {
  const base =
    process.env.RESERVATIONS_API_URL ??
    process.env.RESERVATIONS_API_ADMIN_URL ??
    process.env.NEXT_PUBLIC_RESERVATIONS_API_URL;
  if (!base) return products;

  let state: ReturnType<typeof parseCatalogVariantState> = null;
  try {
    const response = await fetch(`${base.replace(/\/+$/, '')}/availability/catalog-variants`, {
      ...('cache' in cacheMode ? { cache: cacheMode.cache } : { next: { revalidate: cacheMode.revalidate } }),
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) state = parseCatalogVariantState(await response.json());
  } catch {
    state = null;
  }
  // Falha aberta (ver catalog-eligibility.ts), mas nunca em silêncio: fica no log do servidor.
  if (state === null) console.warn('[catalogo] lista de peças reserváveis indisponível — exibindo o catálogo da Shopify sem esse filtro.');
  return catalogWithStatus(products, state, isDirectPurchaseProduct, options);
}

export function isDirectPurchaseProduct(product: StorefrontProduct): boolean {
  const configuredId = process.env.NEXT_PUBLIC_VALE_PASS_PRODUCT_ID?.trim() || '8723909804132';
  const numericId = product.id.match(/(\d+)\s*$/)?.[1] ?? product.id;
  return numericId === (configuredId.match(/(\d+)\s*$/)?.[1] ?? configuredId);
}

export type CategorySlug = string;

export async function listProducts(opts: { first?: number; category?: CategorySlug } = {}): Promise<StorefrontProduct[]> {
  const catalog = await listCatalog(opts.first ?? 250);
  if (!opts.category) return catalog.products;
  const category = catalog.categories.find((item) => item.slug === opts.category);
  return category ? catalog.products.filter((product) => category.productIds?.includes(product.id)) : [];
}

export async function getProductByHandle(handle: string): Promise<StorefrontProduct | null> {
  const data = await storefrontFetch<{ product: StorefrontProduct | null }>(
    `query ProductByHandle($handle: String!) {
      product(handle: $handle) { ${PRODUCT_FIELDS} }
    }`,
    { handle },
  );
  return data.product;
}

// ---------------------------------------------------------------------------
// Detalhe da peça — o que a página de produto precisa
// ---------------------------------------------------------------------------

/**
 * Uma peça física. O `sku` é o campo mais importante aqui: é ele que liga
 * esta variante ao registro de disponibilidade no banco central, e é o que
 * identifica a mesma roupa entre a loja BR e a CL. Peça sem SKU não tem
 * como ser alugada — a página trata esse caso explicitamente em vez de
 * mostrar um calendário que nunca conseguiria reservar nada.
 */
export interface StorefrontVariant {
  id: string;
  sku: string | null;
  title: string;
  availableForSale: boolean;
  price: { amount: string; currencyCode: string };
  /**
   * Opções desta variante como a Shopify cadastrou (ex.: Tamanho = M). É daqui
   * que vêm os seletores da página da peça (lib/product-options.ts) — nunca de
   * uma lista no código. Ausente em dados antigos/demonstração.
   */
  selectedOptions?: { name: string; value: string }[];
}

export interface StorefrontProductDetail extends Omit<StorefrontProduct, 'images' | 'variants'> {
  descriptionHtml: string;
  images: { url: string; altText: string | null; width?: number | null; height?: number | null }[];
  variants: StorefrontVariant[];
}

export async function getProductDetail(handle: string): Promise<StorefrontProductDetail | null> {
  const data = await storefrontFetch<{ product: StorefrontProductDetail | null }>(
    `query ProductDetail($handle: String!) {
      product(handle: $handle) {
        ${PRODUCT_FIELDS}
        descriptionHtml
        images(first: 8) { nodes { url altText width height } }
        variants(first: 100) {
          nodes {
            id
            sku
            title
            availableForSale
            price { amount currencyCode }
            selectedOptions { name value }
          }
        }
      }
    }`,
    { handle },
  );

  if (!data.product) return null;

  // A Storefront API devolve conexões (`{ nodes: [...] }`); achatamos aqui pra
  // que nenhum componente precise saber desse detalhe do GraphQL.
  const raw = data.product as unknown as {
    images: { nodes: { url: string; altText: string | null; width?: number | null; height?: number | null }[] };
    variants: { nodes: StorefrontVariant[] };
  };

  return {
    ...data.product,
    images: raw.images?.nodes ?? [],
    variants: raw.variants?.nodes ?? [],
  };
}

/**
 * Variantes de um produto pelo ID (número ou GID), SOMENTE LEITURA: disponibilidade e preço. Usado pela página do Valle Pass, que conhece o produto pelo ID
 * configurado (`NEXT_PUBLIC_VALE_PASS_PRODUCT_ID`) e não por um handle. `null` = a Shopify não devolveu o produto (por exemplo, não publicado no canal).
 */
export async function getProductVariantsById(
  productId: string,
): Promise<Pick<StorefrontVariant, 'id' | 'availableForSale' | 'price'>[] | null> {
  const id = productId.startsWith('gid://') ? productId : `gid://shopify/Product/${productId}`;
  const data = await storefrontFetch<{
    product: { variants?: { nodes?: Pick<StorefrontVariant, 'id' | 'availableForSale' | 'price'>[] } } | null;
  }>(
    `query ProductVariantsById($id: ID!) {
      product(id: $id) {
        variants(first: 20) { nodes { id availableForSale price { amount currencyCode } } }
      }
    }`,
    { id },
  );
  return data.product?.variants?.nodes ?? null;
}

/** Handles de todas as peças — usado pra pré-gerar as páginas no build. */
export async function listAllProductHandles(first = 250): Promise<string[]> {
  const data = await storefrontFetch<{ products: { nodes: { handle: string }[] } }>(
    `query AllHandles($first: Int!) {
      products(first: $first) { nodes { handle } }
    }`,
    { first },
  );
  return data.products.nodes.map((p) => p.handle);
}

/** Preço formatado na moeda da loja — BRL na loja BR, CLP na do Chile. */
export function formatPrice(amount: string, currencyCode: string, locale = 'pt-BR'): string {
  // `Number('')` e `Number(null)` dão 0: preço ausente viraria "R$ 0,00".
  // Ausente não é zero — sem valor, nada é exibido ("0.0" continua R$ 0,00).
  if (typeof amount !== 'string' || amount.trim() === '') return '';
  const value = Number(amount);
  if (Number.isNaN(value)) return '';
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currencyCode,
      // CLP não usa centavos; deixar o Intl decidir evita "CLP 45.000,00".
      minimumFractionDigits: currencyCode === 'CLP' ? 0 : 2,
    }).format(value);
  } catch {
    // Moeda ausente/inválida: o Intl lança RangeError — não derruba a página.
    return '';
  }
}

/** Loja configurada? Usado pra esconder nav/CTA em vez de linkar pra lugar nenhum. */
export const isStoreUrlConfigured = STORE_URL.length > 0;

/**
 * URL absoluta na loja Shopify. Sobrou pra casos que a Shopify hospeda de
 * fato — conta do cliente, política, rastreio de pedido. Produto e carrinho
 * não passam mais por aqui.
 */
export function storeUrl(path = '/'): string {
  if (!STORE_URL) return '#';
  return `${STORE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Link da peça — agora aponta pra dentro deste site, não pro tema Liquid.
 * Rota relativa de propósito: mantém o cliente no mesmo domínio, o que
 * importa tanto pra percepção de marca quanto pro Google (um site só,
 * em vez de dois competindo pela mesma busca).
 */
export function productUrl(handle: string): string {
  return `/pecas/${handle}`;
}
