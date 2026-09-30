/**
 * Carrinho — Cart API da Storefront.
 *
 * Roda no navegador de propósito. O token da Storefront API é público por
 * design da Shopify (ele só lê catálogo e mexe no carrinho de quem o
 * possui), então não há segredo pra proteger aqui. O que é sensível —
 * token de Admin API, segredo de webhook, string do banco — nunca chega
 * perto deste arquivo.
 *
 * As datas do aluguel viajam como `attributes` da linha do carrinho. Isso
 * é o equivalente, na Cart API, do line item property do tema Liquid: fica
 * preso ao item, não ao pedido. Importa porque um cliente leva várias
 * peças, e numa troca de peça danificada a data tem que andar junto do
 * item certo.
 *
 * Estoque e quantidade vêm da Shopify. `quantityAvailable` é consultado na
 * própria variante e o carrinho usa `cartLinesUpdate` para alterar a
 * quantidade real da linha; preço e total voltam recalculados pela Shopify.
 * A disponibilidade por DATA continua sendo revalidada pelo reservations-api
 * antes de criar o HOLD — estoque comercial e agenda de aluguel são duas
 * travas complementares, nunca substitutas.
 *
 * ⚠️ O que chega aqui é conveniência de tela, não garantia. O cliente pode
 * editar qualquer coisa no navegador dele. Quem decide se a reserva vale é
 * o servidor, revalidando contra o banco central antes de confirmar — e a
 * palavra final é da constraint do Postgres, que recusa fisicamente duas
 * reservas sobrepostas da mesma peça.
 */

import { planCartChange, type ReturnChoice } from './rental-selection';

const STORE_DOMAIN = process.env.NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN ?? '';
const STOREFRONT_TOKEN = process.env.NEXT_PUBLIC_SHOPIFY_STOREFRONT_TOKEN ?? '';
// Versão estável suportada; manter alinhada com shopify.ts e com o cliente
// Storefront server-side do reservations-api.
const API_VERSION = '2026-07';

/* O id do carrinho vive no navegador do cliente. Se ele limpar os dados do
   site, perde o carrinho — e tudo bem: carrinho não é reserva. Reserva só
   existe depois do pagamento, e essa mora no banco. */
const CART_ID_KEY = 'vsc_cart_id';

export interface CartLine {
  id: string;
  quantity: number;
  attributes: { key: string; value: string }[];
  merchandise: {
    id: string;
    sku: string | null;
    title: string;
    availableForSale: boolean;
    /** Quantidade vendável reportada diretamente pela Shopify. */
    quantityAvailable: number | null;
    price: { amount: string; currencyCode: string };
    product: {
      title: string;
      handle: string;
      featuredImage: { url: string; altText: string | null } | null;
    };
  };
}

export interface Cart {
  id: string;
  totalQuantity: number;
  cost: {
    subtotalAmount: { amount: string; currencyCode: string };
    totalAmount: { amount: string; currencyCode: string };
  };
  lines: CartLine[];
}

const CART_FIELDS = `
  id
  totalQuantity
  cost {
    subtotalAmount { amount currencyCode }
    totalAmount { amount currencyCode }
  }
  lines(first: 50) {
    nodes {
      id
      quantity
      attributes { key value }
      merchandise {
        ... on ProductVariant {
          id
          sku
          title
          availableForSale
          quantityAvailable
          price { amount currencyCode }
          product {
            title
            handle
            featuredImage { url altText }
          }
        }
      }
    }
  }
`;

export const isCartConfigured = STORE_DOMAIN.length > 0 && STOREFRONT_TOKEN.length > 0;

/**
 * Falha ao mexer no carrinho, com a causa real em `message` (a tela mostra em
 * desenvolvimento) e um código para a mensagem amigável de produção.
 *  - `not_added`: a Shopify respondeu, mas a peça não ficou no carrinho com as
 *    datas enviadas (ex.: sem estoque na loja);
 *  - `shopify`: erro de negócio/GraphQL da Shopify;
 *  - `network`: sem resposta da Shopify;
 *  - `config`: Storefront não configurada.
 */
export class CartError extends Error {
  constructor(readonly code: 'not_added' | 'shopify' | 'network' | 'config', message: string) {
    super(message);
    this.name = 'CartError';
  }
}

async function cartFetch<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  if (!isCartConfigured) {
    throw new CartError('config', 'Storefront API não configurada.');
  }

  let res: Response;
  try {
    res = await fetch(`https://${STORE_DOMAIN}/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw new CartError('network', 'Sem resposta da Storefront API.');
  }

  if (!res.ok) throw new CartError('shopify', `Storefront API respondeu ${res.status}`);

  const json = (await res.json()) as {
    data?: T;
    errors?: { message: string }[];
  };

  if (json.errors?.length) throw new CartError('shopify', json.errors.map((e) => e.message).join('; '));
  if (!json.data) throw new CartError('shopify', 'Storefront API não retornou dados.');
  return json.data;
}

/* A Cart API reporta erro de negócio em `userErrors`, com HTTP 200 e sem
   `errors` do GraphQL. Ignorar isso faria uma falha ("essa variante não
   existe") passar como sucesso e o cliente ver um carrinho vazio sem
   explicação. */
function throwOnUserErrors(userErrors?: { message: string }[]) {
  if (userErrors?.length) throw new CartError('shopify', userErrors.map((e) => e.message).join('; '));
}

function flatten(cart: unknown): Cart {
  const c = cart as Cart & { lines: { nodes: CartLine[] } };
  return { ...c, lines: c.lines?.nodes ?? [] };
}

function readStoredCartId(): string | null {
  try {
    return localStorage.getItem(CART_ID_KEY);
  } catch {
    // Navegador anônimo ou cookies bloqueados. Segue sem carrinho salvo em
    // vez de quebrar a página inteira.
    return null;
  }
}

function storeCartId(id: string) {
  try {
    localStorage.setItem(CART_ID_KEY, id);
  } catch {
    /* idem */
  }
}

export function forgetCart() {
  try {
    localStorage.removeItem(CART_ID_KEY);
  } catch {
    /* idem */
  }
}

export interface RentalLineInput {
  variantId: string;
  sku: string;
  /** ISO yyyy-mm-dd */
  pickup: string;
  /** ISO yyyy-mm-dd */
  return: string;
  /** Opção escolhida quando a devolução calculada cai no domingo (vai para o HOLD do checkout). */
  returnOption?: ReturnChoice | null;
  /** Como o cliente lê as datas, na língua da loja. */
  pickupLabel: string;
  returnLabel: string;
}

function attributesFor(line: RentalLineInput) {
  return [
    // Sem underscore: o cliente vê no carrinho e no checkout.
    { key: 'Retirada', value: line.pickupLabel },
    { key: 'Devolução', value: line.returnLabel },
    // Com underscore: escondido do cliente, mas segue no pedido pro webhook
    // ler. Formato ISO porque é o servidor que consome, não gente.
    { key: '_vsc_pickup', value: line.pickup },
    { key: '_vsc_return', value: line.return },
    ...(line.returnOption ? [{ key: '_vsc_return_option', value: line.returnOption }] : []),
    { key: '_vsc_sku', value: line.sku },
  ];
}

/** A Shopify confirmou a peça com EXATAMENTE as datas enviadas? A Cart API
 *  pode responder sem erro e mesmo assim não incluir a linha (estoque da loja
 *  esgotado): sem esta checagem, a tela diria "adicionado" com a data antiga. */
function assertLineSaved(cart: Cart, line: RentalLineInput): Cart {
  const saved = cart.lines.some(
    (l) =>
      l.merchandise.id === line.variantId &&
      l.attributes.some((a) => a.key === '_vsc_pickup' && a.value === line.pickup) &&
      l.attributes.some((a) => a.key === '_vsc_return' && a.value === line.return),
  );
  if (!saved) throw new CartError('not_added', 'A Shopify não manteve a peça no carrinho com as datas escolhidas (estoque da loja indisponível?).');
  return cart;
}

export async function getCart(): Promise<Cart | null> {
  const id = readStoredCartId();
  if (!id) return null;

  const data = await cartFetch<{ cart: Cart | null }>(
    `query Cart($id: ID!) { cart(id: $id) { ${CART_FIELDS} } }`,
    { id },
  );

  // Carrinho da Shopify expira (~10 dias) e some. Esquecer o id evita ficar
  // consultando pra sempre um carrinho que não existe mais.
  if (!data.cart) {
    forgetCart();
    return null;
  }
  return flatten(data.cart);
}

export async function addRentalToCart(line: RentalLineInput): Promise<Cart> {
  const lineInput = {
    merchandiseId: line.variantId,
    quantity: 1,
    attributes: attributesFor(line),
  };

  // Carrinho salvo que ainda existe: a mesma peça nunca vira uma segunda linha.
  const current = readStoredCartId() ? await getCart() : null;
  if (current) {
    const plan = planCartChange(current.lines, line);
    if (plan.kind === 'noop') return current;

    if (plan.kind === 'update') {
      const data = await cartFetch<{
        cartLinesUpdate: { cart: Cart | null; userErrors: { message: string }[] };
      }>(
        `mutation UpdateLineDates($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
          cartLinesUpdate(cartId: $cartId, lines: $lines) {
            cart { ${CART_FIELDS} }
            userErrors { message }
          }
        }`,
        { cartId: current.id, lines: [{ id: plan.lineId, attributes: lineInput.attributes }] },
      );
      throwOnUserErrors(data.cartLinesUpdate.userErrors);
      if (!data.cartLinesUpdate.cart) throw new CartError('shopify', 'A Shopify não devolveu o carrinho atualizado.');
      return assertLineSaved(flatten(data.cartLinesUpdate.cart), line);
    }

    const data = await cartFetch<{
      cartLinesAdd: { cart: Cart | null; userErrors: { message: string }[] };
    }>(
      `mutation AddLine($cartId: ID!, $lines: [CartLineInput!]!) {
        cartLinesAdd(cartId: $cartId, lines: $lines) {
          cart { ${CART_FIELDS} }
          userErrors { message }
        }
      }`,
      { cartId: current.id, lines: [lineInput] },
    );

    if (data.cartLinesAdd.cart) {
      throwOnUserErrors(data.cartLinesAdd.userErrors);
      return assertLineSaved(flatten(data.cartLinesAdd.cart), line);
    }
    // Carrinho salvo deixou de existir entre a leitura e a escrita (expirou ou
    // foi fechado na Shopify): esquece e cria outro, em vez de falhar para sempre.
    forgetCart();
  }

  const data = await cartFetch<{
    cartCreate: { cart: Cart | null; userErrors: { message: string }[] };
  }>(
    `mutation CreateCart($lines: [CartLineInput!]!) {
      cartCreate(input: { lines: $lines }) {
        cart { ${CART_FIELDS} }
        userErrors { message }
      }
    }`,
    { lines: [lineInput] },
  );

  throwOnUserErrors(data.cartCreate.userErrors);
  if (!data.cartCreate.cart) throw new CartError('shopify', 'Não foi possível criar o carrinho.');

  storeCartId(data.cartCreate.cart.id);
  return assertLineSaved(flatten(data.cartCreate.cart), line);
}

/**
 * Atualiza a quantidade de UMA linha do carrinho diretamente na Shopify.
 * O total/preço retornado já vem recalculado pela plataforma.
 * Quantidade zero é tratada como remoção explícita.
 */
export async function updateCartLineQuantity(lineId: string, quantity: number): Promise<Cart | null> {
  if (!Number.isInteger(quantity)) throw new Error('Quantidade inválida.');
  if (quantity <= 0) return removeCartLine(lineId);

  const cartId = readStoredCartId();
  if (!cartId) return null;

  const data = await cartFetch<{
    cartLinesUpdate: { cart: Cart | null; userErrors: { message: string }[] };
  }>(
    `mutation UpdateLine($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
      cartLinesUpdate(cartId: $cartId, lines: $lines) {
        cart { ${CART_FIELDS} }
        userErrors { message }
      }
    }`,
    { cartId, lines: [{ id: lineId, quantity }] },
  );

  throwOnUserErrors(data.cartLinesUpdate.userErrors);
  return data.cartLinesUpdate.cart ? flatten(data.cartLinesUpdate.cart) : null;
}

export async function removeCartLine(lineId: string): Promise<Cart | null> {
  const cartId = readStoredCartId();
  if (!cartId) return null;

  const data = await cartFetch<{
    cartLinesRemove: { cart: Cart | null; userErrors: { message: string }[] };
  }>(
    `mutation RemoveLine($cartId: ID!, $lineIds: [ID!]!) {
      cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
        cart { ${CART_FIELDS} }
        userErrors { message }
      }
    }`,
    { cartId, lineIds: [lineId] },
  );

  throwOnUserErrors(data.cartLinesRemove.userErrors);
  return data.cartLinesRemove.cart ? flatten(data.cartLinesRemove.cart) : null;
}

/** Quantidade total desta variante no carrinho, mesmo se a Shopify
 * mantiver duas linhas separadas por atributos diferentes. */
export function quantityForVariant(cart: Cart, variantId: string): number {
  return cart.lines
    .filter((line) => line.merchandise.id === variantId)
    .reduce((sum, line) => sum + line.quantity, 0);
}

/**
 * Quantas peças de aluguel o cliente já tem no carrinho.
 *
 * O fluxo público só adiciona itens reserváveis ao carrinho; acessórios
 * ficam em "Consultar em loja" e não entram aqui. Ainda assim, esta soma é
 * apenas UX: o reservations-api recarrega as RentalUnits reais e recalcula
 * `countsTowardRentalDuration` antes de criar o HOLD, então manipular o
 * navegador nunca altera a regra de duração no backend.
 */
export async function countPiecesInCart(): Promise<number> {
  try {
    const cart = await getCart();
    return cart?.totalQuantity ?? 0;
  } catch {
    return 0;
  }
}

/** Peças da reserva se esta variante for alugada: a mesma peça já no carrinho
 *  não conta duas vezes (alugar de novo só troca as datas daquela linha). */
export async function countPiecesWith(variantId: string): Promise<number> {
  try {
    const cart = await getCart();
    const total = cart?.totalQuantity ?? 0;
    return cart?.lines.some((line) => line.merchandise.id === variantId) ? total : total + 1;
  } catch {
    return 1;
  }
}
