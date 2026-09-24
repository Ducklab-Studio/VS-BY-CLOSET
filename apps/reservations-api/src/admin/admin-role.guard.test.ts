import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AdminModule, AdminRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { hashPin } from './admin-pin';
import { AdminRoleGuard } from './admin-role.guard';
import { REQUIRE_ROLE_KEY } from './require-role.decorator';
import { REQUIRE_MODULE_KEY } from './require-module.decorator';
import { generateSessionToken, hashSessionToken } from './admin-session-token';

/**
 * Integração real (Neon) para os dados (AdminUser criado de verdade),
 * mas o guard em si é exercitado como unidade pura — só precisa de um
 * `ExecutionContext` mínimo (getHandler/switchToHttp().getRequest()) e
 * de um `Reflector` real (não mockado) lendo metadata gravada com
 * `Reflect.defineMetadata`, exatamente como `@RequireRole` faz por baixo
 * dos panos (`SetMetadata`).
 *
 * Cobre a lista obrigatória da Fase 9 (RBAC): STAFF acessa o que não
 * exige role; STAFF NÃO consegue chamar uma rota `@RequireRole('ADMIN')`;
 * ADMIN consegue; usuário inativo é recusado mesmo com id correto;
 * `adminUserId` ausente é recusado (fail closed, nunca confia em role
 * que o chamador afirme).
 */
const prisma = new PrismaService();
const reflector = new Reflector();
const guard = new AdminRoleGuard(prisma, reflector);

const PHONE_TAG = `9${Date.now()}`;
let userCounter = 0;
const tokens = new Map<string, string>();

async function createUser(role: AdminRole, active = true, moduleAccess: AdminModule[] = []) {
  const pinHash = await hashPin('1234');
  const user = await prisma.adminUser.create({
    data: { name: 'Guard Teste', phone: `${PHONE_TAG}${userCounter++}`, pinHash, role, active, moduleAccess },
  });
  const token = generateSessionToken();
  await prisma.adminSession.create({ data: { adminUserId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60_000) } });
  tokens.set(user.id, token);
  return user;
}

function contextWith(input: {
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  requiredRole?: AdminRole;
  requiredRoleOnClass?: boolean;
  requiredModule?: AdminModule;
  requiredModuleOnClass?: boolean;
  sessionForId?: string;
}): ExecutionContext {
  const handler = () => undefined;
  class FakeController {}
  if (input.requiredRole) {
    Reflect.defineMetadata(REQUIRE_ROLE_KEY, input.requiredRole, input.requiredRoleOnClass ? FakeController : handler);
  }
  if (input.requiredModule) {
    Reflect.defineMetadata(REQUIRE_MODULE_KEY, input.requiredModule, input.requiredModuleOnClass ? FakeController : handler);
  }
  const request = {
    headers: { 'x-admin-session': tokens.get(String(input.sessionForId ?? input.query?.adminUserId ?? input.body?.adminUserId)) },
    query: input.query ?? {},
    body: input.body,
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => FakeController,
  } as unknown as ExecutionContext;
}

async function cleanup() {
  await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE admin_user_id IN (SELECT id FROM admin_users WHERE phone LIKE ${PHONE_TAG + '%'})`;
  await prisma.$executeRaw`DELETE FROM admin_sessions WHERE admin_user_id IN (SELECT id FROM admin_users WHERE phone LIKE ${PHONE_TAG + '%'})`;
  await prisma.$executeRaw`DELETE FROM admin_users WHERE phone LIKE ${PHONE_TAG + '%'}`;
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('AdminRoleGuard — RBAC (integração real, Neon)', () => {
  test('revoked or expired sessions and another user ID are rejected', async () => {
    const user = await createUser('ADMIN');
    const other = await createUser('ADMIN');
    tokens.set(other.id, tokens.get(user.id)!);
    await expect(guard.canActivate(contextWith({ query: { adminUserId: other.id } }))).rejects.toThrow(UnauthorizedException);
    await prisma.adminSession.updateMany({ where: { adminUserId: user.id }, data: { revokedAt: new Date() } });
    await expect(guard.canActivate(contextWith({ query: { adminUserId: user.id } }))).rejects.toThrow(UnauthorizedException);
    await prisma.adminSession.updateMany({ where: { adminUserId: user.id }, data: { revokedAt: null, expiresAt: new Date(0) } });
    await expect(guard.canActivate(contextWith({ query: { adminUserId: user.id } }))).rejects.toThrow(UnauthorizedException);
  });
  test('1) adminUserId ausente (nem query nem body) → UnauthorizedException', async () => {
    await expect(guard.canActivate(contextWith({}))).rejects.toThrow(UnauthorizedException);
  }, 15_000);

  test('2) adminUserId inexistente no banco → UnauthorizedException', async () => {
    await expect(guard.canActivate(contextWith({ query: { adminUserId: '00000000-0000-0000-0000-000000000000' } }))).rejects.toThrow(
      'Sessão administrativa inválida.',
    );
  });

  test('3) adminUserId de usuário inativo → UnauthorizedException, mesmo id correto', async () => {
    const user = await createUser('STAFF', false);
    await expect(guard.canActivate(contextWith({ query: { adminUserId: user.id } }))).rejects.toThrow('Usuário administrativo inválido ou inativo.');
  });

  test('4) STAFF ativo, rota sem @RequireRole → permitido, request.adminUser preenchido', async () => {
    const user = await createUser('STAFF');
    const ctx = contextWith({ query: { adminUserId: user.id } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const request = ctx.switchToHttp().getRequest<{ adminUser?: { id: string; role: string } }>();
    expect(request.adminUser).toEqual({ id: user.id, name: 'Guard Teste', role: 'STAFF', active: true, isTechnical: false, moduleAccess: [] });
  });

  /**
   * Achado real de auditoria: `@RequireRole` declarado no CONTROLLER era
   * ignorado — o guard só lia a metadata do handler, e `SetMetadata` na
   * classe grava na classe. Medido contra a API de verdade antes do fix:
   * um STAFF chamou POST /admin/employees (controller marcado
   * SUPER_ADMIN) e recebeu 201, criando um funcionário ADMIN. O módulo
   * já tinha fallback de classe; o papel não. Estes dois testes travam
   * os dois lados da resolução.
   */
  test('5a) papel exigido na CLASSE vale igual ao do handler — STAFF é recusado', async () => {
    const user = await createUser('STAFF');
    await expect(
      guard.canActivate(contextWith({ query: { adminUserId: user.id }, requiredRole: 'SUPER_ADMIN', requiredRoleOnClass: true })),
    ).rejects.toThrow(ForbiddenException);
  });

  test('5b) papel na CLASSE satisfeito pelo usuário certo → permitido', async () => {
    const user = await createUser('ADMIN');
    await expect(
      guard.canActivate(contextWith({ query: { adminUserId: user.id }, requiredRole: 'ADMIN', requiredRoleOnClass: true })),
    ).resolves.toBe(true);
  });

  test('5) STAFF ativo tentando rota @RequireRole("ADMIN") → ForbiddenException (nunca escala role)', async () => {
    const user = await createUser('STAFF');
    await expect(guard.canActivate(contextWith({ query: { adminUserId: user.id }, requiredRole: 'ADMIN' }))).rejects.toThrow(ForbiddenException);
  });

  test('6) ADMIN ativo em rota @RequireRole("ADMIN") → permitido', async () => {
    const user = await createUser('ADMIN');
    await expect(guard.canActivate(contextWith({ query: { adminUserId: user.id }, requiredRole: 'ADMIN' }))).resolves.toBe(true);
  });

  test('7) adminUserId vindo do body (ex.: POST) também é aceito, não só query', async () => {
    const user = await createUser('ADMIN');
    await expect(guard.canActivate(contextWith({ body: { adminUserId: user.id } }))).resolves.toBe(true);
  });

  test('8) adminUserId no body NÃO é suficiente pra escalar — role ainda vem do banco, não do payload', async () => {
    const user = await createUser('STAFF');
    // Um chamador malicioso não pode simplesmente mandar um "role: ADMIN" solto no body — o guard nunca lê isso.
    await expect(
      guard.canActivate(contextWith({ body: { adminUserId: user.id, role: 'ADMIN' }, requiredRole: 'ADMIN' })),
    ).rejects.toThrow(ForbiddenException);
  });
});

/**
 * Sistema de autorização de funcionários — SUPER_ADMIN satisfaz
 * @RequireRole('ADMIN') por hierarquia (nunca o inverso), e
 * @RequireModule é a checagem SEPARADA que SUPER_ADMIN sempre pula
 * (nunca consulta moduleAccess dele). STAFF/ADMIN sem o módulo
 * concedido são recusados mesmo em rotas sem @RequireRole nenhum.
 */
describe('AdminRoleGuard — hierarquia SUPER_ADMIN e @RequireModule (integração real, Neon)', () => {
  test('9) SUPER_ADMIN satisfaz @RequireRole("ADMIN") por hierarquia', async () => {
    const owner = await createUser('SUPER_ADMIN');
    await expect(guard.canActivate(contextWith({ query: { adminUserId: owner.id }, requiredRole: 'ADMIN' }))).resolves.toBe(true);
  });

  test('10) ADMIN comum NÃO satisfaz @RequireRole("SUPER_ADMIN") — hierarquia nunca é bidirecional', async () => {
    const admin = await createUser('ADMIN');
    await expect(guard.canActivate(contextWith({ query: { adminUserId: admin.id }, requiredRole: 'SUPER_ADMIN' }))).rejects.toThrow(ForbiddenException);
  });

  test('11) SUPER_ADMIN satisfaz @RequireModule mesmo sem o módulo em moduleAccess (nunca consultado)', async () => {
    const owner = await createUser('SUPER_ADMIN', true, []);
    await expect(guard.canActivate(contextWith({ query: { adminUserId: owner.id }, requiredModule: 'AUDIT' }))).resolves.toBe(true);
  });

  test('12) STAFF sem o módulo concedido → ForbiddenException, mesmo em rota sem @RequireRole', async () => {
    const staff = await createUser('STAFF', true, ['PIECES']);
    await expect(guard.canActivate(contextWith({ query: { adminUserId: staff.id }, requiredModule: 'AUDIT' }))).rejects.toThrow(ForbiddenException);
  });

  test('13) STAFF com o módulo concedido → permitido', async () => {
    const staff = await createUser('STAFF', true, ['PIECES', 'AUDIT']);
    await expect(guard.canActivate(contextWith({ query: { adminUserId: staff.id }, requiredModule: 'AUDIT' }))).resolves.toBe(true);
  });

  test('14) @RequireModule lido do controller (metadata de classe) quando o handler não tem a própria', async () => {
    const staff = await createUser('STAFF', true, ['RULES']);
    await expect(
      guard.canActivate(contextWith({ query: { adminUserId: staff.id }, requiredModule: 'RULES', requiredModuleOnClass: true })),
    ).resolves.toBe(true);
    const other = await createUser('STAFF', true, []);
    await expect(
      guard.canActivate(contextWith({ query: { adminUserId: other.id }, requiredModule: 'RULES', requiredModuleOnClass: true })),
    ).rejects.toThrow(ForbiddenException);
  });

  test('15) @RequireRole + @RequireModule juntos: ADMIN com o módulo concedido → permitido; ADMIN sem o módulo → recusado', async () => {
    const withModule = await createUser('ADMIN', true, ['RESERVATIONS']);
    await expect(
      guard.canActivate(contextWith({ query: { adminUserId: withModule.id }, requiredRole: 'ADMIN', requiredModule: 'RESERVATIONS' })),
    ).resolves.toBe(true);

    const withoutModule = await createUser('ADMIN', true, []);
    await expect(
      guard.canActivate(contextWith({ query: { adminUserId: withoutModule.id }, requiredRole: 'ADMIN', requiredModule: 'RESERVATIONS' })),
    ).rejects.toThrow(ForbiddenException);
  });

  test.each(['STAFF', 'ADMIN', 'SUPER_ADMIN'] as const)('ação operacional aceita %s com sessão válida', async (role) => {
    const user = await createUser(role, true, role === 'SUPER_ADMIN' ? [] : ['RESERVATIONS']);
    const ctx = contextWith({ sessionForId: user.id, body: {}, requiredModule: 'RESERVATIONS' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(ctx.switchToHttp().getRequest<{ adminUser: { id: string } }>().adminUser.id).toBe(user.id);
  });

  test.each(['STAFF', 'ADMIN'] as const)('ação operacional recusa %s sem RESERVATIONS', async (role) => {
    const user = await createUser(role, true, []);
    await expect(guard.canActivate(contextWith({ sessionForId: user.id, body: {}, requiredModule: 'RESERVATIONS' }))).rejects.toThrow(ForbiddenException);
  });

  test('identidade vem da sessão; adminUserId forjado no body é recusado', async () => {
    const user = await createUser('ADMIN', true, ['RESERVATIONS']);
    const other = await createUser('ADMIN', true, ['RESERVATIONS']);
    await expect(guard.canActivate(contextWith({ sessionForId: user.id, body: { adminUserId: other.id }, requiredModule: 'RESERVATIONS' }))).rejects.toThrow(UnauthorizedException);
  });
});
