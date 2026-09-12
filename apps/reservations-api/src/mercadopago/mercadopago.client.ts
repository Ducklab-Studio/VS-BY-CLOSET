import { Injectable } from '@nestjs/common';
import { resolveMercadoPagoCredentials, type MercadoPagoCredentials } from './mercadopago.config';

/**
 * Cliente mínimo da API REST do Mercado Pago (Checkout Pro) — só o que
 * o fluxo principal precisa: criar preferência e reconsultar um
 * pagamento direto na fonte (nunca confiar no corpo do webhook). Mesmo
 * padrão de shopify-storefront-cart.client.ts: fetch cru, sem SDK — o
 * SDK oficial (`mercadopago` npm) traria uma dependência pesada pra
 * cobrir só 2 chamadas REST simples e bem documentadas.
 */
const API_BASE = 'https://api.mercadopago.com';
const REQUEST_TIMEOUT_MS = 10_000;

export interface PreferenceItemInput {
  readonly title: string;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly currencyId: string;
}

export interface CreatePreferenceInput {
  readonly items: readonly PreferenceItemInput[];
  readonly externalReference: string;
  readonly notificationUrl?: string;
  readonly metadata?: Record<string, string>;
  readonly backUrls?: { success: string; pending: string; failure: string };
}

export interface CreatePreferenceResult {
  readonly preferenceId: string;
  /** Ambiente de teste: SEMPRE `sandbox_init_point`, nunca `init_point`
   *  (que seria o checkout de produção). */
  readonly checkoutUrl: string;
}

export interface MercadoPagoPayment {
  readonly id: string;
  readonly status: string;
  readonly statusDetail: string | null;
  readonly transactionAmount: number;
  readonly currencyId: string;
  readonly externalReference: string | null;
  readonly metadata: Record<string, unknown>;
  readonly dateApproved: string | null;
  readonly liveMode: boolean;
}

async function mpFetch(credentials: MercadoPagoCredentials, path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credentials.accessToken}`,
        ...init.headers,
      },
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`Falha de rede ao chamar a API do Mercado Pago: ${err instanceof Error ? err.name : 'unknown'}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Lança em qualquer falha de INFRAESTRUTURA (rede, timeout, HTTP 5xx) —
 * quem chama converte em 503. Um 4xx de VALIDAÇÃO do próprio Mercado
 * Pago (ex.: moeda não aceita pela conta de teste) também lança — ao
 * contrário do `cartCreate` da Shopify, criar preferência não tem um
 * conceito de "resposta de negócio válida com erro"; um 4xx aqui sempre
 * significa que o pedido está mal formado ou a conta não suporta a
 * moeda pedida.
 */
export async function mercadoPagoCreatePreference(
  credentials: MercadoPagoCredentials,
  input: CreatePreferenceInput,
): Promise<CreatePreferenceResult> {
  const body: Record<string, unknown> = {
    items: input.items.map((item) => ({
      title: item.title,
      quantity: item.quantity,
      unit_price: item.unitPrice,
      currency_id: item.currencyId,
    })),
    external_reference: input.externalReference,
    metadata: input.metadata,
  };
  if (input.notificationUrl) body.notification_url = input.notificationUrl;
  if (input.backUrls) {
    body.back_urls = { success: input.backUrls.success, pending: input.backUrls.pending, failure: input.backUrls.failure };
    body.auto_return = 'approved';
  }

  const res = await mpFetch(credentials, '/checkout/preferences', { method: 'POST', body: JSON.stringify(body) });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;

  if (!res.ok || !json) {
    const message = json && typeof json.message === 'string' ? json.message : `HTTP ${res.status}`;
    throw new Error(`Mercado Pago recusou a criação da preferência: ${message}`);
  }

  const preferenceId = json.id as string | undefined;
  const checkoutUrl = json.sandbox_init_point as string | undefined;
  if (!preferenceId || !checkoutUrl) {
    throw new Error('Mercado Pago não retornou id/sandbox_init_point da preferência.');
  }

  return { preferenceId, checkoutUrl };
}

/**
 * ÚNICA fonte de verdade sobre o estado real de um pagamento — o
 * servidor NUNCA confia no corpo de um webhook pra status/valor/moeda,
 * sempre reconsulta aqui (item explícito do pedido).
 */
export async function mercadoPagoGetPayment(credentials: MercadoPagoCredentials, paymentId: string): Promise<MercadoPagoPayment | null> {
  const res = await mpFetch(credentials, `/v1/payments/${encodeURIComponent(paymentId)}`, { method: 'GET' });
  if (res.status === 404) return null;

  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json) {
    throw new Error(`Falha ao consultar pagamento no Mercado Pago: HTTP ${res.status}`);
  }

  return {
    id: String(json.id),
    status: String(json.status),
    statusDetail: (json.status_detail as string | undefined) ?? null,
    transactionAmount: Number(json.transaction_amount),
    currencyId: String(json.currency_id),
    externalReference: (json.external_reference as string | undefined) ?? null,
    metadata: (json.metadata as Record<string, unknown> | undefined) ?? {},
    dateApproved: (json.date_approved as string | undefined) ?? null,
    liveMode: Boolean(json.live_mode),
  };
}

/**
 * Wrapper injetável — mesmo padrão de ShopifyCartClient: existe pra
 * MercadoPagoService poder ser testado com um cliente FAKE, sem mock de
 * módulo.
 */
@Injectable()
export class MercadoPagoClient {
  createPreference(input: CreatePreferenceInput): Promise<CreatePreferenceResult> {
    return mercadoPagoCreatePreference(resolveMercadoPagoCredentials(), input);
  }

  getPayment(paymentId: string): Promise<MercadoPagoPayment | null> {
    return mercadoPagoGetPayment(resolveMercadoPagoCredentials(), paymentId);
  }
}
