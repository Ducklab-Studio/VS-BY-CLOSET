import 'reflect-metadata';
import { afterEach, describe, expect, test } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeClientIp, isPublicAddress, trustedClientIp } from './client-ip';
import { adminSessionThrottleTracker } from './admin/admin-session-throttle';
import { ClientIpDiagnosticController } from './diagnostics/client-ip-diagnostic.controller';

const ON_RAILWAY = { RAILWAY_DEPLOYMENT_ID: 'deploy-teste' };
const req = (headers: Record<string, string | string[]>, remoteAddress = '100.64.0.9') => ({ headers, socket: { remoteAddress } });

describe('endereços públicos × internos (o X-Real-IP só vale se for de um visitante da internet)', () => {
  test.each(['8.8.8.8', '203.0.113.9', '157.52.1.1', '2001:db8::1', '2606:4700::1111'])('%s é público', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
  test.each(['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '100.64.0.9', '100.127.255.1', '169.254.1.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', 'ff02::1', 'lixo', ''])('%s NÃO é público', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
  test('na Railway, um X-Real-IP interno (salto da própria plataforma ou valor forjado de rede privada) não vira o cliente: vale a conexão', () => {
    for (const internal of ['10.0.0.5', '100.64.1.1', '192.168.0.9', '127.0.0.1', '::1', 'fd12::1']) {
      expect(trustedClientIp(req({ 'x-real-ip': internal }, '198.51.100.7'), ON_RAILWAY), internal).toBe('198.51.100.7');
    }
    expect(trustedClientIp(req({ 'x-real-ip': '203.0.113.9' }, '198.51.100.7'), ON_RAILWAY)).toBe('203.0.113.9');
  });
});

describe('diagnóstico do IP: descreve a requisição sem tomar nada por verdade', () => {
  test('Railway com X-Real-IP público: origem x-real-ip; o X-Forwarded-For só é contado (nunca usado)', () => {
    const info = describeClientIp(req({ 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1, 203.0.113.9' }), ON_RAILWAY);
    expect(info).toMatchObject({ onRailway: true, derivedIp: '203.0.113.9', source: 'x-real-ip', xRealIp: { present: true, validIp: true, public: true, usedAsClient: true }, xForwardedFor: { present: true, hops: 2, usedAsClient: false } });
  });
  test('Railway sem X-Real-IP (ou com um interno): origem socket — sinal de que a borda NÃO está entregando o IP do visitante', () => {
    expect(describeClientIp(req({}, '198.51.100.7'), ON_RAILWAY)).toMatchObject({ derivedIp: '198.51.100.7', source: 'socket', xRealIp: { present: false, usedAsClient: false } });
    expect(describeClientIp(req({ 'x-real-ip': '100.64.0.2' }, '198.51.100.7'), ON_RAILWAY)).toMatchObject({ source: 'socket', xRealIp: { present: true, public: false, usedAsClient: false } });
  });
  test('fora da Railway: cabeçalhos forjados nunca contam', () => {
    expect(describeClientIp(req({ 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' }, '192.0.2.10'), {})).toMatchObject({ onRailway: false, derivedIp: '192.0.2.10', source: 'socket', xRealIp: { usedAsClient: false } });
  });
  test('a rota fica DESLIGADA por padrão (404) e só responde com CLIENT_IP_DIAGNOSTIC=on; nunca devolve cabeçalhos de autenticação nem valores brutos além do IP derivado', () => {
    const original = process.env.CLIENT_IP_DIAGNOSTIC;
    const controller = new ClientIpDiagnosticController();
    try {
      delete process.env.CLIENT_IP_DIAGNOSTIC;
      expect(() => controller.clientIp(req({ authorization: 'Bearer segredo' }))).toThrow(NotFoundException);
      process.env.CLIENT_IP_DIAGNOSTIC = 'true';
      expect(() => controller.clientIp(req({}))).toThrow(NotFoundException);
      process.env.CLIENT_IP_DIAGNOSTIC = 'on';
      const body = JSON.stringify(controller.clientIp(req({ authorization: 'Bearer segredo', 'x-admin-session': 'sessao-secreta-0123456789', 'x-forwarded-for': '9.9.9.9' }, '192.0.2.10')));
      expect(body).not.toMatch(/segredo|sessao-secreta|Bearer/);
      expect(body).not.toContain('9.9.9.9'); // o valor do X-Forwarded-For nem é devolvido: só quantos saltos vieram
    } finally {
      if (original === undefined) delete process.env.CLIENT_IP_DIAGNOSTIC;
      else process.env.CLIENT_IP_DIAGNOSTIC = original;
    }
  });
});

describe('limite por SESSÃO nas rotas de saldo e resgate (independe de qualquer cabeçalho de IP)', () => {
  const original = process.env.ADMIN_API_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = original;
  });
  const SERVER = 'token-do-servidor-de-teste-0123456789';
  const call = (session: string | undefined, authorization: string | undefined, ip: string) => ({
    headers: { ...(session ? { 'x-admin-session': session } : {}), ...(authorization ? { authorization } : {}), 'x-real-ip': ip, 'x-forwarded-for': ip },
    socket: { remoteAddress: '100.64.0.9' },
  });

  test('com o token do servidor: a mesma sessão cai no MESMO balde de qualquer IP; sessões diferentes têm baldes diferentes; a chave não contém o token', async () => {
    process.env.ADMIN_API_TOKEN = SERVER;
    const a1 = await adminSessionThrottleTracker(call('sessao-A-0123456789abcdef', `Bearer ${SERVER}`, '203.0.113.1'));
    const a2 = await adminSessionThrottleTracker(call('sessao-A-0123456789abcdef', `Bearer ${SERVER}`, '198.51.100.2'));
    const b = await adminSessionThrottleTracker(call('sessao-B-0123456789abcdef', `Bearer ${SERVER}`, '203.0.113.1'));
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toMatch(/^session:[0-9a-f]{32}$/);
    expect(a1).not.toContain('sessao-A');
  });
  test('sem o token do servidor (cliente direto), ou com token errado: inventar sessões NÃO troca de balde — vale a conexão', async () => {
    process.env.ADMIN_API_TOKEN = SERVER;
    const keys = new Set<string>();
    for (const forged of ['sessao-forjada-1-0123456789', 'sessao-forjada-2-0123456789', 'sessao-forjada-3-0123456789']) {
      keys.add(await adminSessionThrottleTracker(call(forged, undefined, '203.0.113.7')));
      keys.add(await adminSessionThrottleTracker(call(forged, 'Bearer chute', '203.0.113.7')));
    }
    expect([...keys]).toEqual(['conn:100.64.0.9']);
  });
  test('sessão curta/longa demais ou ausente: balde da conexão; servidor sem token configurado: nunca confia no token de sessão', async () => {
    process.env.ADMIN_API_TOKEN = SERVER;
    for (const session of ['curta', 'x'.repeat(300), undefined]) expect(await adminSessionThrottleTracker(call(session, `Bearer ${SERVER}`, '203.0.113.7'))).toBe('conn:100.64.0.9');
    delete process.env.ADMIN_API_TOKEN;
    expect(await adminSessionThrottleTracker(call('sessao-A-0123456789abcdef', 'Bearer qualquer', '203.0.113.7'))).toBe('conn:100.64.0.9');
  });
  test('as rotas de saldo/resgate usam esse balde (consulta 60/min e escrita 30/min por sessão)', () => {
    const controller = readFileSync(join(__dirname, 'vale-pass/ledger/ledger.controller.ts'), 'utf8');
    expect(controller.match(/getTracker: adminSessionThrottleTracker/g)).toHaveLength(2);
    expect(controller).toMatch(/LOOKUP_LIMIT = \{ default: \{ limit: 60, ttl: 60_000, getTracker/);
    expect(controller).toMatch(/WRITE_LIMIT = \{ default: \{ limit: 30, ttl: 60_000, getTracker/);
  });
});
