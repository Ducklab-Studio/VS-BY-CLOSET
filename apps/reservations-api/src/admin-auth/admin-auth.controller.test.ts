import 'reflect-metadata';
import { describe, expect, test } from 'vitest';
import { THROTTLER_LIMIT } from '@nestjs/throttler/dist/throttler.constants';
import { AdminAuthController, loginThrottleTracker } from './admin-auth.controller';
import type { AdminAuthService } from './admin-auth.service';
import { CLIENT_IP_HEADER, loginKey, normalizeClientIp } from './login-keys';

describe('Login: IP de quem digitou, repassado pelo servidor do site', () => {
  test('o controller entrega ao serviço exatamente o cabeçalho recebido (a validação é do serviço)', async () => {
    const calls: unknown[][] = [];
    const fake = { login: async (...args: unknown[]) => (calls.push(args), { ok: true }) } as unknown as AdminAuthService;
    await new AdminAuthController(fake).login({ name: 'Maria', phone: '+56912345678', pin: '1234' }, '203.0.113.5');
    expect(calls).toEqual([[{ name: 'Maria', phone: '+56912345678', pin: '1234' }, '203.0.113.5']]);
  });

  test('throttler do login: cabeçalho de IP só vale COM o token do servidor; chamada direta usa o IP confiável', async () => {
    const original = process.env.ADMIN_API_TOKEN;
    process.env.ADMIN_API_TOKEN = 'token-do-servidor-de-teste';
    try {
      const socket = { remoteAddress: '192.0.2.10' };
      const withToken = { headers: { authorization: 'Bearer token-do-servidor-de-teste', [CLIENT_IP_HEADER]: '203.0.113.5' }, socket };
      const direct = { headers: { [CLIENT_IP_HEADER]: '203.0.113.5' }, socket };
      const wrongToken = { headers: { authorization: 'Bearer chute', [CLIENT_IP_HEADER]: '203.0.113.5' }, socket };
      expect(await loginThrottleTracker(withToken)).toBe('client:203.0.113.5');
      // Cliente direto (sem token) escrevendo um IP qualquer: ignorado.
      expect(await loginThrottleTracker(direct)).toBe('conn:192.0.2.10');
      expect(await loginThrottleTracker(wrongToken)).toBe('conn:192.0.2.10');
      // Com token, mas IP lixo: também cai na conexão.
      expect(await loginThrottleTracker({ ...withToken, headers: { ...withToken.headers, [CLIENT_IP_HEADER]: "x'; DROP" } })).toBe('conn:192.0.2.10');
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_TOKEN;
      else process.env.ADMIN_API_TOKEN = original;
    }
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, AdminAuthController.prototype.login)).toBe(10);
  });

  test('sem token do servidor configurado, o cabeçalho nunca é confiável', async () => {
    const original = process.env.ADMIN_API_TOKEN;
    delete process.env.ADMIN_API_TOKEN;
    try {
      expect(await loginThrottleTracker({ headers: { authorization: 'Bearer x', [CLIENT_IP_HEADER]: '203.0.113.5' }, socket: { remoteAddress: '192.0.2.11' } })).toBe('conn:192.0.2.11');
    } finally {
      if (original !== undefined) process.env.ADMIN_API_TOKEN = original;
    }
  });

  test('normalização do IP e chaves só em hash', () => {
    expect(normalizeClientIp('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(normalizeClientIp(['2001:db8::1', 'x'])).toBe('2001:db8::1');
    for (const bad of [undefined, '', '1.2.3.4, 5.6.7.8', 'localhost', 'x'.repeat(100)]) expect(normalizeClientIp(bad)).toBe('unknown');
    const key = loginKey('ip', '203.0.113.5');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).not.toBe(loginKey('id', '203.0.113.5'));
  });
});
