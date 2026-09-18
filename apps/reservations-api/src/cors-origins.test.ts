import { afterEach, describe, expect, test } from 'vitest';
import { allowedOrigins, isOriginAllowed, VERCEL_PREVIEW_ORIGIN } from './cors-origins';

/**
 * Bug real de produção: previews da Vercel (URL única por deploy) não
 * batiam com nenhuma entrada estática de CORS_ALLOWED_ORIGINS, e a API
 * respondia 200 sem o header Access-Control-Allow-Origin — o navegador
 * de quem testava bloqueava a leitura, aparecendo como "não foi
 * possível consultar a disponibilidade". Estes testes travam esse
 * comportamento sem abrir CORS pra qualquer site (`*.vercel.app`).
 */
describe('isOriginAllowed', () => {
  const staticOrigins = ['https://vsbycloset.vercel.app'];

  test('origem estática exata (produção) é permitida', () => {
    expect(isOriginAllowed('https://vsbycloset.vercel.app', staticOrigins)).toBe(true);
  });

  test('preview da Vercel por hash de deploy é permitido', () => {
    expect(isOriginAllowed('https://vsbycloset-pea6di32t-ducklab.vercel.app', staticOrigins)).toBe(true);
  });

  test('preview da Vercel por branch (git-<branch>) é permitido', () => {
    expect(isOriginAllowed('https://vsbycloset-git-feature-refinamento-visual-vitrine-ducklab.vercel.app', staticOrigins)).toBe(true);
  });

  test('domínio de terceiro na Vercel NUNCA é permitido, mesmo com "vsbycloset" no nome', () => {
    expect(isOriginAllowed('https://vsbycloset-evil.outro-time.vercel.app', staticOrigins)).toBe(false);
  });

  test('domínio que só termina em vercel.app, sem o prefixo do projeto, é rejeitado', () => {
    expect(isOriginAllowed('https://qualquer-outro-site.vercel.app', staticOrigins)).toBe(false);
  });

  test('domínio parecido mas fora do time ducklab é rejeitado', () => {
    expect(isOriginAllowed('https://vsbycloset-abc123-outrotime.vercel.app', staticOrigins)).toBe(false);
  });

  test('http (sem TLS) não é aceito mesmo com o resto igual', () => {
    expect(isOriginAllowed('http://vsbycloset-abc123-ducklab.vercel.app', staticOrigins)).toBe(false);
  });

  test('origem totalmente fora da lista e do padrão é rejeitada', () => {
    expect(isOriginAllowed('https://exemplo-malicioso.com', staticOrigins)).toBe(false);
  });
});

describe('VERCEL_PREVIEW_ORIGIN (regex isolado)', () => {
  test('não casa com string vazia nem com o próprio domínio base sem prefixo', () => {
    expect(VERCEL_PREVIEW_ORIGIN.test('')).toBe(false);
    expect(VERCEL_PREVIEW_ORIGIN.test('https://vercel.app')).toBe(false);
  });
});

describe('allowedOrigins — leitura de CORS_ALLOWED_ORIGINS', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('divide a variável por vírgula e remove espaços', () => {
    process.env.CORS_ALLOWED_ORIGINS = ' https://a.com , https://b.com ';
    expect(allowedOrigins()).toEqual(['https://a.com', 'https://b.com']);
  });

  test('sem a variável e fora de produção, cai pro localhost padrão do Next', () => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    process.env.NODE_ENV = 'test';
    expect(allowedOrigins()).toEqual(['http://localhost:3000']);
  });

  test('sem a variável em produção, falha alto em vez de subir sem CORS', () => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    process.env.NODE_ENV = 'production';
    expect(() => allowedOrigins()).toThrow(/CORS_ALLOWED_ORIGINS não configurada/);
  });
});
