import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { hashPin } from './admin-pin';
import { AdminRoleGuard } from './admin-role.guard';
import { REQUIRE_ROLE_KEY } from './require-role.decorator';

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

async function createUser(role: 'ADMIN' | 'STAFF', active = true) {
  const pinHash = await hashPin('1234');
  return prisma.adminUser.create({
    data: { name: 'Guard Teste', phone: `${PHONE_TAG}${userCounter++}`, pinHash, role, active },
  });
}

function contextWith(input: { query?: Record<string, unknown>; body?: Record<string, unknown>; requiredRole?: 'ADMIN' | 'STAFF' }): ExecutionContext {
  const handler = () => undefined;
  if (input.requiredRole) Reflect.defineMetadata(REQUIRE_ROLE_KEY, input.requiredRole, handler);
  const request: { query: Record<string, unknown>; body: Record<string, unknown> | undefined; adminUser?: unknown } = {
    query: input.query ?? {},
    body: input.body,
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
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
  test('1) adminUserId ausente (nem query nem body) → UnauthorizedException', async () => {
    await expect(guard.canActivate(contextWith({}))).rejects.toThrow(UnauthorizedException);
  }, 15_000);

  test('2) adminUserId inexistente no banco → UnauthorizedException', async () => {
    await expect(guard.canActivate(contextWith({ query: { adminUserId: '00000000-0000-0000-0000-000000000000' } }))).rejects.toThrow(
      'Usuário administrativo inválido ou inativo.',
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
    expect(request.adminUser).toEqual({ id: user.id, name: 'Guard Teste', role: 'STAFF', active: true });
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
