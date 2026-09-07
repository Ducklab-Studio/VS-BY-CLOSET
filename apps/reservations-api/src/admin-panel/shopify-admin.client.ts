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
