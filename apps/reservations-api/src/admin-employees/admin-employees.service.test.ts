import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hashPin } from '../admin/admin-pin';
import { normalizePhone } from '../admin/admin-phone';
import { AdminAuthService } from '../admin-auth/admin-auth.service';
import { AdminEmployeesService } from './admin-employees.service';

/**
 * Integração real (Neon), mesmo padrão do resto da suíte de admin-panel
 * (PHONE_TAG único, cleanup em afterAll). Sistema de autorização de
 * funcionários — cobre a lista pedida: "Anderson deve ser o
 * proprietário/superadmin. Ele poderá criar, autorizar, bloquear,
 * reativar e remover funcionários" + "nunca credenciais compartilhadas"
 * + proteção da própria conta e do último SUPER_ADMIN (o fluxo de
 * SUPER_ADMIN em si está em admin-employees.super-admin.test.ts).
 *
 * `AdminAuthService` real (não mockado) prova ponta a ponta que
 * block()/remove() realmente impedem login — não só que uma flag mudou
 * no banco.
 */
const prisma = new PrismaService();
const employees = new AdminEmployeesService(prisma);
const auth = new AdminAuthService(prisma);

const PHONE_TAG = `9${Date.now()}`;
let phoneCounter = 0;

function freshPhone(): string {
  return normalizePhone(`+56${PHONE_TAG}${phoneCounter++}`);
}

async function createSuperAdmin() {
  const pinHash = await hashPin('1234');
  return prisma.adminUser.create({
    data: { name: 'Anderson Teste', phone: freshPhone(), pinHash, role: 'SUPER_ADMIN', active: true },
  });
}

async function cleanup() {
  const users = await prisma.adminUser.findMany({ where: { phone: { contains: PHONE_TAG } } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    // operational_blocks primeiro — FK obrigatória (createdByAdminUserId),
    // sem como desvincular; se sobrar um bloqueio de teste, o DELETE de
    // admin_users abaixo falharia com o mesmo P2003 que o teste de purge
    // bloqueado exercita de propósito.
    await prisma.$executeRaw`DELETE FROM operational_blocks WHERE created_by_admin_user_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE admin_user_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM admin_sessions WHERE admin_user_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM admin_users WHERE id = ANY(${ids}::uuid[])`;
  }
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('AdminEmployeesService — CRUD de funcionários (integração real, Neon)', () => {
  test('1) SUPER_ADMIN cria funcionário STAFF com módulos explícitos', async () => {
    const owner = await createSuperAdmin();
    const created = await employees.create(
      { name: 'Funcionaria Um', phone: freshPhone(), pin: '1234', role: 'STAFF', moduleAccess: ['RESERVATIONS', 'CALENDAR'] },
      owner.id,
      owner.name,
    );
    expect(created.role).toBe('STAFF');
    expect(created.active).toBe(true);
    expect(created.isTechnical).toBe(false);
    expect([...created.moduleAccess].sort()).toEqual(['CALENDAR', 'RESERVATIONS']);

    const event = await prisma.adminAuditEvent.findFirst({ where: { action: 'EMPLOYEE_CREATED', entityId: created.id } });
    expect(event).not.toBeNull();
    expect(event!.isCritical).toBe(true);
  }, 15_000);

  test('2) telefone duplicado → ConflictException', async () => {
    const owner = await createSuperAdmin();
    const phone = freshPhone();
    await employees.create({ name: 'Original', phone, pin: '1234', role: 'STAFF', moduleAccess: [] }, owner.id, owner.name);
    await expect(
      employees.create({ name: 'Duplicado', phone, pin: '4321', role: 'STAFF', moduleAccess: [] }, owner.id, owner.name),
    ).rejects.toThrow('Já existe um funcionário cadastrado com este telefone.');
  });

  test('3) bloquear funcionário revoga a sessão ativa e impede login (fim a fim, via AdminAuthService real)', async () => {
    const owner = await createSuperAdmin();
    const phone = freshPhone();
    const created = await employees.create({ name: 'Bloqueio Teste', phone, pin: '1234', role: 'STAFF', moduleAccess: ['PIECES'] }, owner.id, owner.name);

    const { token } = await auth.login({ name: 'Bloqueio Teste', phone, pin: '1234' });
    await expect(auth.validateSession(token)).resolves.toMatchObject({ id: created.id });

    const blocked = await employees.block(created.id, owner.id, owner.name);
    expect(blocked.active).toBe(false);

    await expect(auth.validateSession(token)).rejects.toThrow('Sessão inválida ou expirada.');
    await expect(auth.login({ name: 'Bloqueio Teste', phone, pin: '1234' })).rejects.toThrow('Credenciais inválidas.');
  }, 15_000);

  test('4) reativar funcionário bloqueado devolve o login', async () => {
    const owner = await createSuperAdmin();
    const phone = freshPhone();
    const created = await employees.create({ name: 'Reativacao Teste', phone, pin: '1234', role: 'STAFF', moduleAccess: [] }, owner.id, owner.name);
    await employees.block(created.id, owner.id, owner.name);
    await expect(auth.login({ name: 'Reativacao Teste', phone, pin: '1234' })).rejects.toThrow('Credenciais inválidas.');

    const reactivated = await employees.reactivate(created.id, owner.id, owner.name);
    expect(reactivated.active).toBe(true);
    await expect(auth.login({ name: 'Reativacao Teste', phone, pin: '1234' })).resolves.toMatchObject({});
  }, 15_000);

  test('5) remover funcionário revoga sessão, impede login, some da lista padrão, e não pode ser reativado (só restaurado)', async () => {
    const owner = await createSuperAdmin();
    const phone = freshPhone();
    const created = await employees.create({ name: 'Remocao Teste', phone, pin: '1234', role: 'STAFF', moduleAccess: [] }, owner.id, owner.name);
    const { token } = await auth.login({ name: 'Remocao Teste', phone, pin: '1234' });

    const removed = await employees.remove(created.id, owner.id, owner.name);
    expect(removed.active).toBe(false);
    expect(removed.removedAt).not.toBeNull();

    await expect(auth.validateSession(token)).rejects.toThrow('Sessão inválida ou expirada.');
    await expect(auth.login({ name: 'Remocao Teste', phone, pin: '1234' })).rejects.toThrow('Credenciais inválidas.');
    await expect(employees.reactivate(created.id, owner.id, owner.name)).rejects.toThrow(BadRequestException);

    const defaultList = await employees.list();
    expect(defaultList.some((e) => e.id === created.id)).toBe(false);
    const listWithRemoved = await employees.list(true);
    expect(listWithRemoved.some((e) => e.id === created.id)).toBe(true);
  }, 15_000);

  test('10) restaurar funcionário removido devolve o login e volta a aparecer na lista padrão', async () => {
    const owner = await createSuperAdmin();
    const phone = freshPhone();
    const created = await employees.create({ name: 'Restauracao Teste', phone, pin: '1234', role: 'STAFF', moduleAccess: ['PIECES'] }, owner.id, owner.name);
    await employees.remove(created.id, owner.id, owner.name);
    await expect(auth.login({ name: 'Restauracao Teste', phone, pin: '1234' })).rejects.toThrow('Credenciais inválidas.');

    const restored = await employees.restore(created.id, owner.id, owner.name);
    expect(restored.active).toBe(true);
    expect(restored.removedAt).toBeNull();
    expect([...restored.moduleAccess].sort()).toEqual(['PIECES']); // preserva o que já tinha, nunca reseta

    await expect(auth.login({ name: 'Restauracao Teste', phone, pin: '1234' })).resolves.toMatchObject({});

    const defaultList = await employees.list();
    expect(defaultList.some((e) => e.id === created.id)).toBe(true);

    const event = await prisma.adminAuditEvent.findFirst({ where: { action: 'EMPLOYEE_RESTORED', entityId: created.id } });
    expect(event).not.toBeNull();
    expect(event!.isCritical).toBe(true);
  }, 15_000);

  test('11) restaurar funcionário que não está removido → BadRequestException', async () => {
    const owner = await createSuperAdmin();
    const created = await employees.create({ name: 'Nao Removido Teste', phone: freshPhone(), pin: '1234', role: 'STAFF', moduleAccess: [] }, owner.id, owner.name);
    await expect(employees.restore(created.id, owner.id, owner.name)).rejects.toThrow('Funcionário não está removido.');
  });

  test('6) atualizar permissões muda moduleAccess e fica visível em list()', async () => {
    const owner = await createSuperAdmin();
    const created = await employees.create({ name: 'Permissoes Teste', phone: freshPhone(), pin: '1234', role: 'STAFF', moduleAccess: ['PIECES'] }, owner.id, owner.name);

    const updated = await employees.updatePermissions(created.id, ['RESERVATIONS', 'AUDIT'], owner.id, owner.name);
    expect([...updated.moduleAccess].sort()).toEqual(['AUDIT', 'RESERVATIONS']);

    const list = await employees.list();
    const inList = list.find((e) => e.id === created.id);
    expect([...(inList?.moduleAccess ?? [])].sort()).toEqual(['AUDIT', 'RESERVATIONS']);
  }, 15_000);

  test('7) list() inclui SUPER_ADMINs (primeiro), pra poderem ser rebaixados ou removidos pela tela', async () => {
    const owner = await createSuperAdmin();
    const staff = await employees.create({ name: 'Listado', phone: freshPhone(), pin: '1234', role: 'STAFF', moduleAccess: [] }, owner.id, owner.name);
    const list = await employees.list();
    const ownerIndex = list.findIndex((e) => e.id === owner.id);
    expect(ownerIndex).toBeGreaterThanOrEqual(0);
    expect(ownerIndex).toBeLessThan(list.findIndex((e) => e.id === staff.id));
  });

  test('8) SUPER_ADMIN como alvo: permissões nunca editáveis; bloquear/remover só com outro SUPER_ADMIN ativo; nunca a própria conta', async () => {
    const owner = await createSuperAdmin();
    const otherOwner = await createSuperAdmin();
    await expect(employees.updatePermissions(otherOwner.id, ['AUDIT'], owner.id, owner.name)).rejects.toThrow(BadRequestException);

    // Com o ator (outro SUPER_ADMIN ativo) sobrando, a ação é permitida.
    await expect(employees.block(otherOwner.id, owner.id, owner.name)).resolves.toMatchObject({ active: false, role: 'SUPER_ADMIN' });
    await expect(employees.reactivate(otherOwner.id, owner.id, owner.name)).resolves.toMatchObject({ active: true });

    // A própria conta nunca: nem remover, nem bloquear.
    await expect(employees.remove(owner.id, owner.id, owner.name)).rejects.toThrow(ForbiddenException);
    await expect(employees.block(owner.id, owner.id, owner.name)).rejects.toThrow(ForbiddenException);
  });

  test('9) id inexistente → NotFoundException', async () => {
    const owner = await createSuperAdmin();
    await expect(employees.block('00000000-0000-0000-0000-000000000000', owner.id, owner.name)).rejects.toThrow('Funcionário não encontrado.');
  });

  test('12) list() por padrão exclui removidos; includeRemoved=true inclui', async () => {
    const owner = await createSuperAdmin();
    const active = await employees.create({ name: 'Ativo Lista', phone: freshPhone(), pin: '1234', role: 'STAFF', moduleAccess: [] }, owner.id, owner.name);
    const toRemove = await employees.create({ name: 'Removido Lista', phone: freshPhone(), pin: '1234', role: 'STAFF', moduleAccess: [] }, owner.id, owner.name);
    await employees.remove(toRemove.id, owner.id, owner.name);

    const defaultList = await employees.list();
    expect(defaultList.some((e) => e.id === active.id)).toBe(true);
    expect(defaultList.some((e) => e.id === toRemove.id)).toBe(false);

    const fullList = await employees.list(true);
    expect(fullList.some((e) => e.id === active.id)).toBe(true);
    expect(fullList.some((e) => e.id === toRemove.id)).toBe(true);
  }, 15_000);

  test('13) excluir permanentemente um funcionário ativo (nunca removido) → BadRequestException, nada é alterado', async () => {
    const owner = await createSuperAdmin();
    const created = await employees.create({ name: 'Ativo Nao Excluivel', phone: freshPhone(), pin: '1234', role: 'STAFF', moduleAccess: [] }, owner.id, owner.name);
    await expect(employees.purge(created.id, owner.id, owner.name)).rejects.toThrow('Só é possível excluir permanentemente um funcionário já removido.');

    const stillExists = await prisma.adminUser.findUnique({ where: { id: created.id } });
    expect(stillExists).not.toBeNull();
  }, 15_000);

  test('14) SUPER_ADMIN não pode excluir permanentemente a própria conta', async () => {
    const owner = await createSuperAdmin();
    await expect(employees.purge(owner.id, owner.id, owner.name)).rejects.toThrow(ForbiddenException);
  });

  test('15) excluir permanentemente: revoga/apaga sessões, apaga o registro, mantém a auditoria histórica dele (sem vínculo) e grava snapshot no novo evento', async () => {
    const owner = await createSuperAdmin();
    const phone = freshPhone();
    const created = await employees.create({ name: 'Purge Teste', phone, pin: '1234', role: 'STAFF', moduleAccess: ['PIECES'] }, owner.id, owner.name);
    const { token } = await auth.login({ name: 'Purge Teste', phone, pin: '1234' });
    await employees.remove(created.id, owner.id, owner.name);

    const result = await employees.purge(created.id, owner.id, owner.name);
    expect(result.id).toBe(created.id);

    // Some do banco de verdade — nem com includeRemoved=true aparece mais.
    const gone = await prisma.adminUser.findUnique({ where: { id: created.id } });
    expect(gone).toBeNull();
    const fullList = await employees.list(true);
    expect(fullList.some((e) => e.id === created.id)).toBe(false);

    // Sessão: revogada E fisicamente apagada (coluna NOT NULL, sem como
    // só desvincular).
    const sessions = await prisma.adminSession.findMany({ where: { adminUserId: created.id } });
    expect(sessions).toHaveLength(0);
    await expect(auth.validateSession(token)).rejects.toThrow('Sessão inválida ou expirada.');

    // Auditoria HISTÓRICA em que ELE MESMO era o ator (o LOGIN gravado
    // pelo auth.login() acima, adminUserId = created.id) continua
    // existindo — só perde o vínculo de adminUserId, nunca é apagada.
    const oldEvent = await prisma.adminAuditEvent.findFirst({ where: { action: 'LOGIN', adminUserName: 'Purge Teste' } });
    expect(oldEvent).not.toBeNull();
    expect(oldEvent!.adminUserId).toBeNull();
    expect(oldEvent!.adminUserName).toBe('Purge Teste'); // denormalizado, continua legível

    // Novo evento de purge: snapshot antes de apagar, nunca PIN/hash,
    // atribuído a quem executou (o alvo já não existe mais).
    const purgeEvent = await prisma.adminAuditEvent.findFirst({ where: { action: 'EMPLOYEE_PURGED', entityId: created.id } });
    expect(purgeEvent).not.toBeNull();
    expect(purgeEvent!.adminUserId).toBe(owner.id);
    expect(purgeEvent!.isCritical).toBe(true);
    const before = purgeEvent!.before as { name: string; phone: string; role: string };
    expect(before.name).toBe('Purge Teste');
    expect(before.phone).toBe(phone);
    expect(before.role).toBe('STAFF');
    expect(JSON.stringify(purgeEvent!.before).toLowerCase()).not.toContain('pinhash');
    expect(JSON.stringify(purgeEvent!.before).toLowerCase()).not.toContain('pin_hash');
  }, 15_000);

  test('16) excluir permanentemente falha (ConflictException) quando o funcionário criou bloqueios operacionais — nada é alterado (transação atômica)', async () => {
    const owner = await createSuperAdmin();
    const created = await employees.create({ name: 'Com Bloqueio Teste', phone: freshPhone(), pin: '1234', role: 'ADMIN', moduleAccess: ['RULES'] }, owner.id, owner.name);
    await employees.remove(created.id, owner.id, owner.name);

    const block = await prisma.operationalBlock.create({
      data: {
        scope: 'STORE_WIDE',
        startDate: new Date('2027-01-01'),
        endDate: new Date('2027-01-02'),
        reason: `bloqueio de teste ${PHONE_TAG}`,
        createdByAdminUserId: created.id,
      },
    });

    await expect(employees.purge(created.id, owner.id, owner.name)).rejects.toThrow(
      'Não é possível excluir permanentemente — este funcionário tem bloqueios operacionais registrados em seu nome. Ele continua removido (oculto da lista), mas o registro precisa ser mantido.',
    );

    // Nada foi alterado: continua existindo (removido, não excluído), e
    // nenhum evento de purge foi gravado (transação revertida por inteiro).
    const stillExists = await prisma.adminUser.findUnique({ where: { id: created.id } });
    expect(stillExists).not.toBeNull();
    expect(stillExists!.removedAt).not.toBeNull();
    const purgeEvent = await prisma.adminAuditEvent.findFirst({ where: { action: 'EMPLOYEE_PURGED', entityId: created.id } });
    expect(purgeEvent).toBeNull();

    await prisma.operationalBlock.delete({ where: { id: block.id } });
  }, 15_000);

  test('17) excluir permanentemente um id inexistente → NotFoundException', async () => {
    const owner = await createSuperAdmin();
    await expect(employees.purge('00000000-0000-0000-0000-000000000000', owner.id, owner.name)).rejects.toThrow('Funcionário não encontrado.');
  });
});
