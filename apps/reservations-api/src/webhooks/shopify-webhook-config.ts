import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Chave HMAC dos webhooks — auditoria pedida antes de encerrar a Fase 7:
 * a Shopify assina `X-Shopify-Hmac-SHA256` com o CLIENT SECRET do app
 * (shopify.dev/docs/apps/build/webhooks/subscribe/https#step-2-validate-the-webhook),
 * nunca com um segredo à parte inventado por nós. Por isso esta função lê
 * `SHOPIFY_CLIENT_SECRET` — o MESMO valor que `apps/shopify-app` (o app
 * "VS BY CLOSET Aluguel DEV", client_id em apps/shopify-app/shopify.app.toml)
 * usa como `SHOPIFY_API_SECRET`. É o Client Secret desse app, visível no
 * Partner Dashboard → esse app → Client credentials — uma única fonte de
 * verdade, só duplicada entre os dois `.env` porque reservations-api e
 * shopify-app são processos separados que não compartilham ambiente
 * (mesmo padrão já usado pra SHOPIFY_STORE_DOMAIN/SHOPIFY_STOREFRONT_TOKEN
 * entre reservations-api e marketing).
 *
 * Sem fallback de dev: ao contrário do domínio/token da Storefront (Fase
 * 5/6), aceitar um webhook sem conseguir verificar a assinatura de
 * verdade seria abrir mão do único ponto de autenticação desta rota
 * inteira — fail closed em qualquer ambiente.
 */
export function resolveShopifyClientSecret(): string {
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret) {
    throw new ServiceUnavailableException('Webhook não configurado.');
  }
  return secret;
}
