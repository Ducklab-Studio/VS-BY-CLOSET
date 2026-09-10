import { BadRequestException, Controller, Headers, HttpCode, HttpStatus, Post, Req, UnauthorizedException } from '@nestjs/common';
import { verifyShopifyHmac } from './shopify-hmac';
import { resolveShopifyClientSecret } from './shopify-webhook-config';
import { WebhooksService } from './webhooks.service';
import { resolveStoreConfig } from '../holds/store-config';

/** Só o que este controller precisa do Request — evita depender dos
 *  tipos do pacote `express` diretamente (não é uma dependência própria
 *  deste projeto, só transitiva via @nestjs/platform-express). */
interface RawBodyCapableRequest {
  readonly rawBody?: Buffer;
}

/**
 * Uma rota só pra todos os tópicos (`X-Shopify-Topic` decide o
 * dispatch dentro de WebhooksService) — mais simples de configurar na
 * Shopify (uma URL, várias inscrições de tópico apontando pra ela) e
 * casa com o desenho já existente de WebhookEvent (`topic` genérico).
 *
 * Tópicos usados nesta fase, confirmados contra shopify.dev antes de
 * implementar (não assumidos): `orders/create`, `orders/paid`,
 * `orders/cancelled`, `refunds/create`.
 */
@Controller('webhooks/shopify')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() req: RawBodyCapableRequest,
    @Headers('x-shopify-hmac-sha256') hmacHeader?: string,
    @Headers('x-shopify-topic') topic?: string,
    @Headers('x-shopify-webhook-id') webhookId?: string,
    @Headers('x-shopify-shop-domain') shopDomain?: string,
  ): Promise<{ ok: true }> {
    // Item 3, OBRIGATÓRIO: sem corpo cru, sem verificação possível —
    // fail closed, nunca cai pro body já parseado como substituto.
    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new UnauthorizedException('Requisição sem corpo verificável.');
    }

    const secret = resolveShopifyClientSecret();
    if (!verifyShopifyHmac(rawBody, hmacHeader, secret)) {
      // Nunca loga o secret, nunca loga o corpo, nunca devolve stack
      // trace — só o suficiente pra saber que algo tentou e falhou.
      throw new UnauthorizedException('Assinatura inválida.');
    }

    // A partir daqui a origem já está autenticada — ausência de
    // tópico/id ou corpo malformado são erros de FORMATO, não de
    // autenticação (400, não 401).
    if (!topic || !webhookId || !shopDomain) {
      throw new BadRequestException('Cabeçalhos obrigatórios ausentes (X-Shopify-Topic / X-Shopify-Webhook-Id / X-Shopify-Shop-Domain).');
    }

    // O client secret autentica o app, mas pode ser compartilhado por todas
    // as lojas onde ele estiver instalado. Nunca aceite um evento de outra
    // loja como se pertencesse ao estoque configurado neste ambiente.
    if (normalizeShopDomain(shopDomain) !== normalizeShopDomain(resolveStoreConfig().shopifyDomain)) {
      throw new UnauthorizedException('Loja de origem inválida.');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Corpo malformado.');
    }

    await this.webhooks.handleIncoming({ topic, shopifyWebhookId: webhookId, payload });
    return { ok: true };
  }
}

function normalizeShopDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
}
