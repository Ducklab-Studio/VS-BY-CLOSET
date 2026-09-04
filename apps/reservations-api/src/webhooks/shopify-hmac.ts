import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verificação de assinatura de webhook Shopify — item 3 da Fase 7,
 * OBRIGATÓRIO. Confirmado contra a documentação oficial
 * (shopify.dev/docs/apps/build/webhooks/verify-deliveries):
 *
 *   - header `X-Shopify-Hmac-SHA256`, base64;
 *   - assina o CORPO CRU da requisição (nunca o body já parseado/
 *     reserializado — reserializar um JSON pode mudar espaçamento/ordem
 *     de chaves e quebrar a assinatura mesmo com o mesmo conteúdo
 *     lógico);
 *   - HMAC-SHA256 usando o Client Secret do app como chave;
 *   - comparação em tempo constante.
 *
 * `rawBody` precisa ser o Buffer exato que chegou na requisição — ver
 * main.ts (`rawBody: true`) e webhooks.controller.ts.
 */
export function verifyShopifyHmac(rawBody: Buffer, hmacHeader: string | undefined, secret: string): boolean {
  if (!hmacHeader) return false;

  const computed = createHmac('sha256', secret).update(rawBody).digest('base64');

  let computedBuf: Buffer;
  let headerBuf: Buffer;
  try {
    computedBuf = Buffer.from(computed, 'base64');
    headerBuf = Buffer.from(hmacHeader, 'base64');
  } catch {
    return false;
  }

  // timingSafeEqual exige buffers do mesmo tamanho — um header
  // malformado/truncado não pode nem chegar a essa comparação.
  if (computedBuf.length !== headerBuf.length) return false;
  return timingSafeEqual(computedBuf, headerBuf);
}
