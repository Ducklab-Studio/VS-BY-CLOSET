import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { verifyMercadoPagoSignature } from './mercadopago-webhook-signature';

const SECRET = 'test-secret-webhook-mp';

function sign(dataId: string, requestId: string, ts: string, secret = SECRET): string {
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  return createHmac('sha256', secret).update(manifest, 'utf8').digest('hex');
}

describe('verifyMercadoPagoSignature — unit puro', () => {
  test('assinatura correta → válida', () => {
    const v1 = sign('123456', 'req-1', '1700000000');
    expect(verifyMercadoPagoSignature({ signatureHeader: `ts=1700000000,v1=${v1}`, requestId: 'req-1', dataId: '123456', secret: SECRET })).toBe(true);
  });

  test('secret errado → inválida', () => {
    const v1 = sign('123456', 'req-1', '1700000000', 'outro-secret');
    expect(verifyMercadoPagoSignature({ signatureHeader: `ts=1700000000,v1=${v1}`, requestId: 'req-1', dataId: '123456', secret: SECRET })).toBe(false);
  });

  test('dataId diferente do assinado → inválida', () => {
    const v1 = sign('123456', 'req-1', '1700000000');
    expect(verifyMercadoPagoSignature({ signatureHeader: `ts=1700000000,v1=${v1}`, requestId: 'req-1', dataId: '999999', secret: SECRET })).toBe(false);
  });

  test('requestId diferente do assinado → inválida', () => {
    const v1 = sign('123456', 'req-1', '1700000000');
    expect(verifyMercadoPagoSignature({ signatureHeader: `ts=1700000000,v1=${v1}`, requestId: 'req-2', dataId: '123456', secret: SECRET })).toBe(false);
  });

  test('header ausente → inválida (nunca lança)', () => {
    expect(verifyMercadoPagoSignature({ signatureHeader: undefined, requestId: 'req-1', dataId: '123456', secret: SECRET })).toBe(false);
  });

  test('header malformado (sem v1) → inválida', () => {
    expect(verifyMercadoPagoSignature({ signatureHeader: 'ts=1700000000', requestId: 'req-1', dataId: '123456', secret: SECRET })).toBe(false);
  });

  test('v1 com tamanho diferente do hash esperado → inválida, nunca lança', () => {
    expect(verifyMercadoPagoSignature({ signatureHeader: 'ts=1700000000,v1=abc', requestId: 'req-1', dataId: '123456', secret: SECRET })).toBe(false);
  });
});
