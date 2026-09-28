import { describe, expect, test } from 'vitest';
import { normalizeClientIp, trustedClientIp } from './client-ip';

const ON_RAILWAY = { RAILWAY_DEPLOYMENT_ID: 'deploy-teste' };
const LOCAL = {};
const req = (headers: Record<string, string | string[]>, remoteAddress = '100.64.0.9') => ({ headers, socket: { remoteAddress } });

describe('IP confiável de quem chama a API (client-ip.ts)', () => {
  test('fora da Railway: vale SÓ a conexão — X-Real-IP e X-Forwarded-For forjados são ignorados', () => {
    const forged = req({ 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1, 203.0.113.9' }, '192.0.2.10');
    expect(trustedClientIp(forged, LOCAL)).toBe('192.0.2.10');
  });

  test('na Railway: X-Real-IP da borda; X-Forwarded-For nunca é lido', () => {
    expect(trustedClientIp(req({ 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' }), ON_RAILWAY)).toBe('203.0.113.9');
    expect(trustedClientIp(req({ 'x-forwarded-for': '198.51.100.1' }), ON_RAILWAY)).toBe('100.64.0.9');
  });

  test('X-Real-IP com vários IPs, repetido ou lixo não vira chave: cai na conexão', () => {
    for (const bad of ['203.0.113.9, 198.51.100.1', "'; DROP", '', 'x'.repeat(100)]) {
      expect(trustedClientIp(req({ 'x-real-ip': bad }), ON_RAILWAY)).toBe('100.64.0.9');
    }
    expect(trustedClientIp(req({ 'x-real-ip': ['203.0.113.9', '198.51.100.1'] }), ON_RAILWAY)).toBe('203.0.113.9');
  });

  test('normalização', () => {
    expect(normalizeClientIp('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeClientIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeClientIp(undefined)).toBe('unknown');
    expect(trustedClientIp({}, LOCAL)).toBe('unknown');
  });
});
