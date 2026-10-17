import { Controller, Headers, HttpCode, HttpStatus, Inject, Logger, Post, Req, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { EMAIL_CONFIG_TOKEN } from './email-tokens';
import type { EmailConfig } from './email-config';
import { ValePassEmailOutboxService } from './email-outbox.service';
import { parseResendEvent, verifySvixSignature } from './resend-webhook';

interface RawBodyCapableRequest {
  readonly rawBody?: Buffer;
}

/**
 * Eventos de entrega da Resend (entregue / devolvido). NÃO é o webhook financeiro da Shopify: rota própria, assinatura Svix própria
 * (RESEND_WEBHOOK_SECRET). Sem o segredo configurado a rota responde 503 e nada é processado (fail closed).
 */
@Controller('webhooks/resend')
export class ResendWebhookController {
  private readonly logger = new Logger(ResendWebhookController.name);

  constructor(
    private readonly outbox: ValePassEmailOutboxService,
    @Inject(EMAIL_CONFIG_TOKEN) private readonly config: EmailConfig,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() req: RawBodyCapableRequest,
    @Headers('svix-id') id?: string,
    @Headers('svix-timestamp') timestamp?: string,
    @Headers('svix-signature') signature?: string,
  ): Promise<{ ok: true }> {
    if (!this.config.webhookSecret) throw new ServiceUnavailableException('Webhook da Resend não configurado.');
    const rawBody = req.rawBody;
    if (!rawBody || !verifySvixSignature({ secret: this.config.webhookSecret, id, timestamp, signature, rawBody })) {
      this.logger.warn('Webhook da Resend recusado: assinatura inválida.');
      throw new UnauthorizedException('Assinatura inválida.');
    }
    const event = parseResendEvent(rawBody);
    if (event) await this.outbox.applyProviderEvent(event.type, event.emailId);
    return { ok: true };
  }
}
