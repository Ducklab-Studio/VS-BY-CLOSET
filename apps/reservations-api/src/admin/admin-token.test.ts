import { describe, expect, test } from 'vitest';
import { extractBearerToken, verifyAdminToken } from './admin-token';

const CONFIGURED = 'admin-secret-token-de-teste';

describe('extractBearerToken', () => {
  test('extrai o token de um header Authorization: Bearer bem formado', () => {
    expect(extractBearerToken(`Bearer ${CONFIGURED}`)).toBe(CONFIGURED);
  });

  test('header ausente → undefined, nunca lança', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
  });

  test('sem o prefixo "Bearer " → undefined (ex.: só o token cru, ou "Basic ...")', () => {
    expect(extractBearerToken(CONFIGURED)).toBeUndefined();
    expect(extractBearerToken(`Basic ${CONFIGURED}`)).toBeUndefined();
  });
});

describe('verifyAdminToken', () => {
  test('token correto → true', () => {
    expect(verifyAdminToken(CONFIGURED, CONFIGURED)).toBe(true);
  });

  test('token incorreto → false', () => {
    expect(verifyAdminToken('valor-errado', CONFIGURED)).toBe(false);
  });

  test('token ausente (undefined) → false, nunca lança', () => {
    expect(() => verifyAdminToken(undefined, CONFIGURED)).not.toThrow();
    expect(verifyAdminToken(undefined, CONFIGURED)).toBe(false);
  });

  test('token de tamanho diferente do configurado → false, nunca lança (timingSafeEqual exigiria buffers do mesmo tamanho)', () => {
    expect(() => verifyAdminToken('curto', CONFIGURED)).not.toThrow();
    expect(verifyAdminToken('curto', CONFIGURED)).toBe(false);
  });

  test('string vazia apresentada → false', () => {
    expect(verifyAdminToken('', CONFIGURED)).toBe(false);
  });
});
