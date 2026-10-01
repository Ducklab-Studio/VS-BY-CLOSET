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
import { isValePassProduct } from './vale-pass-product';

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
  /** SÓ as linhas que a Shopify confirmou com quantidade > 0 — é o que a tela mostra e o checkout usa. */
  lines: CartLine[];
  /**
   * Linhas que a Shopify manteve com quantidade 0 (variante sem estoque
   * vendável: a Cart API guarda a linha, mas zera a quantidade). Não são peças
   * no carrinho: nunca aparecem como adicionadas e são removidas pelo id real.
   */
  zeroLineIds: string[];
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
  constructor(
    readonly code: 'not_added' | 'shopify' | 'network' | 'config',
    message: string,
    /** Variantes que a Shopify não aceitou (sem estoque vendável), para a tela dizer quais. */
    readonly variantIds: readonly string[] = [],
  ) {
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
  const c = cart as Omit<Cart, 'lines' | 'zeroLineIds'> & { lines: { nodes: CartLine[] } };
  const all = c.lines?.nodes ?? [];
  return {
    ...c,
    lines: all.filter((line) => line.quantity > 0),
    zeroLineIds: all.filter((line) => !(line.quantity > 0)).map((line) => line.id),
  };
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

/**
 * Variantes que NÃO ficaram no carrinho como pedido. A linha precisa existir
 * com exatamente as datas enviadas E quantidade > 0: a Cart API responde sem
 * erro e mantém com quantidade 0 a variante sem estoque vendável — isso não é
 * peça adicionada (era o que fazia a gaveta mostrar quantidade 0 e R$ 0,00).
 */
function missingLines(cart: Cart, lines: readonly RentalLineInput[]): string[] {
  return lines
    .filter(
      (line) =>
        !cart.lines.some(
          (l) =>
            l.merchandise.id === line.variantId &&
            l.quantity > 0 &&
            attributeOf(l, '_vsc_pickup') === line.pickup &&
            attributeOf(l, '_vsc_return') === line.return,
        ),
    )
    .map((line) => line.variantId);
}

function notAdded(variantIds: readonly string[]): CartError {
  return new CartError('not_added', `A Shopify não manteve estas peças no carrinho (sem estoque vendável): ${variantIds.join(', ')}.`, variantIds);
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
  const cart = flatten(data.cart);
  if (cart.zeroLineIds.length === 0) return cart;
  // Linhas com quantidade 0 não são peças: saem do carrinho pelo id real da
  // Shopify. Se a limpeza falhar, a tela continua mostrando só as confirmadas.
  return (await removeLines(cart.id, cart.zeroLineIds).catch(() => null)) ?? cart;
}

/** Várias peças da MESMA reserva: mesmas datas para todas. */
export interface RentalSelectionInput {
  pieces: readonly { variantId: string; sku: string }[];
  /** ISO yyyy-mm-dd */
  pickup: string;
  /** ISO yyyy-mm-dd */
  return: string;
  returnOption?: ReturnChoice | null;
  pickupLabel: string;
  returnLabel: string;
}

type LineUpdate = { id: string; attributes: { key: string; value: string }[] };
type LineAdd = { merchandiseId: string; quantity: number; attributes: { key: string; value: string }[] };

async function linesUpdate(cartId: string, lines: LineUpdate[]): Promise<Cart> {
  const data = await cartFetch<{
    cartLinesUpdate: { cart: Cart | null; userErrors: { message: string }[] };
  }>(
    `mutation UpdateLineDates($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
      cartLinesUpdate(cartId: $cartId, lines: $lines) {
        cart { ${CART_FIELDS} }
        userErrors { message }
      }
    }`,
    { cartId, lines },
  );
  throwOnUserErrors(data.cartLinesUpdate.userErrors);
  if (!data.cartLinesUpdate.cart) throw new CartError('shopify', 'A Shopify não devolveu o carrinho atualizado.');
  return flatten(data.cartLinesUpdate.cart);
}

/** `null` = o carrinho salvo deixou de existir (expirou ou foi fechado na Shopify). */
async function linesAdd(cartId: string, lines: LineAdd[]): Promise<Cart | null> {
  const data = await cartFetch<{
    cartLinesAdd: { cart: Cart | null; userErrors: { message: string }[] };
  }>(
    `mutation AddLine($cartId: ID!, $lines: [CartLineInput!]!) {
      cartLinesAdd(cartId: $cartId, lines: $lines) {
        cart { ${CART_FIELDS} }
        userErrors { message }
      }
    }`,
    { cartId, lines },
  );
  if (!data.cartLinesAdd.cart) return null;
  throwOnUserErrors(data.cartLinesAdd.userErrors);
  return flatten(data.cartLinesAdd.cart);
}

async function cartCreate(lines: LineAdd[]): Promise<Cart> {
  const data = await cartFetch<{
    cartCreate: { cart: Cart | null; userErrors: { message: string }[] };
  }>(
    `mutation CreateCart($lines: [CartLineInput!]!) {
      cartCreate(input: { lines: $lines }) {
        cart { ${CART_FIELDS} }
        userErrors { message }
      }
    }`,
    { lines },
  );
  throwOnUserErrors(data.cartCreate.userErrors);
  if (!data.cartCreate.cart) throw new CartError('shopify', 'Não foi possível criar o carrinho.');
  storeCartId(data.cartCreate.cart.id);
  return flatten(data.cartCreate.cart);
}

/** Remove linhas pelos ids REAIS devolvidos pela Shopify. `null` = carrinho não existe mais. */
async function removeLines(cartId: string, lineIds: readonly string[]): Promise<Cart | null> {
  const data = await cartFetch<{
    cartLinesRemove: { cart: Cart | null; userErrors: { message: string }[] };
  }>(
    `mutation RemoveLine($cartId: ID!, $lineIds: [ID!]!) {
      cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
        cart { ${CART_FIELDS} }
        userErrors { message }
      }
    }`,
    { cartId, lineIds },
  );
  throwOnUserErrors(data.cartLinesRemove.userErrors);
  return data.cartLinesRemove.cart ? flatten(data.cartLinesRemove.cart) : null;
}

/**
 * Variantes que a Shopify diz EXPLICITAMENTE que não estão à venda
 * (`availableForSale: false` = sem estoque vendável). Consulta antes de mexer
 * no carrinho, para não deixar nada pela metade. Se a consulta falhar, segue:
 * a conferência depois da inclusão continua valendo (falha nunca vira "0").
 */
async function unsellableVariants(variantIds: readonly string[]): Promise<string[]> {
  try {
    const data = await cartFetch<{ nodes: ({ id?: string; availableForSale?: boolean } | null)[] }>(
      `query VariantStock($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id availableForSale } } }`,
      { ids: variantIds },
    );
    return (data.nodes ?? []).filter((node) => !!node?.id && node.availableForSale === false).map((node) => node!.id as string);
  } catch {
    return [];
  }
}

const attributeOf = (line: CartLine, key: string) => line.attributes.find((a) => a.key === key)?.value ?? null;

/**
 * Coloca TODAS as peças da reserva no carrinho, juntas e com as mesmas datas —
 * tudo ou nada:
 *  - antes: a Shopify precisa ter cada variante à venda (senão nada é enviado);
 *  - peça que ainda não está no carrinho: entra (uma linha por peça) e só conta
 *    se voltar com quantidade > 0; se alguma não voltar, as linhas criadas
 *    agora são removidas (ids reais) e o erro diz quais falharam;
 *  - peça que já está: a linha passa a ter estas datas (nunca vira duas linhas);
 *  - outras peças do carrinho com a mesma retirada: mesma devolução (é uma
 *    reserva só, e a devolução depende do total de peças);
 *  - o carrinho devolvido é o da Shopify: nenhuma quantidade vem do rascunho.
 */
export async function addRentalSelectionToCart(selection: RentalSelectionInput): Promise<Cart> {
  const lineFor = (piece: { variantId: string; sku: string }): RentalLineInput => ({
    variantId: piece.variantId,
    sku: piece.sku,
    pickup: selection.pickup,
    return: selection.return,
    returnOption: selection.returnOption ?? null,
    pickupLabel: selection.pickupLabel,
    returnLabel: selection.returnLabel,
  });
  const seen = new Set<string>();
  const lines = selection.pieces.filter((p) => (seen.has(p.variantId) ? false : (seen.add(p.variantId), true))).map(lineFor);
  if (lines.length === 0) throw new CartError('not_added', 'Nenhuma peça selecionada.');
  // Valle Pass é vale-presente (compra direta na Shopify), nunca peça de aluguel.
  if (lines.some((line) => isValePassProduct({ variantId: line.variantId }))) {
    throw new CartError('not_added', 'O Valle Pass não entra numa reserva de aluguel.');
  }
  const unsellable = await unsellableVariants(lines.map((line) => line.variantId));
  if (unsellable.length > 0) throw notAdded(unsellable);
  const toAdd = (line: RentalLineInput): LineAdd => ({ merchandiseId: line.variantId, quantity: 1, attributes: attributesFor(line) });

  const createFresh = async () => {
    const created = await cartCreate(lines.map(toAdd));
    const failed = missingLines(created, lines);
    if (failed.length > 0) {
      // Carrinho novo sem a reserva inteira: descartado (nada fica pela metade).
      forgetCart();
      throw notAdded(failed);
    }
    return created;
  };

  const current = readStoredCartId() ? await getCart() : null;
  if (!current) return createFresh();

  const updates: LineUpdate[] = [];
  const adds: LineAdd[] = [];
  const addedLines: RentalLineInput[] = [];
  for (const line of lines) {
    const plan = planCartChange(current.lines, line);
    if (plan.kind === 'update') updates.push({ id: plan.lineId, attributes: attributesFor(line) });
    else if (plan.kind === 'add') {
      adds.push(toAdd(line));
      addedLines.push(line);
    }
  }
  for (const other of current.lines) {
    if (seen.has(other.merchandise.id) || attributeOf(other, '_vsc_pickup') !== selection.pickup) continue;
    const line = lineFor({ variantId: other.merchandise.id, sku: attributeOf(other, '_vsc_sku') ?? other.merchandise.sku ?? '' });
    if (planCartChange([other], line).kind === 'update') updates.push({ id: other.id, attributes: attributesFor(line) });
  }

  let cart = current;
  // Primeiro as peças novas: se a Shopify recusar alguma, nada mais muda.
  if (adds.length > 0) {
    const added = await linesAdd(current.id, adds);
    if (!added) {
      // Carrinho salvo deixou de existir entre a leitura e a escrita: esquece e
      // cria outro com a reserva inteira, em vez de falhar para sempre.
      forgetCart();
      return createFresh();
    }
    const failed = missingLines(added, addedLines);
    if (failed.length > 0) {
      const before = new Set(current.lines.map((line) => line.id));
      const createdNow = [...added.lines.filter((line) => !before.has(line.id)).map((line) => line.id), ...added.zeroLineIds];
      if (createdNow.length > 0) await removeLines(current.id, createdNow).catch(() => null);
      throw notAdded(failed);
    }
    cart = added;
  }
  if (updates.length > 0) cart = await linesUpdate(current.id, updates);
  const failed = missingLines(cart, lines);
  if (failed.length > 0) throw notAdded(failed);
  return cart;
}

/** Uma peça só (sem outras escolhidas): mesma regra da reserva com várias peças. */
export async function addRentalToCart(line: RentalLineInput): Promise<Cart> {
  return addRentalSelectionToCart({ ...line, pieces: [{ variantId: line.variantId, sku: line.sku }] });
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

/** Remove uma linha pelo id REAL devolvido pela Shopify (nunca por variante ou rascunho). */
export async function removeCartLine(lineId: string): Promise<Cart | null> {
  const cartId = readStoredCartId();
  if (!cartId) return null;
  return removeLines(cartId, [lineId]);
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
