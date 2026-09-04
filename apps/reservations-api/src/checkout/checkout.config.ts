import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Duração operacional do bloqueio durante pagamento — item 11 da Fase 6.
 * NÃO é uma regra comercial (não existe "multa" ou "cobrança" aqui, só
 * até quando a unidade física continua reservada esperando o pagamento
 * confirmar). Sem confirmação do Anderson sobre um valor definitivo,
 * 30 minutos é o padrão conservador escolhido — igual à duração do HOLD
 * em si, documentado explicitamente como PLACEHOLDER, nunca inventado
 * como se fosse definitivo. Configurável por variável de ambiente pra
 * não exigir deploy quando o valor real for confirmado.
 */
const DEFAULT_PAYMENT_WINDOW_MINUTES = 30;

export function paymentWindowMinutes(): number {
  const raw = process.env.PAYMENT_WINDOW_MINUTES;
  if (!raw) return DEFAULT_PAYMENT_WINDOW_MINUTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`PAYMENT_WINDOW_MINUTES inválido: "${raw}". Deve ser um número positivo.`);
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
