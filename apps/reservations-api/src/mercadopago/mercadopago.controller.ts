import { Body, Controller, Headers, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { MercadoPagoService, type MercadoPagoPreferenceResponse } from './mercadopago.service';
import { CreateMercadoPagoPreferenceDto } from './dto/create-preference.dto';

interface MercadoPagoNotificationBody {
  readonly type?: string;
  readonly topic?: string;
  readonly data?: { readonly id?: string };
  readonly resource?: string;
}

@Controller()
export class MercadoPagoController {
  constructor(private readonly mercadoPago: MercadoPagoService) {}

  // 200, não 201 — mesma justificativa do checkout Shopify: a resposta
  // pode ser uma preferência recém-criada OU uma já existente (replay).
  @Post('checkout/mercadopago')
  @HttpCode(HttpStatus.OK)
  createPreference(@Body() dto: CreateMercadoPagoPreferenceDto): Promise<MercadoPagoPreferenceResponse> {
    return this.mercadoPago.createPreference(dto);
  }

  /**
   * O Mercado Pago manda `data.id`/`type` tanto na query string quanto
   * no corpo, dependendo do tipo de notificação (IPN legado vs
   * Webhooks v2) — aceita os dois, nunca assume um formato só.
   * `HttpStatus.OK` sempre que o processamento terminou (mesmo
   * ignorado/rejeitado) — só uma falha de INFRAESTRUTURA real (ver
   * MercadoPagoService.handleWebhook) deve virar 5xx, pra o Mercado
   * Pago reenviar depois.
   */
  @Post('webhooks/mercadopago')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Body() body: MercadoPagoNotificationBody | undefined,
    @Query('data.id') dataIdQuery: string | undefined,
    @Query('type') typeQuery: string | undefined,
    @Headers('x-signature') signature?: string,
    @Headers('x-request-id') requestId?: string,
  ): Promise<{ ok: true; outcome: string }> {
    const dataId = dataIdQuery ?? body?.data?.id;
    const topic = typeQuery ?? body?.type ?? body?.topic;

    const result = await this.mercadoPago.handleWebhook(dataId, topic, {
      signature,
      requestId,
      dataIdFromQuery: dataIdQuery,
    });
    return { ok: true, outcome: result.outcome };
  }
}
