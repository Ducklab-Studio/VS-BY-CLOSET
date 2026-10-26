import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { MIN_NEXT_TOKEN_LENGTH, resolveAdminApiTokens } from './admin-auth.config';
import { AdminAuthGuard } from './admin-auth.guard';
import { verifyAnyAdminToken } from './admin-token';

/**
 * Rotação do ADMIN_API_TOKEN sem queda: a API aceita o principal e, só durante a troca, o "próximo". Sem ADMIN_API_TOKEN_NEXT o comportamento é o de sempre.
 * Valores sintéticos; nenhum segredo real.
 */
const OLD = 'token-antigo-sintetico-0123456789-abcdefghij';
const NEW = 'token-novo-sintetico-9876543210-jihgfedcba';
const saved = { primary: process.env.ADMIN_API_TOKEN, next: process.env.ADMIN_API_TOKEN_NEXT };

beforeEach(() => {
  delete process.env.ADMIN_API_TOKEN;
  delete process.env.ADMIN_API_TOKEN_NEXT;
});
afterEach(() => {
  if (saved.primary === undefined) delete process.env.ADMIN_API_TOKEN;
  else process.env.ADMIN_API_TOKEN = saved.primary;
  if (saved.next === undefined) delete process.env.ADMIN_API_TOKEN_NEXT;
  else process.env.ADMIN_API_TOKEN_NEXT = saved.next;
});

const guard = new AdminAuthGuard();
const contextWith = (authorization?: string) => ({ switchToHttp: () => ({ getRequest: () => ({ headers: { authorization } }) }) }) as unknown as ExecutionContext;
const outcome = (authorization?: string): 'ok' | '401' | '503' => {
  try {
    return guard.canActivate(contextWith(authorization)) ? 'ok' : '401';
  } catch (error) {
    if (error instanceof UnauthorizedException) return '401';
    if (error instanceof ServiceUnavailableException) return '503';
    throw error;
  }
};

describe('tokens aceitos', () => {
  test('sem ADMIN_API_TOKEN_NEXT: só o principal (comportamento de sempre)', () => {
    process.env.ADMIN_API_TOKEN = OLD;
    expect(resolveAdminApiTokens()).toEqual([OLD]);
  });

  test('em rotação: principal e "próximo"', () => {
    process.env.ADMIN_API_TOKEN = OLD;
    process.env.ADMIN_API_TOKEN_NEXT = NEW;
    expect(resolveAdminApiTokens()).toEqual([OLD, NEW]);
  });

  test('"próximo" curto demais ou igual ao principal é IGNORADO (erro de configuração nunca amplia o acesso)', () => {
    process.env.ADMIN_API_TOKEN = OLD;
    process.env.ADMIN_API_TOKEN_NEXT = 'x'.repeat(MIN_NEXT_TOKEN_LENGTH - 1);
    expect(resolveAdminApiTokens()).toEqual([OLD]);
    process.env.ADMIN_API_TOKEN_NEXT = OLD;
    expect(resolveAdminApiTokens()).toEqual([OLD]);
  });

  test('principal ausente continua falhando fechado (503), mesmo com "próximo" definido', () => {
    process.env.ADMIN_API_TOKEN_NEXT = NEW;
    expect(() => resolveAdminApiTokens()).toThrow(ServiceUnavailableException);
    expect(outcome(`Bearer ${NEW}`)).toBe('503');
  });

  test('verifyAnyAdminToken: qualquer um dos configurados; nada, vazio ou errado não passa', () => {
    expect(verifyAnyAdminToken(OLD, [OLD, NEW])).toBe(true);
    expect(verifyAnyAdminToken(NEW, [OLD, NEW])).toBe(true);
    expect(verifyAnyAdminToken('errado', [OLD, NEW])).toBe(false);
    expect(verifyAnyAdminToken(undefined, [OLD, NEW])).toBe(false);
    expect(verifyAnyAdminToken('', [OLD, NEW])).toBe(false);
    expect(verifyAnyAdminToken(OLD, [])).toBe(false);
  });
});

describe('sequência da rotação (API primeiro, site depois): o ClosetAdmin nunca fica sem credencial válida', () => {
  test('fase 0 — hoje: só o antigo', () => {
    process.env.ADMIN_API_TOKEN = OLD;
    expect([outcome(`Bearer ${OLD}`), outcome(`Bearer ${NEW}`), outcome(undefined)]).toEqual(['ok', '401', '401']);
  });

  test('fase 1 — API com antigo + próximo: o site ainda com o antigo FUNCIONA e o site já com o novo TAMBÉM', () => {
    process.env.ADMIN_API_TOKEN = OLD;
    process.env.ADMIN_API_TOKEN_NEXT = NEW;
    expect([outcome(`Bearer ${OLD}`), outcome(`Bearer ${NEW}`), outcome('Bearer outro-valor'), outcome(undefined)]).toEqual(['ok', 'ok', '401', '401']);
  });

  test('fase 2 — API promove o novo e remove o "próximo": o novo passa e o ANTIGO é revogado', () => {
    process.env.ADMIN_API_TOKEN = NEW;
    expect([outcome(`Bearer ${NEW}`), outcome(`Bearer ${OLD}`), outcome(undefined)]).toEqual(['ok', '401', '401']);
  });

  test('cabeçalhos malformados nunca passam (sem "Bearer ", esquema errado)', () => {
    process.env.ADMIN_API_TOKEN = OLD;
    process.env.ADMIN_API_TOKEN_NEXT = NEW;
    expect([outcome(OLD), outcome(`Basic ${OLD}`), outcome(`bearer ${OLD}`)]).toEqual(['401', '401', '401']);
  });
});

describe('sessões e permissões não dependem do token do servidor', () => {
  test('a sessão administrativa (X-Admin-Session) e o RBAC são validados no banco, por outro guard: a rotação não invalida sessões', () => {
    const roleGuard = readFileSync(join(__dirname, 'admin-role.guard.ts'), 'utf8');
    expect(roleGuard).not.toMatch(/ADMIN_API_TOKEN|resolveAdminApiToken|verifyAdminToken|verifyAnyAdminToken/);
    expect(roleGuard).toMatch(/x-admin-session/);
  });

  test('os dois pontos que conferem o token do servidor usam a MESMA regra (guard das rotas e login/sessão do ClosetAdmin)', () => {
    const controller = readFileSync(join(__dirname, '../admin-auth/admin-auth.controller.ts'), 'utf8');
    const guardSource = readFileSync(join(__dirname, 'admin-auth.guard.ts'), 'utf8');
    for (const source of [controller, guardSource]) {
      expect(source).toMatch(/verifyAnyAdminToken/);
      expect(source).toMatch(/resolveAdminApiTokens/);
      expect(source).not.toMatch(/verifyAdminToken\(/);
    }
  });
});
