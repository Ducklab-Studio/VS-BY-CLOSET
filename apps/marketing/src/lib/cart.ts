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
 * ⚠️ O que chega aqui é conveniência de tela, não garantia. O cliente pode
 * editar qualquer coisa no navegador dele. Quem decide se a reserva vale é
 * o servidor, revalidando contra o banco central antes de confirmar — e a
 * palavra final é da constraint do Postgres, que recusa fisicamente duas
 * reservas sobrepostas da mesma peça.
 */

const STORE_DOMAIN = process.env.NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN ?? '';
const STOREFRONT_TOKEN = process.env.NEXT_PUBLIC_SHOPIFY_STOREFRONT_TOKEN ?? '';
const API_VERSION = '2025-01';

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
  checkoutUrl: string;
  totalQuantity: number;
  cost: {
    subtotalAmount: { amount: string; currencyCode: string };
    totalAmount: { amount: string; currencyCode: string };
  };
  lines: CartLine[];
}

const CART_FIELDS = `
  id
  checkoutUrl
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

async function cartFetch<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  if (!isCartConfigured) {
    throw new Error('Storefront API não configurada.');
  }

  const res = await fetch(`https://${STORE_DOMAIN}/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new Error(`Storefront API respondeu ${res.status}`);

  const json = (await res.json()) as {
    data?: T;
    errors?: { message: string }[];
  };

  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  if (!json.data) throw new Error('Storefront API não retornou dados.');
  return json.data;
}

/* A Cart API reporta erro de negócio em `userErrors`, com HTTP 200 e sem
   `errors` do GraphQL. Ignorar isso faria uma falha ("essa variante não
   existe") passar como sucesso e o cliente ver um carrinho vazio sem
   explicação. */
function throwOnUserErrors(userErrors?: { message: string }[]) {
  if (userErrors?.length) throw new Error(userErrors.map((e) => e.message).join('; '));
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
    { key: '_vsc_sku', value: line.sku },
  ];
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
  const existingId = readStoredCartId();
  const lineInput = {
    merchandiseId: line.variantId,
    quantity: 1,
    attributes: attributesFor(line),
  };

  if (existingId) {
    const data = await cartFetch<{
      cartLinesAdd: { cart: Cart | null; userErrors: { message: string }[] };
    }>(
      `mutation AddLine($cartId: ID!, $lines: [CartLineInput!]!) {
        cartLinesAdd(cartId: $cartId, lines: $lines) {
          cart { ${CART_FIELDS} }
          userErrors { message }
        }
      }`,
      { cartId: existingId, lines: [lineInput] },
    );

    throwOnUserErrors(data.cartLinesAdd.userErrors);
    if (data.cartLinesAdd.cart) return flatten(data.cartLinesAdd.cart);
    // Carrinho salvo expirou entre a leitura e a escrita: cai pro create.
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
  if (!data.cartCreate.cart) throw new Error('Não foi possível criar o carrinho.');

  storeCartId(data.cartCreate.cart.id);
  return flatten(data.cartCreate.cart);
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

/**
 * Quantas peças o cliente já tem no carrinho.
 *
 * É isso que define a duração do aluguel — o cliente não escolhe quantos
 * dias fica, a regra do cliente amarra na quantidade (1-2 peças = 2 dias,
 * 3-4 = 3 dias...). Por isso a data de devolução muda sozinha quando ele
 * adiciona outra peça.
 *
 * ⚠️ Pendência: acessório não deveria contar como peça. Saber o que é
 * acessório depende do nosso banco (é dado nosso, não da Shopify), então
 * por enquanto conta tudo.
 */
export async function countPiecesInCart(): Promise<number> {
  try {
    const cart = await getCart();
    return cart?.totalQuantity ?? 0;
  } catch {
    return 0;
  }
}
