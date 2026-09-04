import { Injectable } from '@nestjs/common';
import { resolveShopifyStorefrontCredentials, type ShopifyStorefrontCredentials } from './checkout.config';

/**
 * Cliente mínimo da Storefront API pra `cartCreate` — só o que a Fase 6
 * precisa (item 18: Admin API continua fora, isto é Storefront pura).
 * Padrão de chamada idêntico ao já usado em
 * apps/marketing/src/lib/shopify.ts (mesmo formato de erro, mesma
 * versão de API) — não é uma segunda implementação de cliente Shopify,
 * é a mesma ideia, só que rodando neste servidor (que não compartilha
 * `.env` com o Next.js).
 */
const API_VERSION = '2025-01';
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
    // Rede caiu ou o timeout do AbortController disparou — mesma
    // categoria (infra), o chamador não precisa diferenciar.
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

/**
 * Wrapper injetável — mesmo padrão de RentalRuleConfigService: existe pra
 * CheckoutService poder ser testado construindo com um cliente FAKE
 * (`new CheckoutService(prisma, config, fakeCartClient)`), sem precisar
 * de mock de módulo. A resolução de credenciais mora aqui dentro (não em
 * CheckoutService) — quem usa o cliente real não precisa saber de onde
 * vêm o domínio/token.
 */
@Injectable()
export class ShopifyCartClient {
  cartCreate(lines: readonly CartLineInput[], attributes: readonly CartAttributeInput[]): Promise<CartCreateResult> {
    const credentials = resolveShopifyStorefrontCredentials();
    return shopifyCartCreate(credentials, lines, attributes);
  }
}
