import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

const SHOPIFY_ADMIN_API_VERSION = '2026-07';
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_SAFETY_MS = 60_000;

export interface ShopifyCatalogVariant {
  readonly id: string;
  readonly title: string;
  readonly sku: string | null;
  readonly inventoryQuantity: number | null;
  readonly imageUrl: string | null;
  readonly imageAlt: string | null;
  readonly selectedOptions: readonly { name: string; value: string }[];
  readonly product: {
    readonly id: string;
    readonly title: string;
    readonly handle: string;
    readonly productType: string;
    readonly status: string;
  };
}

/** Estado comercial de um pedido, só leitura (usado pela reconciliação). */
export interface ShopifyOrderState {
  /** GID (gid://shopify/Order/123). */
  readonly gid: string;
  /** Id numérico — o mesmo valor que os webhooks trazem em `id`. */
  readonly orderId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cancelledAt: string | null;
  readonly closedAt: string | null;
  /** Minúsculo: paid, pending, voided, expired, refunded... */
  readonly financialStatus: string | null;
  /** `reservation_id` gravado nos atributos do pedido, se houver. */
  readonly reservationId: string | null;
}

/** Pedido com linhas (só ids e quantidade), para a reconciliação do Valle
 *  Pass. Sem dados de cliente: exigiriam escopo extra e não são necessários
 *  para decidir o status — o webhook é quem traz o contato. */
export interface ShopifyOrderWithLines {
  readonly gid: string;
  readonly orderId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cancelledAt: string | null;
  /** Minúsculo: customer, declined, fraud, inventory, other, staff. */
  readonly cancelReason: string | null;
  /** Minúsculo: paid, pending, voided, expired, refunded... */
  readonly financialStatus: string | null;
  /** Ids numéricos (o mesmo formato do webhook REST). */
  readonly lines: readonly { readonly variantId: string | null; readonly productId: string | null; readonly quantity: number }[];
}

interface ShopifyAdminCredentials {
  readonly shopifyDomain: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

interface AccessTokenResponse {
  readonly access_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
}

interface GraphqlEnvelope<T> {
  readonly data?: T;
  readonly errors?: readonly { message?: string }[];
}

interface RawShopifyVariant {
  readonly id: string;
  readonly title: string;
  readonly sku: string | null;
  readonly inventoryQuantity: number | null;
  readonly image: { readonly url: string; readonly altText: string | null } | null;
  readonly selectedOptions: readonly { name: string; value: string }[];
  readonly product: {
    readonly id: string;
    readonly title: string;
    readonly handle: string;
    readonly productType: string;
    readonly status: string;
  };
}

interface VariantsQueryData {
  readonly productVariants: {
    readonly nodes: readonly RawShopifyVariant[];
    readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
  };
}

interface VariantQueryData {
  readonly productVariant: RawShopifyVariant | null;
}

const VARIANTS_QUERY = `
  query ClosetAdminVariants($first: Int!, $after: String) {
    productVariants(first: $first, after: $after) {
      nodes {
        id
        title
        sku
        inventoryQuantity
        image { url altText }
        selectedOptions { name value }
        product { id title handle productType status }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ORDER_FIELDS = `
  id
  name
  createdAt
  updatedAt
  cancelledAt
  closedAt
  displayFinancialStatus
  customAttributes { key value }
`;

const ORDERS_BY_ID_QUERY = `
  query ClosetAdminOrdersById($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order { ${ORDER_FIELDS} }
    }
  }
`;

const RECENT_ORDERS_QUERY = `
  query ClosetAdminRecentOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes { ${ORDER_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// Custo por página (limite da Shopify: 1000 pontos por consulta): 10 pedidos ×
// 20 linhas × 3 objetos ≈ 630 pontos. Por isso a página é pequena.
const ORDERS_WITH_LINES_PAGE = 10;
const ORDER_WITH_LINES_FIELDS = `
  id
  name
  createdAt
  updatedAt
  cancelledAt
  cancelReason
  displayFinancialStatus
  lineItems(first: 20) { nodes { quantity variant { id } product { id } } }
`;

const ORDERS_WITH_LINES_QUERY = `
  query ClosetAdminValePassOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      nodes { ${ORDER_WITH_LINES_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ORDERS_WITH_LINES_BY_ID_QUERY = `
  query ClosetAdminValePassOrdersById($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order { ${ORDER_WITH_LINES_FIELDS} }
    }
  }
`;

interface RawShopifyOrderWithLines {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cancelledAt: string | null;
  readonly cancelReason: string | null;
  readonly displayFinancialStatus: string | null;
  readonly lineItems: { readonly nodes: readonly { quantity: number; variant: { id: string } | null; product: { id: string } | null }[] };
}

interface RawShopifyOrder {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cancelledAt: string | null;
  readonly closedAt: string | null;
  readonly displayFinancialStatus: string | null;
  readonly customAttributes: readonly { key: string; value: string | null }[];
}

const VARIANT_QUERY = `
  query ClosetAdminVariant($id: ID!) {
    productVariant(id: $id) {
      id
      title
      sku
      inventoryQuantity
      image { url altText }
      selectedOptions { name value }
      product { id title handle productType status }
    }
  }
`;

/**
 * Cliente read-only da GraphQL Admin API usado pelo ClosetAdmin.
 *
 * Autenticação: client credentials grant do app instalado na própria loja.
 * O Client Secret já existe no reservations-api para validar webhooks; o
 * Client ID é uma variável separada. O access token temporário fica só em
 * memória e nunca é persistido, logado ou devolvido ao frontend.
 *
 * Este cliente NÃO altera produto, estoque, pedido, pagamento ou refund.
 * Shopify continua sendo a fonte comercial; o painel só lê catálogo para
 * criar/vincular RentalUnits operacionais no Postgres.
 */
@Injectable()
export class ShopifyAdminClient {
  private readonly logger = new Logger(ShopifyAdminClient.name);
  private cachedToken: { value: string; expiresAtMs: number } | null = null;

  async listVariants(): Promise<ShopifyCatalogVariant[]> {
    const variants: ShopifyCatalogVariant[] = [];
    let after: string | null = null;

    do {
      const data: VariantsQueryData = await this.graphql<VariantsQueryData>(VARIANTS_QUERY, { first: 100, after });
      variants.push(...data.productVariants.nodes.map(normalizeVariant));
      after = data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
    } while (after);

    return variants;
  }

  async getVariant(id: string): Promise<ShopifyCatalogVariant | null> {
    const data = await this.graphql<VariantQueryData>(VARIANT_QUERY, { id });
    return data.productVariant ? normalizeVariant(data.productVariant) : null;
  }

  /** Pedidos por GID. `null` = a Shopify não devolveu o pedido (excluído — ou
   *  fora da janela de leitura do app; quem chama decide o que isso significa). */
  async getOrdersByGid(gids: readonly string[]): Promise<Map<string, ShopifyOrderState | null>> {
    const result = new Map<string, ShopifyOrderState | null>();
    for (let i = 0; i < gids.length; i += 100) {
      const chunk = gids.slice(i, i + 100);
      const data = await this.graphql<{ nodes: (RawShopifyOrder | null)[] }>(ORDERS_BY_ID_QUERY, { ids: chunk });
      chunk.forEach((gid, index) => {
        const node = data.nodes[index];
        result.set(gid, node && node.id ? normalizeOrder(node) : null);
      });
    }
    return result;
  }

  /** Pedidos criados desde `sinceIso`, do mais novo para o mais antigo. */
  async listOrdersCreatedSince(sinceIso: string, max: number): Promise<{ orders: ShopifyOrderState[]; truncated: boolean }> {
    const orders: ShopifyOrderState[] = [];
    let after: string | null = null;
    let truncated = false;
    do {
      const data: { orders: { nodes: RawShopifyOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await this.graphql(RECENT_ORDERS_QUERY, {
        first: 100,
        after,
        query: `created_at:>=${sinceIso}`,
      });
      orders.push(...data.orders.nodes.map(normalizeOrder));
      after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
      if (after && orders.length >= max) {
        truncated = true;
        after = null;
      }
    } while (after);
    return { orders: orders.slice(0, max), truncated };
  }

  /** Pedidos ALTERADOS desde `sinceIso` (criados, pagos, expirados,
   *  cancelados...), do mais recente para o mais antigo, página a página até
   *  `maxPages`. `truncated` = havia mais páginas do que o teto. */
  async listOrdersWithLinesUpdatedSince(sinceIso: string, maxPages: number): Promise<{ orders: ShopifyOrderWithLines[]; truncated: boolean }> {
    const orders: ShopifyOrderWithLines[] = [];
    let after: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const data: { orders: { nodes: RawShopifyOrderWithLines[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await this.graphql(
        ORDERS_WITH_LINES_QUERY,
        { first: ORDERS_WITH_LINES_PAGE, after, query: `updated_at:>='${sinceIso}'` },
      );
      orders.push(...data.orders.nodes.map(normalizeOrderWithLines));
      after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
      if (!after) return { orders, truncated: false };
    }
    return { orders, truncated: true };
  }

  /** Mesmos campos, por GID. `null` = a Shopify não devolveu o pedido. */
  async getOrdersWithLinesByGid(gids: readonly string[]): Promise<Map<string, ShopifyOrderWithLines | null>> {
    const result = new Map<string, ShopifyOrderWithLines | null>();
    for (let i = 0; i < gids.length; i += ORDERS_WITH_LINES_PAGE) {
      const chunk = gids.slice(i, i + ORDERS_WITH_LINES_PAGE);
      const data = await this.graphql<{ nodes: (RawShopifyOrderWithLines | null)[] }>(ORDERS_WITH_LINES_BY_ID_QUERY, { ids: chunk });
      chunk.forEach((gid, index) => {
        const node = data.nodes[index];
        result.set(gid, node && node.id ? normalizeOrderWithLines(node) : null);
      });
    }
    return result;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const credentials = resolveShopifyAdminCredentials();
    const accessToken = await this.getAccessToken(credentials);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`https://${credentials.shopifyDomain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (err) {
      this.logger.error(`Falha de rede na Shopify Admin API: ${err instanceof Error ? err.name : 'unknown'}`);
      throw new ServiceUnavailableException('Não foi possível consultar o catálogo da Shopify no momento.');
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      if (response.status === 401) this.cachedToken = null;
      this.logger.error(`Shopify Admin API respondeu HTTP ${response.status}`);
      throw new ServiceUnavailableException('Não foi possível consultar o catálogo da Shopify no momento.');
    }

    let json: GraphqlEnvelope<T>;
    try {
      json = (await response.json()) as GraphqlEnvelope<T>;
    } catch {
      this.logger.error('Shopify Admin API retornou JSON inválido.');
      throw new ServiceUnavailableException('Não foi possível consultar o catálogo da Shopify no momento.');
    }

    if (json.errors?.length || !json.data) {
      this.logger.error(`Shopify Admin API retornou ${json.errors?.length ?? 0} erro(s) GraphQL.`);
      throw new ServiceUnavailableException('Não foi possível consultar o catálogo da Shopify no momento.');
    }

    return json.data;
  }

  private async getAccessToken(credentials: ShopifyAdminCredentials): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAtMs - TOKEN_REFRESH_SAFETY_MS > Date.now()) {
      return this.cachedToken.value;
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`https://${credentials.shopifyDomain}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      this.logger.error(`Falha ao obter token Shopify: ${err instanceof Error ? err.name : 'unknown'}`);
      throw new ServiceUnavailableException('Integração com a Shopify temporariamente indisponível.');
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      this.logger.error(`OAuth da Shopify respondeu HTTP ${response.status}`);
      throw new ServiceUnavailableException('Integração com a Shopify não pôde ser autenticada.');
    }

    const json = (await response.json().catch(() => null)) as AccessTokenResponse | null;
    if (!json?.access_token) {
      this.logger.error('OAuth da Shopify não retornou access_token.');
      throw new ServiceUnavailableException('Integração com a Shopify não pôde ser autenticada.');
    }

    const lifetimeSeconds = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 86_400;
    this.cachedToken = {
      value: json.access_token,
      expiresAtMs: Date.now() + lifetimeSeconds * 1000,
    };
    return json.access_token;
  }
}

function normalizeOrder(raw: RawShopifyOrder): ShopifyOrderState {
  const reservationId = raw.customAttributes?.find((attribute) => attribute.key === 'reservation_id')?.value?.trim();
  return {
    gid: raw.id,
    orderId: raw.id.slice(raw.id.lastIndexOf("/") + 1),
    name: raw.name,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    cancelledAt: raw.cancelledAt,
    closedAt: raw.closedAt,
    financialStatus: raw.displayFinancialStatus ? raw.displayFinancialStatus.toLowerCase() : null,
    reservationId: reservationId || null,
  };
}

const lastSegment = (gid: string | null | undefined) => (gid ? gid.slice(gid.lastIndexOf('/') + 1) || null : null);

function normalizeOrderWithLines(raw: RawShopifyOrderWithLines): ShopifyOrderWithLines {
  return {
    gid: raw.id,
    orderId: lastSegment(raw.id) ?? raw.id,
    name: raw.name,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    cancelledAt: raw.cancelledAt,
    cancelReason: raw.cancelReason ? raw.cancelReason.toLowerCase() : null,
    financialStatus: raw.displayFinancialStatus ? raw.displayFinancialStatus.toLowerCase() : null,
    lines: (raw.lineItems?.nodes ?? []).map((line) => ({ variantId: lastSegment(line.variant?.id), productId: lastSegment(line.product?.id), quantity: line.quantity })),
  };
}

function normalizeVariant(raw: RawShopifyVariant): ShopifyCatalogVariant {
  return {
    id: raw.id,
    title: raw.title,
    sku: raw.sku?.trim() || null,
    inventoryQuantity: raw.inventoryQuantity,
    imageUrl: raw.image?.url ?? null,
    imageAlt: raw.image?.altText ?? null,
    selectedOptions: raw.selectedOptions,
    product: raw.product,
  };
}

function resolveShopifyAdminCredentials(): ShopifyAdminCredentials {
  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN?.trim();
  const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();

  if (!shopifyDomain || !clientId || !clientSecret) {
    throw new ServiceUnavailableException('Integração Shopify Admin não configurada no servidor.');
  }

  return { shopifyDomain, clientId, clientSecret };
}
