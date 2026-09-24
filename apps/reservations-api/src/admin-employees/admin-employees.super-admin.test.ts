import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, Logger, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminModule, type AdminRole, type Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { hashPin } from '../admin/admin-pin';
import { normalizePhone } from '../admin/admin-phone';
import { generateSessionToken, hashSessionToken } from '../admin/admin-session-token';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { AdminAuthService } from '../admin-auth/admin-auth.service';
import { AdminEmployeesController } from './admin-employees.controller';
import { AdminEmployeesService } from './admin-employees.service';

/**
 * Criar/promover/rebaixar SUPER_ADMIN pela tela Funcionários. Integração real
 * contra PostgreSQL LOCAL (sem `DATABASE_URL` de loopback com nome de teste, o
 * arquivo é pulado): service, guard e login reais, sem mock de banco.
 *
 * Os testes de "último SUPER_ADMIN" e de concorrência isolam os SUPER_ADMINs
 * que não são do teste (desativados temporariamente e restaurados no fim),
 * porque a regra conta todos os SUPER_ADMINs ativos do banco.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const employees = new AdminEmployeesService(prisma);
const auth = new AdminAuthService(prisma);
const guard = new AdminRoleGuard(prisma, new Reflector());

const TAG = `8${Date.now()}`;
const PIN = '4739';
const ALL = [...Object.values(AdminModule)].sort();
let counter = 0;
const createdIds: string[] = [];
const phone = () => normalizePhone(`+56${TAG}${counter++}`);

async function user(role: AdminRole, opts: { active?: boolean; moduleAccess?: AdminModule[]; name?: string } = {}) {
  const row = await prisma.adminUser.create({
    data: { name: opts.name ?? `${role} teste ${counter}`, phone: phone(), pinHash: await hashPin(PIN), role, active: opts.active ?? true, moduleAccess: opts.moduleAccess ?? [] },
  });
  createdIds.push(row.id);
  return row;
}

async function sessionFor(adminUserId: string): Promise<string> {
  const token = generateSessionToken();
  await prisma.adminSession.create({ data: { adminUserId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60_000) } });
  return token;
}

function contextFor(handler: keyof AdminEmployeesController, token: string): ExecutionContext {
  const request = { headers: { 'x-admin-session': token }, query: {}, body: {} };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => AdminEmployeesController.prototype[handler],
    getClass: () => AdminEmployeesController,
  } as unknown as ExecutionContext;
}

/** Deixa ativos só os SUPER_ADMINs indicados durante `fn`; restaura os outros. */
async function withOnlySuperAdmins<T>(ids: string[], fn: () => Promise<T>): Promise<T> {
  const others = await prisma.adminUser.findMany({ where: { role: 'SUPER_ADMIN', active: true, removedAt: null, id: { notIn: ids } }, select: { id: true } });
  const otherIds = others.map((o) => o.id);
  await prisma.adminUser.updateMany({ where: { id: { in: otherIds } }, data: { active: false } });
  try {
    return await fn();
  } finally {
    await prisma.adminUser.updateMany({ where: { id: { in: otherIds } }, data: { active: true } });
  }
}

/**
 * Service cujo `tx.adminUser.count` (a contagem de SUPER_ADMINs ativos) espera
 * a outra transação chegar ao mesmo ponto — ou 400 ms, se ela estiver presa no
 * lock. Sem o lock, as duas contam o mesmo estado ao mesmo tempo (a corrida
 * real); com o lock, a segunda só conta depois do commit da primeira.
 */
function racingService(): AdminEmployeesService {
  let waiting: (() => void)[] = [];
  const barrier = () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length === 2) {
        waiting.forEach((r) => r());
        waiting = [];
      } else setTimeout(resolve, 400);
    });
  const passthrough = <T extends object>(target: T, override: (prop: PropertyKey) => unknown) =>
    new Proxy(target, {
      get(t, prop) {
        const replaced = override(prop);
        if (replaced !== undefined) return replaced;
        const value = Reflect.get(t, prop);
        return typeof value === 'function' ? value.bind(t) : value;
      },
    });
  const wrapTx = (tx: Prisma.TransactionClient) =>
    passthrough(tx, (prop) =>
      prop === 'adminUser'
        ? passthrough(tx.adminUser, (q) =>
            q === 'count'
              ? async (args: Prisma.AdminUserCountArgs) => {
                  await barrier();
                  return tx.adminUser.count(args);
                }
              : undefined,
          )
        : undefined,
    );
  const racing = passthrough(prisma, (prop) =>
    prop === '$transaction'
      ? (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, opts?: object) => prisma.$transaction((tx) => fn(wrapTx(tx)), opts)
      : undefined,
  );
  return new AdminEmployeesService(racing);
}

const settle = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
const reload = (id: string) => prisma.adminUser.findUniqueOrThrow({ where: { id } });
const sorted = (m: readonly AdminModule[]) => [...m].sort();

async function cleanup() {
  const users = await prisma.adminUser.findMany({ where: { phone: { contains: TAG } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE admin_user_id = ANY(${ids}::uuid[]) OR entity_id = ANY(${ids}::text[])`;
  await prisma.$executeRaw`DELETE FROM admin_sessions WHERE admin_user_id = ANY(${ids}::uuid[])`;
  await prisma.$executeRaw`DELETE FROM admin_users WHERE id = ANY(${ids}::uuid[])`;
}

localDescribe('Funcionários — SUPER_ADMIN pela tela (Postgres local)', () => {
  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('SUPER_ADMIN cria outro SUPER_ADMIN: todos os módulos, auditoria SUPER_ADMIN_CREATED e login funciona', async () => {
    const owner = await user('SUPER_ADMIN');
    const newPhone = phone();
    const created = await employees.create(
      { name: 'Sócia Nova', phone: newPhone, pin: PIN, role: 'SUPER_ADMIN', moduleAccess: [], superAdminConfirmation: 'SUPER_ADMIN' },
      owner.id,
      owner.name,
    );
    createdIds.push(created.id);
    expect(created.role).toBe('SUPER_ADMIN');
    expect(sorted(created.moduleAccess)).toEqual(ALL);

    const audit = await prisma.adminAuditEvent.findFirstOrThrow({ where: { entityId: created.id, action: 'SUPER_ADMIN_CREATED' } });
    expect(audit).toMatchObject({ adminUserId: owner.id, adminUserName: owner.name, isCritical: true });
    expect(audit.after).toMatchObject({ role: 'SUPER_ADMIN', active: true });

    const login = await auth.login({ name: 'Sócia Nova', phone: newPhone, pin: PIN });
    expect(login.adminUser.role).toBe('SUPER_ADMIN');
  });

  test('criar SUPER_ADMIN sem a confirmação exata → 400 e nada é criado', async () => {
    const owner = await user('SUPER_ADMIN');
    for (const superAdminConfirmation of [undefined, 'super_admin', 'SIM', ' SUPER_ADMIN']) {
      const p = phone();
      await expect(
        employees.create({ name: 'Sem confirmação', phone: p, pin: PIN, role: 'SUPER_ADMIN', moduleAccess: [], superAdminConfirmation }, owner.id, owner.name),
      ).rejects.toThrow(BadRequestException);
      expect(await prisma.adminUser.count({ where: { phone: p } })).toBe(0);
    }
  });

  test('promover STAFF a SUPER_ADMIN: exige confirmação, grava todos os módulos e audita antes/depois', async () => {
    const owner = await user('SUPER_ADMIN');
    const staff = await user('STAFF', { moduleAccess: ['CALENDAR'] });
    await expect(employees.updateRole(staff.id, { role: 'SUPER_ADMIN' }, owner.id, owner.name)).rejects.toThrow(BadRequestException);
    expect((await reload(staff.id)).role).toBe('STAFF');

    const promoted = await employees.updateRole(staff.id, { role: 'SUPER_ADMIN', moduleAccess: ['AUDIT'], superAdminConfirmation: 'SUPER_ADMIN' }, owner.id, owner.name);
    expect(promoted.role).toBe('SUPER_ADMIN');
    expect(sorted(promoted.moduleAccess)).toEqual(ALL); // módulos enviados são ignorados: acesso total

    const audit = await prisma.adminAuditEvent.findFirstOrThrow({ where: { entityId: staff.id, action: 'SUPER_ADMIN_PROMOTED' } });
    expect(audit).toMatchObject({ adminUserId: owner.id, isCritical: true, before: { role: 'STAFF', moduleAccess: ['CALENDAR'] }, after: { role: 'SUPER_ADMIN' } });
  });

  test('rebaixar SUPER_ADMIN com outro ativo: aplica os módulos, audita e a sessão dele perde o acesso na hora', async () => {
    const owner = await user('SUPER_ADMIN');
    const other = await user('SUPER_ADMIN', { moduleAccess: [...ALL] });
    const token = await sessionFor(other.id);
    await expect(guard.canActivate(contextFor('list', token))).resolves.toBe(true);

    const demoted = await employees.updateRole(other.id, { role: 'ADMIN', moduleAccess: ['RESERVATIONS', 'CALENDAR'] }, owner.id, owner.name);
    expect(demoted).toMatchObject({ role: 'ADMIN' });
    expect(sorted(demoted.moduleAccess)).toEqual(['CALENDAR', 'RESERVATIONS']);
    expect(await prisma.adminAuditEvent.findFirst({ where: { entityId: other.id, action: 'SUPER_ADMIN_DEMOTED', adminUserId: owner.id } })).not.toBeNull();

    await expect(guard.canActivate(contextFor('list', token))).rejects.toThrow(ForbiddenException);
  });

  test('ADMIN comum e STAFF: o guard nega criar, promover e listar; SUPER_ADMIN passa', async () => {
    const admin = await user('ADMIN', { moduleAccess: [...ALL] });
    const staff = await user('STAFF', { moduleAccess: [...ALL] });
    const owner = await user('SUPER_ADMIN');
    for (const actor of [admin, staff]) {
      const token = await sessionFor(actor.id);
      for (const handler of ['create', 'updateRole', 'updatePermissions', 'block', 'remove', 'list'] as const) {
        await expect(guard.canActivate(contextFor(handler, token)), `${actor.role} ${handler}`).rejects.toThrow(ForbiddenException);
      }
    }
    await expect(guard.canActivate(contextFor('updateRole', await sessionFor(owner.id)))).resolves.toBe(true);
  });

  test('defesa em profundidade: chamando o service direto, um ADMIN não cria nem promove SUPER_ADMIN (nada muda)', async () => {
    const admin = await user('ADMIN');
    const staff = await user('STAFF');
    const p = phone();
    await expect(
      employees.create({ name: 'Tentativa', phone: p, pin: PIN, role: 'SUPER_ADMIN', moduleAccess: [], superAdminConfirmation: 'SUPER_ADMIN' }, admin.id, admin.name),
    ).rejects.toThrow(ForbiddenException);
    await expect(employees.updateRole(staff.id, { role: 'SUPER_ADMIN', superAdminConfirmation: 'SUPER_ADMIN' }, admin.id, admin.name)).rejects.toThrow(ForbiddenException);
    expect(await prisma.adminUser.count({ where: { phone: p } })).toBe(0);
    expect((await reload(staff.id)).role).toBe('STAFF');
  });

  test('ninguém promove a si mesmo nem altera/bloqueia/remove a própria conta', async () => {
    const admin = await user('ADMIN');
    const owner = await user('SUPER_ADMIN');
    await expect(employees.updateRole(admin.id, { role: 'SUPER_ADMIN', superAdminConfirmation: 'SUPER_ADMIN' }, admin.id, admin.name)).rejects.toThrow(ForbiddenException);
    await expect(employees.updateRole(owner.id, { role: 'ADMIN' }, owner.id, owner.name)).rejects.toThrow(ForbiddenException);
    await expect(employees.block(owner.id, owner.id, owner.name)).rejects.toThrow(ForbiddenException);
    await expect(employees.remove(owner.id, owner.id, owner.name)).rejects.toThrow(ForbiddenException);
    expect((await reload(admin.id)).role).toBe('ADMIN');
    expect(await reload(owner.id)).toMatchObject({ role: 'SUPER_ADMIN', active: true, removedAt: null });
  });

  test('SUPER_ADMIN sempre com todos os módulos: permissões não editáveis', async () => {
    const owner = await user('SUPER_ADMIN');
    const other = await user('SUPER_ADMIN', { moduleAccess: [...ALL] });
    await expect(employees.updatePermissions(other.id, ['AUDIT'], owner.id, owner.name)).rejects.toThrow(BadRequestException);
    expect(sorted((await reload(other.id)).moduleAccess)).toEqual(ALL);
  });

  test('último SUPER_ADMIN ativo não pode ser bloqueado, removido nem rebaixado', async () => {
    const last = await user('SUPER_ADMIN', { moduleAccess: [...ALL] });
    // Ator que acabou de perder o acesso (ex.: bloqueado noutra aba): a regra
    // do último SUPER_ADMIN vale mesmo assim, antes da checagem do ator.
    const staleActor = await user('SUPER_ADMIN', { active: false });
    await withOnlySuperAdmins([last.id], async () => {
      await expect(employees.block(last.id, staleActor.id, staleActor.name)).rejects.toThrow(ConflictException);
      await expect(employees.remove(last.id, staleActor.id, staleActor.name)).rejects.toThrow(ConflictException);
      await expect(employees.updateRole(last.id, { role: 'ADMIN' }, staleActor.id, staleActor.name)).rejects.toThrow(ConflictException);
      await expect(employees.remove(last.id, last.id, last.name)).rejects.toThrow(ForbiddenException);
    });
    expect(await reload(last.id)).toMatchObject({ role: 'SUPER_ADMIN', active: true, removedAt: null });
  });

  test('concorrência: dois SUPER_ADMINs agindo um contra o outro ao mesmo tempo — sempre sobra exatamente um', async () => {
    const racing = racingService();
    type Op = (target: string, actor: { id: string; name: string }) => Promise<unknown>;
    const demote: Op = (t, a) => racing.updateRole(t, { role: 'ADMIN' }, a.id, a.name);
    const block: Op = (t, a) => racing.block(t, a.id, a.name);
    const remove: Op = (t, a) => racing.remove(t, a.id, a.name);
    for (const [first, second] of [[demote, demote], [block, remove], [remove, demote], [block, block], [demote, remove], [remove, remove]] as [Op, Op][]) {
      const a = await user('SUPER_ADMIN');
      const b = await user('SUPER_ADMIN');
      await withOnlySuperAdmins([a.id, b.id], async () => {
        const results = await Promise.all([settle(first(b.id, a)), settle(second(a.id, b))]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        // O perdedor recebe a regra de negócio (409 último SUPER_ADMIN), não um
        // 503 de deadlock — é o lock de papéis que serializa as duas.
        for (const r of results) if (!r.ok) expect(r.error).toBeInstanceOf(ConflictException);
        expect(await prisma.adminUser.count({ where: { role: 'SUPER_ADMIN', active: true, removedAt: null } })).toBe(1);
      });
    }
  }, 60_000);

  test('auditoria: todas as alterações registradas, ator da sessão, sem PIN, hash ou telefone', async () => {
    const owner = await user('SUPER_ADMIN');
    const target = await user('STAFF');
    const newPhone = phone();
    const created = await employees.create(
      { name: 'Auditada', phone: newPhone, pin: PIN, role: 'SUPER_ADMIN', moduleAccess: [], superAdminConfirmation: 'SUPER_ADMIN' },
      owner.id,
      owner.name,
    );
    createdIds.push(created.id);
    await employees.updateRole(target.id, { role: 'ADMIN' }, owner.id, owner.name);
    await employees.updateRole(target.id, { role: 'SUPER_ADMIN', superAdminConfirmation: 'SUPER_ADMIN' }, owner.id, owner.name);
    await employees.block(target.id, owner.id, owner.name);
    await employees.reactivate(target.id, owner.id, owner.name);
    await employees.updateRole(target.id, { role: 'STAFF' }, owner.id, owner.name);
    await employees.updateRole(target.id, { role: 'SUPER_ADMIN', superAdminConfirmation: 'SUPER_ADMIN' }, owner.id, owner.name);
    await employees.remove(target.id, owner.id, owner.name);

    const events = await prisma.adminAuditEvent.findMany({ where: { entityId: { in: [created.id, target.id] } }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => e.action)).toEqual([
      'SUPER_ADMIN_CREATED',
      'EMPLOYEE_ROLE_CHANGED',
      'SUPER_ADMIN_PROMOTED',
      'SUPER_ADMIN_BLOCKED',
      'EMPLOYEE_REACTIVATED',
      'SUPER_ADMIN_DEMOTED',
      'SUPER_ADMIN_PROMOTED',
      'SUPER_ADMIN_REMOVED',
    ]);
    const hashes = (await prisma.adminUser.findMany({ where: { id: { in: [created.id, target.id] } }, select: { pinHash: true, phone: true } }));
    for (const e of events) {
      expect(e).toMatchObject({ adminUserId: owner.id, adminUserName: owner.name, isCritical: true });
      const payload = JSON.stringify({ before: e.before, after: e.after, detail: e.detail });
      expect(payload).not.toMatch(/pin/i);
      expect(payload).not.toContain(PIN);
      for (const h of hashes) {
        expect(payload).not.toContain(h.pinHash);
        expect(payload).not.toContain(h.phone);
      }
    }
  });

  test('PIN e hash nunca aparecem nos logs — nem quando o banco falha', async () => {
    const owner = await user('SUPER_ADMIN');
    const lines: string[] = [];
    const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    const spies = [
      ...(['log', 'error', 'warn', 'debug', 'verbose'] as const).map((m) => vi.spyOn(Logger.prototype, m).mockImplementation(capture)),
      ...(['log', 'error', 'warn', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(capture)),
    ];
    try {
      const ok = await employees.create(
        { name: 'Logada', phone: phone(), pin: PIN, role: 'SUPER_ADMIN', moduleAccess: [], superAdminConfirmation: 'SUPER_ADMIN' },
        owner.id,
        owner.name,
      );
      createdIds.push(ok.id);
      const { pinHash } = await reload(ok.id);

      // Falha de banco com o PIN/hash na própria mensagem do erro.
      const failing = new Proxy(prisma, {
        get(target, prop) {
          if (prop === '$transaction') return () => Promise.reject(Object.assign(new Error(`falha simulada pin=${PIN} hash=${pinHash}`), { code: 'P1001' }));
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as PrismaService;
      await expect(
        new AdminEmployeesService(failing).create({ name: 'Falha', phone: phone(), pin: PIN, role: 'STAFF', moduleAccess: [] }, owner.id, owner.name),
      ).rejects.toMatchObject({ status: 503 });

      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toContain(PIN);
        expect(line).not.toContain(pinHash);
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
