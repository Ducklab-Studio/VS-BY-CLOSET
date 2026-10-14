import { ServiceUnavailableException } from '@nestjs/common';

/**
 * PRAZOS DA RESERVA ONLINE — duas fases, dois relógios, cada um gravado UMA vez:
 *
 *  1. HOLD (`HOLD_WINDOW_MINUTES`, 30 min): começa quando o HOLD é criado
 *     (`reservations.expires_at`). É o intervalo entre "Finalizar reserva" e a criação
 *     do checkout — na prática, segundos. Só vale enquanto o status é `hold`.
 *  2. Janela de pagamento (`PAYMENT_WINDOW_MINUTES`, padrão 60 min): começa quando o
 *     checkout Shopify é criado, na transição `hold → pending_payment`
 *     (`reservations.payment_expires_at = now() + janela`, ver CheckoutService). Vale só
 *     enquanto o status é `pending_payment`.
 *
 * O prazo NUNCA é renovado: webhooks repetidos, `orders/updated` e novo POST /checkout
 * (que devolve o checkout existente) não mexem em `payment_expires_at`. Cada reserva
 * guarda o prazo com que nasceu; mudar a variável só vale para checkouts novos.
 * Vencido o prazo, `expireDueReservations` (também rodada por agendador) expira a reserva e
 * libera a peça; pagamento aprovado depois disso segue a recuperação de pagamento tardio.
 *
 * A janela NÃO é regra comercial de multa/cobrança: só até quando a unidade física
 * continua reservada esperando o pagamento. 60 min foi decidido pelo proprietário; o prazo
 * do Pix é configurado do lado da Shopify e do meio de pagamento da loja, e NÃO é lido nem
 * garantido por este código. Configurável por `PAYMENT_WINDOW_MINUTES` (máx. 24 h).
 */
export const HOLD_WINDOW_MINUTES = 30;
const DEFAULT_PAYMENT_WINDOW_MINUTES = 60;
const MAX_PAYMENT_WINDOW_MINUTES = 24 * 60;

export function paymentWindowMinutes(): number {
  const raw = process.env.PAYMENT_WINDOW_MINUTES?.trim();
  if (!raw) return DEFAULT_PAYMENT_WINDOW_MINUTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_PAYMENT_WINDOW_MINUTES) {
    throw new Error(`PAYMENT_WINDOW_MINUTES inválido: "${raw}". Deve ser um número entre 1 e ${MAX_PAYMENT_WINDOW_MINUTES}.`);
  }
  return parsed;
}

export interface ShopifyStorefrontCredentials {
  readonly shopifyDomain: string;
  readonly storefrontToken: string;
}

/**
 * Credenciais da Storefront API — só leitura de catálogo + criação de
 * cart (unauthenticated_write_checkouts), NUNCA Admin API. O domínio é o
 * MESMO que HoldsService usa pra criar a linha em `stores`
 * (SHOPIFY_STORE_DOMAIN) — não duplicado aqui, uma fonte só. O token é
 * novo (SHOPIFY_STOREFRONT_TOKEN): este servidor é um processo separado
 * do apps/marketing, então não compartilha `.env` — mesmo valor que
 * NEXT_PUBLIC_SHOPIFY_STOREFRONT_TOKEN de lá, configurado aqui de novo.
 */
export function resolveShopifyStorefrontCredentials(): ShopifyStorefrontCredentials {
  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const storefrontToken = process.env.SHOPIFY_STOREFRONT_TOKEN;

  // Sem fallback de dev aqui — diferente de resolveStoreConfig() (Fase
  // 5), não existe um "dev-store" seguro pra Shopify: sem credenciais
  // reais não há chamada nenhuma pra fazer, fail closed sempre, em
  // qualquer ambiente. Quem testa sem Shopify configurado usa mock do
  // cliente (ver checkout.service.test.ts), não um domínio inventado.
  if (!shopifyDomain || !storefrontToken) {
    throw new ServiceUnavailableException('Checkout não configurado — não é possível criar o carrinho no momento.');
  }

  return { shopifyDomain, storefrontToken };
}

/**
 * Segredo do binding assinado Order↔Reservation (ver
 * src/reservation-binding.ts) — pedido antes de continuar a Fase 7,
 * porque `reservation_id` sozinho como atributo de cart é alterável via
 * Storefront API enquanto o cart existe. NUNCA chega ao navegador (só a
 * ASSINATURA, que é o resultado do HMAC, viaja como atributo — o
 * segredo em si nunca sai deste processo). Fail closed sempre, sem
 * fallback de dev: um binding sem segredo real não protege nada.
 */
export function resolveReservationBindingSecret(): string {
  const secret = process.env.RESERVATION_BINDING_SECRET;
  if (!secret) {
    throw new ServiceUnavailableException('Checkout não configurado — não é possível criar o carrinho no momento.');
  }
  return secret;
}
