import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hashPin } from '../admin/admin-pin';
import { normalizePhone } from '../admin/admin-phone';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
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

/** "+5691234..." → "+56 (91) 23456-7..." — mesmo número com pontuação de verdade. */
function formatted(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return `+${d.slice(0, 2)} (${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
}

async function lastLoginFailure(adminUserId: string) {
  return prisma.adminAuditEvent.findFirst({ where: { adminUserId, action: 'LOGIN_FAILED' }, orderBy: { createdAt: 'desc' } });
}

describe('AdminAuthService — telefone e nome como a pessoa digita (integração real)', () => {
  test('14) telefone formatado (espaços, parênteses, hífen) entra normalmente', async () => {
    const { user, pin } = await createUser({ name: 'Formatado Teste' });
    const result = await service.login({ name: user.name, phone: formatted(user.phone), pin });
    expect(result.adminUser.id).toBe(user.id);
  });

  test('15) cadastro antigo gravado sem "+" entra com o número digitado com "+DDI" (e o contrário)', async () => {
    const legacy = await createUser({ name: 'Legado Sem Mais', phone: `56${PHONE_TAG}${userCounter++}` });
    expect(legacy.user.phone.startsWith('+')).toBe(false);
    const viaTela = await service.login({ name: legacy.user.name, phone: formatted(`+${legacy.user.phone}`), pin: legacy.pin });
    expect(viaTela.adminUser.id).toBe(legacy.user.id);

    const modern = await createUser({ name: 'Moderno Com Mais' });
    const semMais = await service.login({ name: modern.user.name, phone: modern.user.phone.slice(1), pin: modern.pin });
    expect(semMais.adminUser.id).toBe(modern.user.id);
  });

  test('16) nome ignora maiúsculas, acentos e espaços repetidos — mas nunca letras diferentes', async () => {
    const { user, pin } = await createUser({ name: 'José  Conceição' });
    await expect(service.login({ name: '  jose conceicao ', phone: user.phone, pin })).resolves.toMatchObject({ adminUser: { id: user.id } });
    await expect(service.login({ name: 'Jose Conceicoes', phone: user.phone, pin })).rejects.toThrow('Credenciais inválidas.');
    expect(await lastLoginFailure(user.id)).toMatchObject({ detail: { reason: 'name_mismatch' } });
  });

  test('17) PIN inválido → 401 genérico, auditado como wrong_pin, nenhuma sessão', async () => {
    const { user } = await createUser({ name: 'Pin Errado Teste', pin: '4321' });
    await expect(service.login({ name: user.name, phone: formatted(user.phone), pin: '1234' })).rejects.toThrow('Credenciais inválidas.');
    expect(await lastLoginFailure(user.id)).toMatchObject({ detail: { reason: 'wrong_pin' } });
    expect(await prisma.adminSession.count({ where: { adminUserId: user.id } })).toBe(0);
  });

  test('18) bloqueado ou removido continua sem entrar, mesmo com PIN certo (auditado como inactive)', async () => {
    const blocked = await createUser({ name: 'Bloqueado Teste', active: false });
    await expect(service.login({ name: blocked.user.name, phone: formatted(blocked.user.phone), pin: blocked.pin })).rejects.toThrow('Credenciais inválidas.');
    expect(await lastLoginFailure(blocked.user.id)).toMatchObject({ detail: { reason: 'inactive' } });

    const removed = await createUser({ name: 'Removido Teste' });
    await prisma.adminUser.update({ where: { id: removed.user.id }, data: { removedAt: new Date() } });
    await expect(service.login({ name: removed.user.name, phone: removed.user.phone, pin: removed.pin })).rejects.toThrow('Credenciais inválidas.');
    expect(await prisma.adminSession.count({ where: { adminUserId: { in: [blocked.user.id, removed.user.id] } } })).toBe(0);
  });

  test('19) auditoria de falha nunca guarda PIN nem telefone', async () => {
    const { user } = await createUser({ name: 'Auditoria Limpa', pin: '8642' });
    await expect(service.login({ name: user.name, phone: user.phone, pin: '1357' })).rejects.toThrow();
    const event = await lastLoginFailure(user.id);
    const payload = JSON.stringify(event);
    for (const secret of ['1357', '8642', user.phone, user.phone.slice(1), user.pinHash]) expect(payload).not.toContain(secret);
  });

  test('20) login → sessão válida → logout → sessão recusada (ciclo completo com telefone formatado)', async () => {
    const { user, pin } = await createUser({ name: 'Ciclo Completo', role: 'ADMIN' });
    const { token } = await service.login({ name: 'ciclo  completo', phone: formatted(user.phone), pin });
    await expect(service.validateSession(token)).resolves.toMatchObject({ id: user.id, role: 'ADMIN' });
    await service.logout(token);
    await expect(service.validateSession(token)).rejects.toThrow('Sessão inválida ou expirada.');
  });
});

/**
 * O site (apps/marketing) separa "credenciais erradas" de "o site não está
 * autorizado a falar com a API" pela mensagem do 401 — só `Credenciais
 * inválidas.` vira erro de login pra pessoa. Este teste trava as duas
 * mensagens: se o guard passasse a responder igual ao login, um
 * ADMIN_API_TOKEN divergente voltaria a se disfarçar de senha errada.
 */
describe('AdminAuthGuard × login — 401 de configuração é distinguível', () => {
  const previous = process.env.ADMIN_API_TOKEN;
  afterAll(() => {
    if (previous === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = previous;
  });

  const contextWith = (authorization?: string) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ headers: authorization ? { authorization } : {} }) }) }) as unknown as ExecutionContext;

  test('21) token do site divergente → 401 com mensagem própria, antes de qualquer checagem de usuário', () => {
    process.env.ADMIN_API_TOKEN = 'token-configurado-no-servidor-de-teste';
    const guard = new AdminAuthGuard();
    let message = '';
    try {
      guard.canActivate(contextWith('Bearer token-diferente-do-site'));
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedException);
      message = (err as Error).message;
    }
    expect(message).toBe('Credencial administrativa inválida ou ausente.');
    expect(message).not.toBe('Credenciais inválidas.');
    expect(guard.canActivate(contextWith('Bearer token-configurado-no-servidor-de-teste'))).toBe(true);
  });
});
