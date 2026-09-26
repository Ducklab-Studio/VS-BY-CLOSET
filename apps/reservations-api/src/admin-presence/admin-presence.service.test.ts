import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { BadRequestException, ForbiddenException, Logger, UnauthorizedException, ValidationPipe, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AdminRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { hashPin } from '../admin/admin-pin';
import { normalizePhone } from '../admin/admin-phone';
import { hashSessionToken } from '../admin/admin-session-token';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { AdminAuthService } from '../admin-auth/admin-auth.service';
import { AdminEmployeesService } from '../admin-employees/admin-employees.service';
import { AdminPresenceController } from './admin-presence.controller';
import { AdminPresenceService, PRESENCE_TTL_SECONDS } from './admin-presence.service';
import { PresenceClientDto } from './dto/presence-client.dto';

/**
 * Presença online/offline do ClosetAdmin — integração real contra PostgreSQL
 * LOCAL (sem DATABASE_URL de loopback com nome de teste, o arquivo é pulado).
 * Login, logout, bloqueio e remoção reais; o "tempo passando" é simulado
 * recuando `last_seen_at` no banco (o TTL é calculado com o relógio do banco).
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const presence = new AdminPresenceService(prisma);
const auth = new AdminAuthService(prisma);
const employees = new AdminEmployeesService(prisma);
const guard = new AdminRoleGuard(prisma, new Reflector());

const TAG = `7${Date.now()}`;
const PIN = '5824';
let counter = 0;

async function user(role: AdminRole = 'STAFF') {
  const name = `Presença ${role} ${counter}`;
  const phone = normalizePhone(`+56${TAG}${counter++}`);
  const row = await prisma.adminUser.create({ data: { name, phone, pinHash: await hashPin(PIN), role, moduleAccess: ['RESERVATIONS'] } });
  return row;
}
const login = async (u: { name: string; phone: string }) => (await auth.login({ name: u.name, phone: u.phone, pin: PIN })).token;
const tab = () => randomUUID();
const statusOf = async (id: string) => (await presence.list()).find((p) => p.adminUserId === id);
/** Simula o tempo passando sem heartbeat nenhum (aba fechada sem aviso, internet caiu, PC desligou). */
async function age(userId: string, seconds: number) {
  await prisma.$executeRaw`
    UPDATE admin_presence p SET last_seen_at = last_seen_at - make_interval(secs => ${seconds})
    FROM admin_sessions s WHERE p.session_id = s.id AND s.admin_user_id = ${userId}::uuid
  `;
}
const rowsOf = (userId: string) =>
  prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM admin_presence p JOIN admin_sessions s ON s.id = p.session_id WHERE s.admin_user_id = ${userId}::uuid
  `.then(([r]) => r.n);

function listContext(token: string): ExecutionContext {
  const request = { headers: { 'x-admin-session': token }, query: {}, body: undefined };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => AdminPresenceController.prototype.list,
    getClass: () => AdminPresenceController,
  } as unknown as ExecutionContext;
}

async function cleanup() {
  const users = await prisma.adminUser.findMany({ where: { phone: { contains: TAG } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE admin_user_id = ANY(${ids}::uuid[]) OR entity_id = ANY(${ids}::text[])`;
  await prisma.$executeRaw`DELETE FROM admin_sessions WHERE admin_user_id = ANY(${ids}::uuid[])`; // presença vai junto (CASCADE)
  await prisma.$executeRaw`DELETE FROM admin_users WHERE id = ANY(${ids}::uuid[])`;
}

localDescribe('Presença online/offline do ClosetAdmin (Postgres local)', () => {
  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('entra no painel → Online; outro usuário (SUPER_ADMIN) vê na lista só status e horário', async () => {
    const staff = await user('STAFF');
    const owner = await user('SUPER_ADMIN');
    await presence.heartbeat(await login(staff), tab());

    const ownerToken = await login(owner);
    await expect(guard.canActivate(listContext(ownerToken))).resolves.toBe(true);
    const list = await presence.list();
    const mine = list.find((p) => p.adminUserId === staff.id)!;
    expect(mine.online).toBe(true);
    expect(Date.now() - new Date(mine.lastSeenAt!).getTime()).toBeLessThan(60_000);
    expect(Object.keys(mine).sort()).toEqual(['adminUserId', 'lastSeenAt', 'online']);
  });

  test('logout → Offline na hora; heartbeat depois do logout é recusado', async () => {
    const staff = await user();
    const token = await login(staff);
    const client = tab();
    await presence.heartbeat(token, client);
    await auth.logout(token);

    expect(await statusOf(staff.id)).toMatchObject({ online: false });
    expect((await statusOf(staff.id))!.lastSeenAt).not.toBeNull();
    await expect(presence.heartbeat(token, client)).rejects.toThrow(UnauthorizedException);
    expect(await statusOf(staff.id)).toMatchObject({ online: false });
  });

  test('aba fechada sem aviso (beacon falhou) ou internet caiu → Online até o TTL, Offline depois', async () => {
    const staff = await user();
    await presence.heartbeat(await login(staff), tab());

    await age(staff.id, PRESENCE_TTL_SECONDS - 20);
    expect(await statusOf(staff.id)).toMatchObject({ online: true });
    await age(staff.id, 21);
    expect(await statusOf(staff.id)).toMatchObject({ online: false });
  });

  test('volta ao painel → Online de novo (mesma aba ou aba nova)', async () => {
    const staff = await user();
    const token = await login(staff);
    const client = tab();
    await presence.heartbeat(token, client);
    await presence.leave(token, client);
    expect(await statusOf(staff.id)).toMatchObject({ online: false });

    await presence.heartbeat(token, client);
    expect(await statusOf(staff.id)).toMatchObject({ online: true });
    await age(staff.id, PRESENCE_TTL_SECONDS + 5);
    await presence.heartbeat(token, tab());
    expect(await statusOf(staff.id)).toMatchObject({ online: true });
  });

  test('duas abas: fechar uma não deixa Offline; fechar todas deixa', async () => {
    const staff = await user();
    const token = await login(staff);
    const [a, b] = [tab(), tab()];
    await presence.heartbeat(token, a);
    await presence.heartbeat(token, b);

    await presence.leave(token, a);
    expect(await statusOf(staff.id)).toMatchObject({ online: true });
    await presence.leave(token, b);
    expect(await statusOf(staff.id)).toMatchObject({ online: false });
  });

  test('dois dispositivos (duas sessões): só fica Offline quando a última acaba', async () => {
    const staff = await user();
    const phoneToken = await login(staff);
    const laptopToken = await login(staff);
    await presence.heartbeat(phoneToken, tab());
    await presence.heartbeat(laptopToken, tab());

    await auth.logout(phoneToken);
    expect(await statusOf(staff.id)).toMatchObject({ online: true });
    // A sessão do notebook expira (12 h) — mesmo com heartbeat recente, não conta mais.
    await prisma.adminSession.update({ where: { tokenHash: hashSessionToken(laptopToken) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await statusOf(staff.id)).toMatchObject({ online: false });
  });

  test('conta desativada sem revogar as sessões (defesa extra) nunca aparece Online', async () => {
    const staff = await user();
    await presence.heartbeat(await login(staff), tab());
    await prisma.adminUser.update({ where: { id: staff.id }, data: { active: false } });
    expect(await statusOf(staff.id)).toMatchObject({ online: false });
  });

  test('sessão expirada não cria heartbeat nem mantém Online', async () => {
    const staff = await user();
    const token = await login(staff);
    await presence.heartbeat(token, tab());
    await prisma.adminSession.updateMany({ where: { adminUserId: staff.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await expect(presence.heartbeat(token, tab())).rejects.toThrow(UnauthorizedException);
    expect(await statusOf(staff.id)).toMatchObject({ online: false });
  });

  test('bloqueado ou removido: sem heartbeat, sem Online (e removido some da lista)', async () => {
    const owner = await user('SUPER_ADMIN');
    const blocked = await user();
    const removed = await user();
    const blockedToken = await login(blocked);
    const removedToken = await login(removed);
    await presence.heartbeat(blockedToken, tab());
    await presence.heartbeat(removedToken, tab());

    await employees.block(blocked.id, owner.id, owner.name);
    await employees.remove(removed.id, owner.id, owner.name);

    await expect(presence.heartbeat(blockedToken, tab())).rejects.toThrow(UnauthorizedException);
    await expect(presence.heartbeat(removedToken, tab())).rejects.toThrow(UnauthorizedException);
    expect(await statusOf(blocked.id)).toMatchObject({ online: false });
    expect(await statusOf(removed.id)).toBeUndefined();
  });

  test('sem permissão: ADMIN e STAFF não consultam a lista; o heartbeat não aceita id de outro funcionário', async () => {
    for (const role of ['ADMIN', 'STAFF'] as const) {
      const token = await login(await user(role));
      await expect(guard.canActivate(listContext(token))).rejects.toThrow(ForbiddenException);
    }
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true });
    const meta = { type: 'body' as const, metatype: PresenceClientDto };
    await expect(pipe.transform({ clientId: tab(), adminUserId: randomUUID() }, meta)).rejects.toThrow(BadRequestException);
    await expect(pipe.transform({ clientId: 'nao-e-uuid' }, meta)).rejects.toThrow(BadRequestException);
    await expect(pipe.transform({ clientId: tab() }, meta)).resolves.toBeDefined();
    await expect(presence.heartbeat('token-que-nunca-existiu-000000000000', tab())).rejects.toThrow(UnauthorizedException);
  });

  test('heartbeats repetidos da mesma aba não duplicam registro', async () => {
    const staff = await user();
    const token = await login(staff);
    const client = tab();
    for (let i = 0; i < 10; i++) await presence.heartbeat(token, client);
    await Promise.all(Array.from({ length: 10 }, () => presence.heartbeat(token, client)));
    expect(await rowsOf(staff.id)).toBe(1);
  });

  test('reinício da API: nada fica preso Online — instância nova calcula do banco pelo TTL', async () => {
    const staff = await user();
    await presence.heartbeat(await login(staff), tab());
    await age(staff.id, PRESENCE_TTL_SECONDS + 1);

    const restarted = new AdminPresenceService(prisma);
    expect((await restarted.list()).find((p) => p.adminUserId === staff.id)).toMatchObject({ online: false });
  });

  test('concorrência heartbeat × logout: sempre termina Offline, sem presença aberta em sessão revogada', async () => {
    const staff = await user();
    for (let i = 0; i < 8; i++) {
      const token = await login(staff);
      const client = tab();
      await presence.heartbeat(token, client);
      const results = await Promise.allSettled([presence.heartbeat(token, client), auth.logout(token), presence.heartbeat(token, tab())]);
      for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(UnauthorizedException);
      expect(await statusOf(staff.id)).toMatchObject({ online: false });
    }
    const [open] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM admin_presence p JOIN admin_sessions s ON s.id = p.session_id
      WHERE s.admin_user_id = ${staff.id}::uuid AND s.revoked_at IS NOT NULL AND p.ended_at IS NULL
    `;
    expect(open.n).toBe(0);
  });

  test('presença não gera auditoria nem loga PIN, token ou segredo — nem quando o banco falha', async () => {
    const staff = await user();
    const token = await login(staff);
    const auditBefore = await prisma.adminAuditEvent.count({ where: { adminUserId: staff.id } });
    const lines: string[] = [];
    const spies = (['log', 'error', 'warn', 'debug', 'verbose'] as const).map((m) =>
      vi.spyOn(Logger.prototype, m).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' '))),
    );
    try {
      const client = tab();
      await presence.heartbeat(token, client);
      await presence.leave(token, client);
      await presence.list();
      const failing = new Proxy(prisma, {
        get(target, prop) {
          if (prop === '$transaction' || prop === '$executeRaw' || prop === '$queryRaw') {
            return () => Promise.reject(Object.assign(new Error(`falha simulada token=${token} pin=${PIN}`), { code: 'P1001' }));
          }
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as PrismaService;
      const broken = new AdminPresenceService(failing);
      await expect(broken.heartbeat(token, client)).rejects.toMatchObject({ status: 503 });
      await broken.leave(token, client);
      await expect(broken.list()).rejects.toMatchObject({ status: 503 });
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(token);
      expect(line).not.toContain(PIN);
    }
    expect(await prisma.adminAuditEvent.count({ where: { adminUserId: staff.id } })).toBe(auditBefore);
  });
});
