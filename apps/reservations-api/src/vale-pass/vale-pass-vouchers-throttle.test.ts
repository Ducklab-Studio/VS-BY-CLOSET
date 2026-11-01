import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ThrottlerException, ThrottlerGuard, ThrottlerStorageService } from '@nestjs/throttler';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { ValePassVouchersController, VOUCHER_LOOKUP_LIMIT, VOUCHER_WRITE_LIMIT } from './vale-pass-vouchers.controller';

/**
 * Limite por SESSÃO administrativa nas rotas de listar/buscar/usar/cancelar/restaurar. Usa o ThrottlerGuard REAL (mesmo armazenamento e leitura de metadados do
 * runtime): o 429 é o que o guarda de fato devolve, e a chave vem do rastreador de sessão (não do IP).
 */
const SERVER = 'token-do-servidor-de-teste-0123456789';
const original = process.env.ADMIN_API_TOKEN;
const sessionA = 'sessao-A-0123456789abcdef';
const sessionB = 'sessao-B-0123456789abcdef';

function makeGuard() {
  const storage = new ThrottlerStorageService();
  // Mesmo teto global do AppModule (100/min por IP); as rotas sobrescrevem com o limite por sessão.
  const guard = new ThrottlerGuard({ throttlers: [{ ttl: 60_000, limit: 100 }], getTracker: () => Promise.resolve('global') }, storage, new Reflector());
  return { guard, storage };
}
function ctx(handler: (...a: never[]) => unknown, session: string, ip: string): ExecutionContext {
  const req = { headers: { authorization: `Bearer ${SERVER}`, 'x-admin-session': session, 'x-real-ip': ip }, socket: { remoteAddress: '100.64.0.9' } };
  const res = { header: vi.fn(), setHeader: vi.fn() };
  return {
    getHandler: () => handler,
    getClass: () => ValePassVouchersController,
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}
async function attempts(guard: ThrottlerGuard, handler: (...a: never[]) => unknown, session: string, n: number, ip = '203.0.113.1') {
  let denied = 0;
  for (let i = 0; i < n; i++) {
    try {
      await guard.canActivate(ctx(handler, session, ip));
    } catch (err) {
      if (err instanceof ThrottlerException) denied++;
      else throw err;
    }
  }
  return denied;
}

beforeEach(() => {
  process.env.ADMIN_API_TOKEN = SERVER;
});
afterEach(() => {
  if (original === undefined) delete process.env.ADMIN_API_TOKEN;
  else process.env.ADMIN_API_TOKEN = original;
  vi.useRealTimers();
});

describe('rotas de vouchers: limite por sessão (HTTP 429)', () => {
  const proto = ValePassVouchersController.prototype;

  test('listar/buscar: 60 por minuto passam, a 61ª é 429', async () => {
    const { guard } = makeGuard();
    await guard.onModuleInit();
    expect(VOUCHER_LOOKUP_LIMIT.default.limit).toBe(60);
    expect(await attempts(guard, proto.list as never, sessionA, 60)).toBe(0);
    expect(await attempts(guard, proto.list as never, sessionA, 1)).toBe(1);
  });

  test('marcar como usado / cancelar / restaurar: 30 por minuto por sessão', async () => {
    const { guard } = makeGuard();
    await guard.onModuleInit();
    expect(VOUCHER_WRITE_LIMIT.default.limit).toBe(30);
    for (const handler of [proto.markUsed, proto.cancel, proto.restore]) {
      const session = `sessao-${String(handler.name)}-0123456789abcdef`;
      expect(await attempts(guard, handler as never, session, 30), handler.name).toBe(0);
      expect(await attempts(guard, handler as never, session, 1), handler.name).toBe(1);
    }
  });

  test('isolamento entre operadores: a sessão A esgotada não afeta a sessão B, mesmo com o MESMO IP de proxy', async () => {
    const { guard } = makeGuard();
    await guard.onModuleInit();
    await attempts(guard, proto.markUsed as never, sessionA, 31, '203.0.113.50');
    expect(await attempts(guard, proto.markUsed as never, sessionA, 1, '203.0.113.50')).toBe(1);
    expect(await attempts(guard, proto.markUsed as never, sessionB, 5, '203.0.113.50')).toBe(0);
  });

  test('a mesma sessão não escapa do limite trocando de IP', async () => {
    const { guard } = makeGuard();
    await guard.onModuleInit();
    let denied = 0;
    for (let i = 0; i < 40; i++) denied += await attempts(guard, proto.markUsed as never, sessionA, 1, `198.51.100.${i + 1}`);
    expect(denied).toBe(10);
  });

  test('sem o token do servidor, uma sessão inventada não cria balde novo: cai no balde do IP (não dá para fugir do limite forjando sessões)', async () => {
    const { guard } = makeGuard();
    await guard.onModuleInit();
    let denied = 0;
    for (let i = 0; i < 40; i++) {
      const c = ctx(proto.markUsed as never, `forjada-${i}-0123456789abcdef`, '203.0.113.9');
      (c.switchToHttp().getRequest() as { headers: Record<string, string> }).headers.authorization = 'Bearer chute';
      try {
        await guard.canActivate(c);
      } catch (err) {
        if (err instanceof ThrottlerException) denied++;
      }
    }
    expect(denied).toBe(10);
  });

  test('recuperação: passado o período de bloqueio o operador volta a ser atendido (e a outra sessão nunca foi afetada)', async () => {
    vi.useFakeTimers();
    const { guard } = makeGuard();
    await guard.onModuleInit();
    expect(await attempts(guard, proto.markUsed as never, sessionA, 30)).toBe(0);
    expect(await attempts(guard, proto.markUsed as never, sessionA, 3)).toBe(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await attempts(guard, proto.markUsed as never, sessionA, 1), 'ainda bloqueada dentro da janela').toBe(1);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await attempts(guard, proto.markUsed as never, sessionA, 1), 'liberada depois da janela de 60 s').toBe(0);
  });
});
