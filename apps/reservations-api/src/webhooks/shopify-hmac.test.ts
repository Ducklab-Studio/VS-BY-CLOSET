import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { verifyShopifyHmac } from './shopify-hmac';

const SECRET = 'test-webhook-secret';

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('base64');
}

describe('verifyShopifyHmac', () => {
  test('1) assinatura correta → true', () => {
    const body = '{"id":123,"note_attributes":[]}';
    expect(verifyShopifyHmac(Buffer.from(body, 'utf8'), sign(body), SECRET)).toBe(true);
  });

  test('2) assinatura incorreta (secret errado) → false', () => {
    const body = '{"id":123}';
    expect(verifyShopifyHmac(Buffer.from(body, 'utf8'), sign(body, 'wrong-secret'), SECRET)).toBe(false);
  });

  test('3) corpo alterado depois de assinado → false', () => {
    const original = '{"id":123,"financial_status":"pending"}';
    const tampered = '{"id":123,"financial_status":"paid"}';
    const signatureOfOriginal = sign(original);
    expect(verifyShopifyHmac(Buffer.from(tampered, 'utf8'), signatureOfOriginal, SECRET)).toBe(false);
  });

  test('4) header ausente → false, nunca lança', () => {
    const body = '{"id":123}';
    expect(verifyShopifyHmac(Buffer.from(body, 'utf8'), undefined, SECRET)).toBe(false);
  });

  test('header vazio → false', () => {
    expect(verifyShopifyHmac(Buffer.from('{}', 'utf8'), '', SECRET)).toBe(false);
  });

  test('header com base64 inválido → false, nunca lança', () => {
    expect(() => verifyShopifyHmac(Buffer.from('{}', 'utf8'), '!!!not-base64!!!', SECRET)).not.toThrow();
    expect(verifyShopifyHmac(Buffer.from('{}', 'utf8'), '!!!not-base64!!!', SECRET)).toBe(false);
  });

  test('assinatura de tamanho inválido (base64 válido, mas mais curto que um SHA-256) → false, nunca lança', () => {
    // Um HMAC-SHA256 real sempre decodifica pra 32 bytes — um header
    // menor (aqui, "AAAA" → 3 bytes) nunca pode ser igual, e o guard de
    // comprimento em verifyShopifyHmac tem que rejeitar ANTES de chegar
    // em timingSafeEqual (que lançaria com buffers de tamanhos diferentes).
    const shortSignature = Buffer.from('AAAA', 'base64').toString('base64'); // 3 bytes reais
    expect(() => verifyShopifyHmac(Buffer.from('{}', 'utf8'), shortSignature, SECRET)).not.toThrow();
    expect(verifyShopifyHmac(Buffer.from('{}', 'utf8'), shortSignature, SECRET)).toBe(false);
  });

  test('corpo vazio ainda é verificável (não lança)', () => {
    const body = '';
    expect(verifyShopifyHmac(Buffer.from(body, 'utf8'), sign(body), SECRET)).toBe(true);
  });

  test('reordenar as mesmas chaves no JSON muda a assinatura esperada (prova que é o BYTE cru que importa, não o valor lógico)', () => {
    const a = '{"a":1,"b":2}';
    const b = '{"b":2,"a":1}';
    // Mesmo "significado" JSON, bytes diferentes — assinatura de "a" não
    // deve validar contra o corpo "b".
    expect(verifyShopifyHmac(Buffer.from(b, 'utf8'), sign(a), SECRET)).toBe(false);
  });
});
