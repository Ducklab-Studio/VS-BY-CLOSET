import { describe, expect, test } from 'vitest';
import { generateHoldToken, hashHoldToken, verifyHoldToken } from './hold-token';

describe('hold-token', () => {
  test('gera tokens diferentes a cada chamada', () => {
    const a = generateHoldToken();
    const b = generateHoldToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40); // 32 bytes em base64url
  });

  test('hash é determinístico para o mesmo token', () => {
    const token = generateHoldToken();
    expect(hashHoldToken(token)).toBe(hashHoldToken(token));
  });

  test('hashes de tokens diferentes são diferentes', () => {
    expect(hashHoldToken(generateHoldToken())).not.toBe(hashHoldToken(generateHoldToken()));
  });

  test('verifyHoldToken: token correto → true', () => {
    const token = generateHoldToken();
    const hash = hashHoldToken(token);
    expect(verifyHoldToken(token, hash)).toBe(true);
  });

  test('verifyHoldToken: token incorreto → false', () => {
    const token = generateHoldToken();
    const hash = hashHoldToken(token);
    expect(verifyHoldToken(generateHoldToken(), hash)).toBe(false);
  });

  test('verifyHoldToken: hash ausente (null) → false, nunca lança', () => {
    expect(verifyHoldToken(generateHoldToken(), null)).toBe(false);
  });

  test('verifyHoldToken: hash malformado (tamanho diferente) → false, nunca lança', () => {
    expect(verifyHoldToken(generateHoldToken(), 'abcd')).toBe(false);
  });
});
