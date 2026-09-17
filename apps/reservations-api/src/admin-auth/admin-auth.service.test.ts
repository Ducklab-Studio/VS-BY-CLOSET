import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hashPin } from '../admin/admin-pin';
import { normalizePhone } from '../admin/admin-phone';
import { AdminAuthService } from './admin-auth.service';

/**
 * Integração real (Neon) — mesmo padrão de admin-reservations.service.test.ts.
 * Cobre a lista de testes obrigatória da Fase 9 (AUTH): credenciais
 * corretas; PIN errado; telefone inexistente; nome não confere; usuário
 * inactive; sessão inexistente/expirada/revogada; logout real; e —
 * criticamente — que as 4 falhas de login são INDISTINGUÍVEIS de fora
 * (item 18: "respostas de login não devem revelar se telefone/nome
 * existem").
 */
const prisma = new PrismaService();
const service = new AdminAuthService(prisma);

// Tag puramente numérica — o telefone passa por `normalizePhone` (remove
// tudo que não é dígito) tanto na gravação real quanto no login, então um
// prefixo com letras nunca sobreviveria à normalização e quebraria a
// busca por telefone (achado real ao rodar este arquivo pela 1ª vez).
const PHONE_TAG = `9${Date.now()}`;
// LOGIN_FAILED por telefone/nome inexistente grava `adminUserId: null`
// (não há AdminUser real pra vincular — ver admin-audit.ts) — não pode
// ser limpo pelo filtro de `phone` acima. Achado real: sem isto, cada
// rodada da suíte deixava linhas de auditoria órfãs pra sempre. A janela
// de tempo é segura porque a suíte roda sequencial (`fileParallelism:
// false`, ver vitest.config.ts).
const TEST_STARTED_AT = new Date();
let userCounter = 0;

async function createUser(opts: { name?: string; phone?: string; pin?: string; active?: boolean; role?: 'ADMIN' | 'STAFF' } = {}) {
  const pin = opts.pin ?? '1234';
  const pinHash = await hashPin(pin);
  const phone = normalizePhone(opts.phone ?? `+56${PHONE_TAG}${userCounter++}`);
  const user = await prisma.adminUser.create({
    data: {
      name: opts.name ?? 'Maria Teste',
      phone,
      pinHash,
      role: opts.role ?? 'STAFF',
      active: opts.active ?? true,
    },
  });
  return { user, pin };
}

async function cleanup() {
  const users = await prisma.adminUser.findMany({ where: { phone: { contains: PHONE_TAG } } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE admin_user_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM admin_sessions WHERE admin_user_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM admin_users WHERE id = ANY(${ids}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE admin_user_id IS NULL AND action = 'LOGIN_FAILED' AND created_at >= ${TEST_STARTED_AT}`;
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('AdminAuthService — login (integração real, Neon)', () => {
  test('1) credenciais corretas → token + expiresAt + adminUser público (sem pinHash)', async () => {
    const { user, pin } = await createUser({ name: 'Carla Staff' });
    const result = await service.login({ name: user.name, phone: user.phone, pin });

    expect(result.token).toEqual(expect.any(String));
    expect(result.token.length).toBeGreaterThanOrEqual(32);
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(result.adminUser).toEqual({ id: user.id, name: user.name, role: 'STAFF', isTechnical: false, moduleAccess: [] });
    expect(result.adminUser).not.toHaveProperty('pinHash');
    expect(JSON.stringify(result)).not.toContain('pinHash');

    const session = await prisma.adminSession.findFirst({ where: { adminUserId: user.id } });
    expect(session).not.toBeNull();
    expect(session!.revokedAt).toBeNull();
  }, 15_000);

  test('2) PIN errado → mesma UnauthorizedException genérica', async () => {
    const { user } = await createUser({ name: 'Bruno Staff', pin: '5555' });
    await expect(service.login({ name: user.name, phone: user.phone, pin: '0000' })).rejects.toThrow(UnauthorizedException);
    await expect(service.login({ name: user.name, phone: user.phone, pin: '0000' })).rejects.toThrow('Credenciais inválidas.');
  });

  test('3) telefone inexistente → mesma UnauthorizedException genérica (nenhuma distinção de "não encontrado")', async () => {
    await expect(service.login({ name: 'Qualquer Nome', phone: `+56${PHONE_TAG}999999`, pin: '1234' })).rejects.toThrow('Credenciais inválidas.');
  });

  test('4) nome não confere (telefone e PIN corretos) → mesma UnauthorizedException genérica', async () => {
    const { user, pin } = await createUser({ name: 'Nome Real' });
    await expect(service.login({ name: 'Nome Errado', phone: user.phone, pin })).rejects.toThrow('Credenciais inválidas.');
  });

  test('5) usuário inactive → mesma UnauthorizedException genérica, nenhuma sessão criada', async () => {
    const { user, pin } = await createUser({ name: 'Inativo Teste', active: false });
    await expect(service.login({ name: user.name, phone: user.phone, pin })).rejects.toThrow('Credenciais inválidas.');
    const session = await prisma.adminSession.findFirst({ where: { adminUserId: user.id } });
    expect(session).toBeNull();
  });

  test('6) as 4 falhas produzem exatamente a mesma mensagem — sem enumeração de usuário/telefone', async () => {
    const { user, pin } = await createUser({ name: 'Enumeracao Teste' });
    const messages: string[] = [];
    for (const attempt of [
      () => service.login({ name: 'Nome Errado', phone: `+56${PHONE_TAG}888888`, pin: '1234' }),
      () => service.login({ name: 'Nome Errado', phone: user.phone, pin }),
      () => service.login({ name: user.name, phone: user.phone, pin: '9999' }),
    ]) {
      try {
        await attempt();
        throw new Error('deveria ter lançado');
      } catch (err) {
        messages.push((err as Error).message);
      }
    }
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe('Credenciais inválidas.');
  });
});

describe('AdminAuthService — sessão (integração real, Neon)', () => {
  test('7) sessão válida recém-criada → validateSession devolve o usuário', async () => {
    const { user, pin } = await createUser({ name: 'Sessao Valida', role: 'ADMIN' });
    const { token } = await service.login({ name: user.name, phone: user.phone, pin });
    const result = await service.validateSession(token);
    expect(result).toEqual({ id: user.id, name: user.name, role: 'ADMIN', isTechnical: false, moduleAccess: [] });
  });

  test('8) token inexistente/inválido → UnauthorizedException', async () => {
    await expect(service.validateSession('token-que-nunca-existiu-0000000000000000')).rejects.toThrow('Sessão inválida ou expirada.');
  });

  test('9) sessão expirada → UnauthorizedException (mesmo com token correto)', async () => {
    const { user, pin } = await createUser({ name: 'Sessao Expirada' });
    const { token } = await service.login({ name: user.name, phone: user.phone, pin });
    await prisma.adminSession.updateMany({ where: { adminUserId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(service.validateSession(token)).rejects.toThrow('Sessão inválida ou expirada.');
  });

  test('10) sessão revogada (logout) → UnauthorizedException', async () => {
    const { user, pin } = await createUser({ name: 'Sessao Revogada' });
    const { token } = await service.login({ name: user.name, phone: user.phone, pin });
    await service.logout(token);
    await expect(service.validateSession(token)).rejects.toThrow('Sessão inválida ou expirada.');
  });

  test('11) usuário desativado DEPOIS de logar → sessão existente perde acesso', async () => {
    const { user, pin } = await createUser({ name: 'Vai Ser Desativado' });
    const { token } = await service.login({ name: user.name, phone: user.phone, pin });
    await prisma.adminUser.update({ where: { id: user.id }, data: { active: false } });
    await expect(service.validateSession(token)).rejects.toThrow('Sessão inválida ou expirada.');
  });

  test('12) logout é idempotente — chamar duas vezes não lança erro', async () => {
    const { user, pin } = await createUser({ name: 'Logout Duplo' });
    const { token } = await service.login({ name: user.name, phone: user.phone, pin });
    await service.logout(token);
    await expect(service.logout(token)).resolves.toBeUndefined();
  });

  test('13) logout com token nunca emitido → não lança erro (não revela nada)', async () => {
    await expect(service.logout('token-nunca-emitido-0000000000000000000')).resolves.toBeUndefined();
  });
});
