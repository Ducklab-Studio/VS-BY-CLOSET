import { Injectable } from '@nestjs/common';
import { resolveShopifyStorefrontCredentials, type ShopifyStorefrontCredentials } from './checkout.config';

/**
 * Cliente mínimo da Storefront API pra `cartCreate` — só o que a Fase 6
 * precisa. É Storefront pura; a Admin API continua separada.
 *
 * A versão precisa ficar alinhada com os clientes Storefront do Next.js.
 * Usar uma versão retirada faz a Shopify "fall forward" silenciosamente,
 * o que deixa o comportamento real diferente do que o código declara.
 */
const API_VERSION = '2026-07';
const REQUEST_TIMEOUT_MS = 10_000;

export interface CartLineInput {
  readonly merchandiseId: string;
  readonly quantity: number;
}

export interface CartAttributeInput {
  readonly key: string;
  readonly value: string;
}

export interface CartUserError {
  readonly field: readonly string[] | null;
  readonly message: string;
}

export type CartCreateResult =
  | { readonly ok: true; readonly cartId: string; readonly checkoutUrl: string }
  | { readonly ok: false; readonly userErrors: readonly CartUserError[] };

interface CartCreateResponse {
  cartCreate: {
    cart: { id: string; checkoutUrl: string } | null;
    userErrors: CartUserError[];
  } | null;
}

const CART_CREATE_MUTATION = `
  mutation CartCreate($input: CartInput!) {
    cartCreate(input: $input) {
      cart { id checkoutUrl }
      userErrors { field message }
    }
  }
`;

/**
 * Lança em qualquer falha de INFRAESTRUTURA (rede, timeout, HTTP não-2xx,
 * erro de GraphQL no nível do transporte) — quem chama converte isso em
 * 503, nunca em "o carrinho não pôde ser criado por causa da reserva".
 * `userErrors` do próprio `cartCreate` (variante inválida, indisponível
 * etc.) NÃO lança — vira `{ ok: false, userErrors }`, porque isso é uma
 * resposta de negócio válida da Shopify, não uma falha de infra.
 */
export async function shopifyCartCreate(
  credentials: ShopifyStorefrontCredentials,
  lines: readonly CartLineInput[],
  attributes: readonly CartAttributeInput[],
): Promise<CartCreateResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`https://${credentials.shopifyDomain}/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': credentials.storefrontToken,
      },
      body: JSON.stringify({
        query: CART_CREATE_MUTATION,
        variables: { input: { lines, attributes } },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`Falha de rede ao chamar a Storefront API: ${err instanceof Error ? err.name : 'unknown'}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`Storefront API respondeu ${res.status}`);
  }

  const json = (await res.json()) as { data?: CartCreateResponse; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(`Storefront API retornou erro de GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  if (!json.data?.cartCreate) {
    throw new Error('Storefront API não retornou cartCreate.');
  }

  const { cart, userErrors } = json.data.cartCreate;
  if (userErrors.length > 0 || !cart) {
    return { ok: false, userErrors };
  }

  return { ok: true, cartId: cart.id, checkoutUrl: cart.checkoutUrl };
}

export interface VariantPrice {
  readonly variantId: string;
  readonly amount: number;
  readonly currencyCode: string;
}

interface VariantPricesResponse {
  nodes: ({ id: string; price: { amount: string; currencyCode: string } } | null)[];
}

const VARIANT_PRICES_QUERY = `
  query VariantPrices($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        price { amount currencyCode }
      }
    }
  }
`;

/**
 * Preço real de cada variante — usado pelo Mercado Pago (Fase de
 * integração MP) pra calcular o valor da preferência no SERVIDOR. O
 * preço nunca é reimplementado/estimado aqui: é sempre o que a Shopify
 * (fonte única de preço deste projeto) tem cadastrado, buscado ao vivo.
 * Lança em qualquer falha de infraestrutura (mesmo padrão de
 * `shopifyCartCreate`); uma variante que não existe mais some do
 * resultado (nunca lança "not found" — quem chama decide o que fazer
 * com uma lista mais curta que o pedido).
 */
export async function shopifyFetchVariantPrices(
  credentials: ShopifyStorefrontCredentials,
  variantIds: readonly string[],
): Promise<VariantPrice[]> {
  if (variantIds.length === 0) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`https://${credentials.shopifyDomain}/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': credentials.storefrontToken,
      },
      body: JSON.stringify({ query: VARIANT_PRICES_QUERY, variables: { ids: variantIds } }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`Falha de rede ao chamar a Storefront API: ${err instanceof Error ? err.name : 'unknown'}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`Storefront API respondeu ${res.status}`);
  }

  const json = (await res.json()) as { data?: VariantPricesResponse; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(`Storefront API retornou erro de GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
  }

  return (json.data?.nodes ?? [])
    .filter((node): node is NonNullable<typeof node> => node !== null)
    .map((node) => ({ variantId: node.id, amount: Number(node.price.amount), currencyCode: node.price.currencyCode }));
}

/**
 * Wrapper injetável — mesmo padrão de RentalRuleConfigService: existe pra
 * CheckoutService poder ser testado construindo com um cliente FAKE,
 * sem precisar de mock de módulo. A resolução de credenciais mora aqui.
 */
@Injectable()
export class ShopifyCartClient {
  cartCreate(lines: readonly CartLineInput[], attributes: readonly CartAttributeInput[]): Promise<CartCreateResult> {
    const credentials = resolveShopifyStorefrontCredentials();
    return shopifyCartCreate(credentials, lines, attributes);
  }

  fetchVariantPrices(variantIds: readonly string[]): Promise<VariantPrice[]> {
    const credentials = resolveShopifyStorefrontCredentials();
    return shopifyFetchVariantPrices(credentials, variantIds);
  }
}
