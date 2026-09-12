import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Esquema de assinatura do Mercado Pago (header `x-signature: ts=...,v1=...`
 * + `x-request-id` + `data.id` da query string da URL de notificação),
 * documentado publicamente pelo Mercado Pago. NÃO foi confirmado contra
 * uma entrega real de sandbox nesta sessão (MERCADOPAGO_TEST_WEBHOOK_SECRET
 * não foi fornecido) — revalidar contra uma notificação real antes da
 * homologação (ver relatório final).
 *
 * Igual ao HMAC da Shopify (mesmo princípio, formato diferente): hash
 * em tempo constante, nunca compara string cru.
 */
export interface MercadoPagoSignatureInput {
  readonly signatureHeader: string | undefined; // x-signature
  readonly requestId: string | undefined; // x-request-id
  readonly dataId: string | undefined; // data.id da query string
  readonly secret: string;
}

function parseSignatureHeader(header: string): { ts: string; v1: string } | null {
  const parts = Object.fromEntries(
    header
      .split(',')
      .map((p) => p.trim().split('='))
      .filter((pair): pair is [string, string] => pair.length === 2),
  );
  if (!parts.ts || !parts.v1) return null;
  return { ts: parts.ts, v1: parts.v1 };
}

export function verifyMercadoPagoSignature(input: MercadoPagoSignatureInput): boolean {
  if (!input.signatureHeader || !input.requestId || !input.dataId) return false;

  const parsed = parseSignatureHeader(input.signatureHeader);
  if (!parsed) return false;

  const manifest = `id:${input.dataId.toLowerCase()};request-id:${input.requestId};ts:${parsed.ts};`;
  const expected = createHmac('sha256', input.secret).update(manifest, 'utf8').digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const presentedBuf = Buffer.from(parsed.v1, 'hex');
  if (expectedBuf.length !== presentedBuf.length) return false;
  return timingSafeEqual(expectedBuf, presentedBuf);
}
