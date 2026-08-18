/**
 * Cliente de leitura da Storefront API.
 *
 * Escopo deliberadamente restrito: só busca produto/coleção para exibir na
 * vitrine com o visual da marca. Carrinho, checkout e o widget de aluguel do
 * PRP não têm como funcionar aqui — dependem de App Blocks, que só existem
 * dentro do tema Liquid (../../theme). O botão "Reservar" desta vitrine leva
 * para lá; ver `productUrl()` abaixo.
 */

const STORE_DOMAIN = process.env.NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN ?? '';
const STOREFRONT_TOKEN = process.env.NEXT_PUBLIC_SHOPIFY_STOREFRONT_TOKEN ?? '';
const API_VERSION = '2025-01';

/**
 * URL pública da loja (o tema Liquid), usada para montar o link de "Reservar".
 * Ex.: https://loja.vallescloset.com.br — ver README para a decisão de domínio.
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
  featuredImage: { url: string; altText: string | null } | null;
  priceRange: {
    minVariantPrice: { amount: string; currencyCode: string };
  };
}

const PRODUCT_FIELDS = `
  id
  handle
  title
  description
  featuredImage { url altText }
  priceRange { minVariantPrice { amount currencyCode } }
`;

export async function listFeaturedProducts(first = 8): Promise<StorefrontProduct[]> {
  const data = await storefrontFetch<{ products: { nodes: StorefrontProduct[] } }>(
    `query FeaturedProducts($first: Int!) {
      products(first: $first, sortKey: BEST_SELLING) {
        nodes { ${PRODUCT_FIELDS} }
      }
    }`,
    { first },
  );
  return data.products.nodes;
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

/**
 * Link para a página de produto no tema Liquid — onde o widget do PRP, o
 * carrinho e o checkout realmente funcionam. Esta vitrine nunca tenta
 * reproduzir esse fluxo.
 */
export function productUrl(handle: string): string {
  if (!STORE_URL) return '#';
  return `${STORE_URL}/products/${handle}`;
}
