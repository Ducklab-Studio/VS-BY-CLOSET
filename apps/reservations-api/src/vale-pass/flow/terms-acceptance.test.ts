import 'reflect-metadata';
import { describe, expect, test, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException, ValidationPipe } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerGuard, ThrottlerStorageService } from '@nestjs/throttler';
import { REQUIRE_ROLE_KEY } from '../../admin/require-role.decorator';
import type { PrismaService } from '../../prisma/prisma.service';
import { approvedTerms, loadTermsAcceptanceConfig, type TermsAcceptanceConfig } from './terms-acceptance-config';
import { CreateTermsAcceptanceDto, ValePassTermsAcceptancePublicController, ValePassTermsEvidenceAdminController } from './terms-acceptance.controller';
import { ValePassTermsAcceptanceService } from './terms-acceptance.service';
import { evaluateTermsEvidence, termsEvidenceKey } from './terms-evidence';
import { issueTermsToken, verifyTermsToken } from './terms-token';

const SECRET = 'segredo-de-teste-0123456789-abcdefghij-xyz';
const SHA = 'ab'.repeat(32);
const VARIANT = '4455667788';
const ENV_OK = { VALE_PASS_TERMS_ACCEPTANCE: 'on', VALE_PASS_TERMS_VERSION: '2027-1', VALE_PASS_TERMS_SHA256: SHA, VALE_PASS_TERMS_TOKEN_SECRET: SECRET };
const cfg = (extra: Record<string, string | undefined> = {}) => loadTermsAcceptanceConfig({ ...ENV_OK, ...extra });
const NOW = new Date('2026-12-01T12:00:00.000Z');
const HOUR = 3_600_000;

function token(over: Partial<{ secret: string; version: string; sha256: string; variant: string; now: Date; ttlMs: number; nonce: string }> = {}) {
  return issueTermsToken({ secret: SECRET, version: '2027-1', sha256: SHA, variant: VARIANT, now: NOW, ttlMs: 6 * HOUR, ...over }).token;
}
const expectation = (over: Partial<{ at: Date; variantIds: string[]; version: string; sha256: string }> = {}) => ({ secret: SECRET, version: '2027-1', sha256: SHA, variantIds: [VARIANT], at: new Date(NOW.getTime() + 60_000), ...over });

describe('configuração: tudo desligado por padrão e só "aprovada" quando completa', () => {
  test('sem variáveis: desligada, nada aprovado, nada exigido', () => {
    const c = loadTermsAcceptanceConfig({});
    expect(c).toMatchObject({ enabled: false, required: false, version: null, sha256: null, secret: null });
    expect(approvedTerms(c)).toBeNull();
  });
  test.each([
    ['chave desligada', { VALE_PASS_TERMS_ACCEPTANCE: 'off' }],
    ['sem versão', { VALE_PASS_TERMS_VERSION: '' }],
    ['versão com caracteres inválidos', { VALE_PASS_TERMS_VERSION: '2027 1;' }],
    ['hash curto', { VALE_PASS_TERMS_SHA256: 'abc' }],
    ['hash não hexadecimal', { VALE_PASS_TERMS_SHA256: 'z'.repeat(64) }],
    ['segredo curto', { VALE_PASS_TERMS_TOKEN_SECRET: 'curto' }],
    ['sem segredo', { VALE_PASS_TERMS_TOKEN_SECRET: undefined }],
  ])('%s → não aprovada', (_label, extra) => {
    expect(approvedTerms(cfg(extra))).toBeNull();
  });
  test('completa e ligada → aprovada; hash em maiúsculas é normalizado; TTL fora da faixa volta ao padrão', () => {
    expect(approvedTerms(cfg({ VALE_PASS_TERMS_SHA256: SHA.toUpperCase() }))).toMatchObject({ version: '2027-1', sha256: SHA });
    expect(cfg({ VALE_PASS_TERMS_TOKEN_TTL_MIN: '1' }).ttlMs).toBe(360 * 60_000);
    expect(cfg({ VALE_PASS_TERMS_TOKEN_TTL_MIN: '99999' }).ttlMs).toBe(360 * 60_000);
    expect(cfg({ VALE_PASS_TERMS_TOKEN_TTL_MIN: '30' }).ttlMs).toBe(30 * 60_000);
  });
});

describe('token assinado', () => {
  test('válido: devolve as alegações; dois tokens têm nonces diferentes; nada de dado pessoal no conteúdo', () => {
    const a = token();
    const check = verifyTermsToken(a, expectation());
    expect(check).toMatchObject({ ok: true, claims: { ver: '2027-1', sha: SHA, variant: VARIANT } });
    expect(token()).not.toBe(a);
    const payload = Buffer.from(a.split('.')[1], 'base64url').toString('utf8');
    expect(Object.keys(JSON.parse(payload)).sort()).toEqual(['exp', 'iat', 'n', 'sha', 'var', 'ver', 'v'].sort());
  });
  test('adulterado: qualquer byte do conteúdo ou da assinatura muda → bad_signature', () => {
    const [p, body, sig] = token().split('.');
    const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), exp: NOW.getTime() + 999 * HOUR })).toString('base64url');
    expect(verifyTermsToken(`${p}.${forgedBody}.${sig}`, expectation())).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyTermsToken(`${p}.${body}.${sig.slice(0, -2)}AA`, expectation())).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyTermsToken(token({ secret: 'outro-segredo-0123456789-abcdefghij-xyz' }), expectation())).toEqual({ ok: false, reason: 'bad_signature' });
  });
  test.each([['vazio', ''], ['sem partes', 'abc'], ['prefixo errado', 'xx1.a.b'], ['partes vazias', 'vp1..'], ['gigante', `vp1.${'a'.repeat(900)}.b`]])('malformado (%s)', (_l, value) => {
    expect(verifyTermsToken(value, expectation())).toEqual({ ok: false, reason: 'malformed' });
  });
  test('assinatura correta mas conteúdo inválido (campo faltando) → malformed', async () => {
    const { createHmac } = await import('node:crypto');
    const body = Buffer.from(JSON.stringify({ v: 1, ver: '2027-1' })).toString('base64url');
    const sig = createHmac('sha256', SECRET).update(`vp1.${body}`).digest().toString('base64url');
    expect(verifyTermsToken(`vp1.${body}.${sig}`, expectation())).toEqual({ ok: false, reason: 'malformed' });
  });
  test('expirado, ainda não válido, versão, hash e variante divergentes', () => {
    expect(verifyTermsToken(token(), expectation({ at: new Date(NOW.getTime() + 7 * HOUR) }))).toEqual({ ok: false, reason: 'expired' });
    expect(verifyTermsToken(token(), expectation({ at: new Date(NOW.getTime() - 10 * 60_000) }))).toEqual({ ok: false, reason: 'not_yet_valid' });
    expect(verifyTermsToken(token(), expectation({ version: '2027-2' }))).toEqual({ ok: false, reason: 'version_mismatch' });
    expect(verifyTermsToken(token(), expectation({ sha256: 'cd'.repeat(32) }))).toEqual({ ok: false, reason: 'hash_mismatch' });
    expect(verifyTermsToken(token(), expectation({ variantIds: ['999'] }))).toEqual({ ok: false, reason: 'variant_mismatch' });
  });
  test('tolerância de relógio: 4 min antes do emissor ainda vale', () => {
    expect(verifyTermsToken(token(), expectation({ at: new Date(NOW.getTime() - 4 * 60_000) })).ok).toBe(true);
  });
});

describe('avaliação da evidência do pedido (webhook)', () => {
  const order = (attrs: { name: string; value: string }[], over: Record<string, unknown> = {}) => ({
    note_attributes: attrs, created_at: new Date(NOW.getTime() + 60_000).toISOString(), line_items: [{ variant_id: Number(VARIANT), quantity: 1 }], ...over,
  });
  const withToken = (value: string, over: Record<string, unknown> = {}) => order([{ name: 'valle_pass_terms_token', value }], over);

  test('token válido → VERIFIED (com versão, hash, instante de emissão e nonce)', () => {
    const e = evaluateTermsEvidence(withToken(token()), cfg(), NOW);
    expect(e).toMatchObject({ status: 'VERIFIED', version: '2027-1', sha256: SHA, issuedAt: NOW.toISOString() });
  });
  test('sem atributos → ABSENT; só atributos declarados → DECLARED (nunca VERIFIED)', () => {
    expect(evaluateTermsEvidence(order([]), cfg(), NOW)).toEqual({ status: 'ABSENT' });
    const declared = evaluateTermsEvidence(order([{ name: 'valle_pass_terms_version', value: '2027-1' }, { name: 'valle_pass_terms_accepted_at', value: NOW.toISOString() }]), cfg(), new Date(NOW.getTime() + 1000));
    expect(declared.status).toBe('DECLARED');
  });
  test('atributos declarados forjados ao lado de um token inválido não viram aceite', () => {
    const e = evaluateTermsEvidence(order([{ name: 'valle_pass_terms_token', value: 'vp1.x.y' }, { name: 'valle_pass_terms_version', value: '2027-1' }, { name: 'valle_pass_terms_accepted_at', value: NOW.toISOString() }]), cfg(), NOW);
    expect(e.status).toBe('REJECTED');
  });
  test('token sem configuração aprovada → REJECTED not_configured (falha segura, sem exceção)', () => {
    expect(evaluateTermsEvidence(withToken(token()), loadTermsAcceptanceConfig({}), NOW)).toEqual({ status: 'REJECTED', reason: 'not_configured' });
    expect(evaluateTermsEvidence(withToken(token()), cfg({ VALE_PASS_TERMS_TOKEN_SECRET: undefined }), NOW)).toEqual({ status: 'REJECTED', reason: 'not_configured' });
  });
  test('pedido sem horário de criação ou com variante diferente da do token', () => {
    expect(evaluateTermsEvidence(withToken(token(), { created_at: null }), cfg(), NOW)).toEqual({ status: 'REJECTED', reason: 'order_time_unknown' });
    expect(evaluateTermsEvidence(withToken(token(), { line_items: [{ variant_id: 1, quantity: 1 }] }), cfg(), NOW)).toEqual({ status: 'REJECTED', reason: 'variant_mismatch' });
  });
  test('a chave de comparação distingue estado, motivo e nonce', () => {
    expect(termsEvidenceKey({ status: 'ABSENT' })).not.toBe(termsEvidenceKey({ status: 'REJECTED', reason: 'expired' }));
    expect(termsEvidenceKey({ status: 'REJECTED', reason: 'reused', nonce: 'a' })).not.toBe(termsEvidenceKey({ status: 'REJECTED', reason: 'reused', nonce: 'b' }));
  });
});

function fakePrisma(variantIds: string[] = [VARIANT]) {
  return {
    valePassCampaign: { findMany: vi.fn(async () => variantIds.map((id) => ({ shopifyVariantId: `gid://shopify/ProductVariant/${id}` }))) },
    valePassOrder: { findUnique: vi.fn(async ({ where }: { where: { shopifyOrderId: string } }) => (where.shopifyOrderId === '1001' ? { id: 'order-uuid' } : null)) },
    valePassOrderEvent: {
      findMany: vi.fn(async () => [
        { createdAt: new Date('2026-12-01T12:05:00Z'), detail: { status: 'VERIFIED', version: '2027-1', sha256: SHA, issuedAt: NOW.toISOString(), verifiedAt: '2026-12-01T12:05:00Z', nonce: 'NONCE-NAO-DEVE-SAIR', source: 'signed_token' } },
        { createdAt: new Date('2026-12-01T12:01:00Z'), detail: { status: 'ABSENT' } },
      ]),
    },
  } as unknown as PrismaService & { valePassCampaign: { findMany: ReturnType<typeof vi.fn> } };
}
const serviceWith = (config: TermsAcceptanceConfig, prisma = fakePrisma()) => new ValePassTermsAcceptanceService(prisma, () => config, () => NOW);
const body = (over: Partial<{ termsVersion: string; termsSha256: string; accepted: boolean; variantId: string }> = {}) => ({ termsVersion: '2027-1', termsSha256: SHA, accepted: true, variantId: VARIANT, ...over });

describe('rotas públicas: consulta e emissão do token', () => {
  test('GET terms: 404 TERMS_NOT_APPROVED enquanto não aprovado; aprovado devolve só versão, hash e política (nunca o segredo)', () => {
    expect(() => serviceWith(loadTermsAcceptanceConfig({})).publicTerms()).toThrow(NotFoundException);
    const view = serviceWith(cfg({ VALE_PASS_TERMS_REQUIRED: 'on' })).publicTerms();
    expect(view).toEqual({ version: '2027-1', sha256: SHA, acceptanceRequired: true, tokenTtlMinutes: 360 });
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });
  test('POST: não aprovado → 404 e NADA é consultado nem emitido', async () => {
    const prisma = fakePrisma();
    await expect(serviceWith(loadTermsAcceptanceConfig({}), prisma).issue(body())).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.valePassCampaign.findMany).not.toHaveBeenCalled();
  });
  test('POST: aceite não afirmativo → 400 ACCEPTANCE_NOT_AFFIRMATIVE', async () => {
    await expect(serviceWith(cfg()).issue(body({ accepted: false }))).rejects.toMatchObject({ response: { code: 'ACCEPTANCE_NOT_AFFIRMATIVE' } });
    await expect(serviceWith(cfg()).issue(body({ accepted: undefined as unknown as boolean }))).rejects.toBeInstanceOf(BadRequestException);
  });
  test('POST: versão ou hash desconhecidos/não vigentes → 409 TERMS_VERSION_MISMATCH', async () => {
    await expect(serviceWith(cfg()).issue(body({ termsVersion: '2027-9' }))).rejects.toBeInstanceOf(ConflictException);
    await expect(serviceWith(cfg()).issue(body({ termsSha256: 'cd'.repeat(32) }))).rejects.toMatchObject({ response: { code: 'TERMS_VERSION_MISMATCH' } });
  });
  test('POST: variante que não é de nenhuma campanha → 400 UNKNOWN_VARIANT', async () => {
    await expect(serviceWith(cfg()).issue(body({ variantId: '123' }))).rejects.toMatchObject({ response: { code: 'UNKNOWN_VARIANT' } });
  });
  test('POST: aceite válido → token que o webhook consegue verificar, com validade igual à configurada e sem dado pessoal', async () => {
    const grant = await serviceWith(cfg({ VALE_PASS_TERMS_TOKEN_TTL_MIN: '60' })).issue(body());
    expect(grant).toMatchObject({ termsVersion: '2027-1', termsSha256: SHA, issuedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + HOUR).toISOString() });
    expect(verifyTermsToken(grant.token, expectation({ at: new Date(NOW.getTime() + 60_000) })).ok).toBe(true);
    expect(JSON.stringify(grant)).not.toContain(SECRET);
  });
  test('DTO: aceita o contrato e recusa tipos errados, campos extras e formatos inválidos', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const meta = { type: 'body' as const, metatype: CreateTermsAcceptanceDto };
    await expect(pipe.transform(body(), meta)).resolves.toMatchObject({ accepted: true });
    await expect(pipe.transform({ ...body(), accepted: 'true' }, meta)).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ ...body(), variantId: '12; DROP' }, meta)).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ ...body(), termsSha256: 'xyz' }, meta)).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ ...body(), email: 'a@b.c' }, meta)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('limite de requisições (HTTP 429) na emissão do token', () => {
  function ctx(handler: (...a: never[]) => unknown, ip: string): ExecutionContext {
    const req = { headers: { 'x-real-ip': ip }, socket: { remoteAddress: ip } };
    const res = { header: vi.fn(), setHeader: vi.fn() };
    return { getHandler: () => handler, getClass: () => ValePassTermsAcceptancePublicController, getType: () => 'http', switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ExecutionContext;
  }
  test('10 por minuto passam e a 11ª é 429; outro IP não é afetado', async () => {
    const guard = new ThrottlerGuard({ throttlers: [{ ttl: 60_000, limit: 100 }], getTracker: (req) => Promise.resolve(String((req as { headers: Record<string, string> }).headers['x-real-ip'])) }, new ThrottlerStorageService(), new Reflector());
    await guard.onModuleInit();
    const handler = ValePassTermsAcceptancePublicController.prototype.accept as (...a: never[]) => unknown;
    let denied = 0;
    for (let i = 0; i < 11; i++) {
      try { await guard.canActivate(ctx(handler, '203.0.113.7')); } catch (err) { if (err instanceof ThrottlerException) denied++; else throw err; }
    }
    expect(denied).toBe(1);
    await expect(guard.canActivate(ctx(handler, '203.0.113.8'))).resolves.toBe(true);
  });
});

describe('consulta administrativa da evidência', () => {
  test('exige módulo do Valle Pass e ADMIN; rota pública não tem guarda de admin', () => {
    expect(Reflect.getMetadata('__guards__', ValePassTermsEvidenceAdminController)?.length).toBeGreaterThanOrEqual(2);
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, ValePassTermsEvidenceAdminController.prototype.evidence)).toBe('ADMIN');
    expect(Reflect.getMetadata('__guards__', ValePassTermsAcceptancePublicController)).toBeUndefined();
  });
  test('devolve o estado sem dado pessoal e sem o nonce; pedido inexistente → 404; id inválido → 400', async () => {
    const view = await serviceWith(cfg({ VALE_PASS_TERMS_REQUIRED: 'on' })).evidenceFor('1001');
    expect(view).toMatchObject({ shopifyOrderId: '1001', proven: true, status: 'VERIFIED', version: '2027-1', policy: { acceptanceRequired: true } });
    expect(view.history.map((h) => h.status)).toEqual(['VERIFIED', 'ABSENT']);
    expect(JSON.stringify(view)).not.toContain('NONCE-NAO-DEVE-SAIR');
    await expect(serviceWith(cfg()).evidenceFor('9999')).rejects.toBeInstanceOf(NotFoundException);
    const controller = new ValePassTermsEvidenceAdminController(serviceWith(cfg()));
    expect(() => controller.evidence('1001; DROP')).toThrow(BadRequestException);
  });
});
