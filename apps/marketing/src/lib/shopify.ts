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

export const isShopifyConfigured = STORE_DOMAIN.length > 0 && STOREFRONT_TOKEN.length > 0;

interface StorefrontResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function storefrontFetch<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  if (!isShopifyConfigured) {
    throw new Error(
      'Storefront API não configurada. Defina NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN e NEXT_PUBLIC_SHOPIFY_STOREFRONT_TOKEN.',
    );
  }

  const res = await fetch(`https://${STORE_DOMAIN}/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
    // Catálogo muda pouco minuto a minuto; revalida a cada 60s (ISR-friendly).
    next: { revalidate: 60 },
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
  /** Campo "Tipo de produto" da Shopify — é o nicho (ver RENTAL_CATEGORIES). */
  productType: string;
  images?: { nodes: { url: string; altText: string | null }[] };
  featuredImage: { url: string; altText: string | null } | null;
  priceRange: {
    minVariantPrice: { amount: string; currencyCode: string };
  };
  /** Id da primeira variante — só populado por `listProducts` (é o que o
   *  catálogo precisa pra checar, em lote, se a peça tem disponibilidade
   *  real; ver ProductCard/CatalogGrid). `undefined` nos outros métodos
   *  desta lib, que não precisam disso. */
  variantId?: string | null;
}

const PRODUCT_FIELDS = `
  id
  handle
  title
  description
  productType
  featuredImage { url altText }
  priceRange { minVariantPrice { amount currencyCode } }
`;

export async function listFeaturedProducts(first = 8): Promise<StorefrontProduct[]> {
  const data = await storefrontFetch<{ products: { nodes: StorefrontProduct[] } }>(
    `query FeaturedProducts($first: Int!) {
      products(first: $first, sortKey: BEST_SELLING) {
        nodes { ${PRODUCT_FIELDS} images(first: 2) { nodes { url altText } } }
      }
    }`,
    { first },
  );
  return data.products.nodes;
}

/**
 * Nichos de aluguel, exatamente como o cliente descreveu — cada um com
 * preço próprio, definido depois por ele direto na Shopify. O valor de
 * `productType` precisa bater com o campo "Tipo de produto" que ele
 * preenche ao cadastrar cada peça: é assim que a Shopify associa uma
 * peça a um nicho sem a gente inventar taxonomia própria.
 */
export const RENTAL_CATEGORIES = [
  { slug: 'jaquetas-couro', label: 'Jaquetas de couro', productType: 'Jaquetas de couro' },
  { slug: 'sobretudo-couro', label: 'Sobretudo de couro', productType: 'Sobretudo de couro' },
  { slug: 'jaquetas-la', label: 'Jaquetas de lã', productType: 'Jaquetas de lã' },
  { slug: 'sobretudo-medio-la', label: 'Sobretudo médio de lã', productType: 'Sobretudo médio de lã' },
  { slug: 'sobretudo-grande-la', label: 'Sobretudo grande de lã', productType: 'Sobretudo grande de lã' },
  { slug: 'conjuntos-tricot', label: 'Conjuntos de tricô', productType: 'Conjuntos de tricô' },
  { slug: 'sobretudo-tricot', label: 'Sobretudo de tricô', productType: 'Sobretudo de tricô' },
  { slug: 'capas-tricot', label: 'Capas de tricô', productType: 'Capas de tricô' },
  { slug: 'botas-couro', label: 'Botas de couro', productType: 'Botas de couro' },
  { slug: 'botas-premium', label: 'Botas premium', productType: 'Botas premium' },
] as const;

export type CategorySlug = (typeof RENTAL_CATEGORIES)[number]['slug'];

/**
 * Catálogo com filtro opcional por nicho. Usa a sintaxe de busca da própria
 * Storefront API (`product_type:'...'`) em vez de buscar tudo e filtrar no
 * servidor — evita paginar centenas de peças só pra descartar a maioria.
 */
export async function listProducts(opts: { first?: number; category?: CategorySlug } = {}): Promise<
  StorefrontProduct[]
> {
  const { first = 100, category } = opts;
  const type = category ? RENTAL_CATEGORIES.find((c) => c.slug === category)?.productType : undefined;

  // Aspas simples escapadas: a sintaxe de busca da Shopify quebra se o
  // tipo tiver aspas — nenhum dos nichos tem, mas evita ficar frágil se
  // um dia alguém cadastrar um tipo com acento estranho ou apóstrofo.
  const query = type ? `product_type:'${type.replace(/'/g, "\\'")}'` : undefined;

  const data = await storefrontFetch<{
    products: { nodes: (StorefrontProduct & { variants: { nodes: { id: string }[] } })[] };
  }>(
    `query Catalog($first: Int!, $query: String) {
      products(first: $first, query: $query, sortKey: TITLE) {
        nodes { ${PRODUCT_FIELDS} variants(first: 1) { nodes { id } } }
      }
    }`,
    { first, query },
  );
  // Achata a conexão de variante — mesmo tratamento de getProductDetail,
  // pra nenhum componente precisar saber desse detalhe do GraphQL. Uma
  // peça física = uma variante (ver comentário em pecas/[handle]/page.tsx);
  // aqui só precisamos SABER QUAL é, pra checar disponibilidade em lote.
  return data.products.nodes.map((node) => ({ ...node, variantId: node.variants?.nodes[0]?.id ?? null }));
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
}

export interface StorefrontProductDetail extends Omit<StorefrontProduct, 'images'> {
  descriptionHtml: string;
  images: { url: string; altText: string | null }[];
  variants: StorefrontVariant[];
}

export async function getProductDetail(handle: string): Promise<StorefrontProductDetail | null> {
  const data = await storefrontFetch<{ product: StorefrontProductDetail | null }>(
    `query ProductDetail($handle: String!) {
      product(handle: $handle) {
        ${PRODUCT_FIELDS}
        descriptionHtml
        images(first: 8) { nodes { url altText } }
        variants(first: 20) {
          nodes {
            id
            sku
            title
            availableForSale
            price { amount currencyCode }
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
    images: { nodes: { url: string; altText: string | null }[] };
    variants: { nodes: StorefrontVariant[] };
  };

  return {
    ...data.product,
    images: raw.images?.nodes ?? [],
    variants: raw.variants?.nodes ?? [],
  };
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
  const value = Number(amount);
  if (Number.isNaN(value)) return '';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
    // CLP não usa centavos; deixar o Intl decidir evita "CLP 45.000,00".
    minimumFractionDigits: currencyCode === 'CLP' ? 0 : 2,
  }).format(value);
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
