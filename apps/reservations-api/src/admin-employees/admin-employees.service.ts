import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { AdminModule, type AdminRole, type AdminUser, type Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePhone } from '../admin/admin-phone';
import { hashPin } from '../admin/admin-pin';
import { writeAdminAuditEvent } from '../admin/admin-audit';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** SUPER_ADMIN tem sempre todos os módulos gravados — papel e permissões nunca divergem. */
const ALL_MODULES = Object.values(AdminModule);
/** Texto que precisa ser digitado pra criar/promover um SUPER_ADMIN. */
export const SUPER_ADMIN_CONFIRMATION = 'SUPER_ADMIN';
const ROLE_ORDER: Record<AdminRole, number> = { SUPER_ADMIN: 0, ADMIN: 1, STAFF: 2 };

export interface EmployeeListItem {
  readonly id: string;
  readonly name: string;
  readonly phone: string;
  readonly role: AdminRole;
  readonly active: boolean;
  readonly isTechnical: boolean;
  readonly moduleAccess: readonly AdminModule[];
  readonly removedAt: string | null;
  readonly createdAt: string;
}

type Tx = Prisma.TransactionClient;

/**
 * Sistema de autorização de funcionários — "Anderson deve ser o
 * proprietário/superadmin. Ele poderá criar, autorizar, bloquear,
 * reativar e remover funcionários." O controller exige
 * @RequireRole('SUPER_ADMIN'); cada escrita aqui ainda reconfere, dentro da
 * transação, que o ator continua sendo um SUPER_ADMIN ativo.
 *
 * Toda escrita:
 *  - roda numa transação com o lock exclusivo de papéis (`lockRoles`), então
 *    duas alterações simultâneas nunca contam SUPER_ADMINs sobre o mesmo
 *    estado — nunca sobra zero SUPER_ADMIN ativo;
 *  - grava a auditoria na mesma transação (sem PIN, hash ou telefone);
 *  - nunca age sobre a própria conta (bloquear, remover, excluir, mudar papel).
 */
@Injectable()
export class AdminEmployeesService {
  private readonly logger = new Logger(AdminEmployeesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** `includeRemoved` — item do pedido: "A lista padrão deve mostrar
   *  apenas funcionários ativos... funcionários removidos devem ficar
   *  ocultos da lista principal". Filtro opcional (nunca o padrão) pra
   *  quem precisa consultar ou restaurar alguém removido. SUPER_ADMINs
   *  aparecem (primeiro) pra poderem ser rebaixados ou removidos. */
  async list(includeRemoved = false): Promise<EmployeeListItem[]> {
    const rows = await this.prisma.adminUser.findMany({
      where: includeRemoved ? {} : { removedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    // Ordem por papel feita aqui: no Postgres o enum tem SUPER_ADMIN por
    // último (ADD VALUE posterior), então `orderBy: role` não serviria.
    // `sort` é estável — dentro do mesmo papel mantém a ordem de cadastro.
    return rows.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]).map(toListItem);
  }

  async create(
    input: { name: string; phone: string; pin: string; role: AdminRole; moduleAccess: AdminModule[]; superAdminConfirmation?: string },
    actorId: string,
    actorName: string,
  ): Promise<EmployeeListItem> {
    const isSuperAdmin = input.role === 'SUPER_ADMIN';
    if (isSuperAdmin) assertSuperAdminConfirmation(input.superAdminConfirmation);
    const phone = normalizePhone(input.phone);
    const pinHash = await hashPin(input.pin);
    const moduleAccess = isSuperAdmin ? ALL_MODULES : input.moduleAccess;

    const created = await this.write('criar o funcionário', async (tx) => {
      await assertActorIsActiveSuperAdmin(tx, actorId);
      const row = await tx.adminUser.create({
        data: { name: input.name.trim(), phone, pinHash, role: input.role, moduleAccess, active: true },
      });
      await writeAdminAuditEvent(tx, {
        adminUserId: actorId,
        adminUserName: actorName,
        action: isSuperAdmin ? 'SUPER_ADMIN_CREATED' : 'EMPLOYEE_CREATED',
        entityType: 'AdminUser',
        entityId: row.id,
        // Nunca o PIN nem o hash — só o suficiente pra saber quem/quando/o quê.
        after: { name: row.name, role: row.role, moduleAccess: row.moduleAccess, active: row.active },
      });
      return row;
    });
    return toListItem(created);
  }

  async block(id: string, actorId: string, actorName: string): Promise<EmployeeListItem> {
    return this.setActive(id, false, actorId, actorName);
  }

  async reactivate(id: string, actorId: string, actorName: string): Promise<EmployeeListItem> {
    return this.setActive(id, true, actorId, actorName);
  }

  async remove(id: string, actorId: string, actorName: string): Promise<EmployeeListItem> {
    assertNotSelf(id, actorId, 'remover a própria conta');
    const updated = await this.write('remover o funcionário', async (tx) => {
      const target = await lockTarget(tx, id);
      if (isActiveSuperAdmin(target)) await assertAnotherActiveSuperAdmin(tx, id);
      await assertActorIsActiveSuperAdmin(tx, actorId);

      const row = await tx.adminUser.update({ where: { id }, data: { active: false, removedAt: new Date(), removedBy: actorId } });
      // Revoga qualquer sessão ativa — remover precisa cortar acesso na
      // hora, não só na próxima expiração natural do cookie.
      await tx.adminSession.updateMany({ where: { adminUserId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await writeAdminAuditEvent(tx, {
        adminUserId: actorId,
        adminUserName: actorName,
        action: target.role === 'SUPER_ADMIN' ? 'SUPER_ADMIN_REMOVED' : 'EMPLOYEE_REMOVED',
        entityType: 'AdminUser',
        entityId: id,
        before: { role: target.role, active: target.active, removedAt: target.removedAt },
        after: { role: row.role, active: false, removedAt: row.removedAt },
      });
      return row;
    });
    return toListItem(updated);
  }

  /** "Mostrar removidos... para consultar ou restaurar alguém" — desfaz
   *  um remove() anterior: limpa removedAt/removedBy e volta a permitir
   *  login (o PIN/telefone cadastrados continuam os mesmos, nunca
   *  resetados aqui). Nunca cria registro novo — sempre o mesmo id. */
  async restore(id: string, actorId: string, actorName: string): Promise<EmployeeListItem> {
    const updated = await this.write('restaurar o funcionário', async (tx) => {
      const target = await lockTarget(tx, id);
      if (!target.removedAt) throw new BadRequestException('Funcionário não está removido.');
      await assertActorIsActiveSuperAdmin(tx, actorId);

      const row = await tx.adminUser.update({ where: { id }, data: { active: true, removedAt: null, removedBy: null } });
      await writeAdminAuditEvent(tx, {
        adminUserId: actorId,
        adminUserName: actorName,
        action: 'EMPLOYEE_RESTORED',
        entityType: 'AdminUser',
        entityId: id,
        before: { role: target.role, active: false, removedAt: target.removedAt },
        after: { role: row.role, active: true, removedAt: null },
      });
      return row;
    });
    return toListItem(updated);
  }

  /**
   * "Excluir permanentemente" — DELETE físico de verdade, único lugar
   * neste service que faz isso (todo o resto é soft delete). Só chega
   * aqui quem já está removido (`remove()` já rodou antes); nunca
   * ativo, nunca o próprio ator.
   *
   * A auditoria HISTÓRICA do funcionário nunca é apagada — as linhas
   * antigas de `admin_audit_events` só perdem o vínculo (`adminUserId
   * = null`), mesmo padrão frouxo que `adminUserName` denormalizado já
   * existia pra sustentar (ver comentário no schema). Um evento NOVO é
   * gravado com o snapshot (nome/telefone/papel — nunca PIN/hash) ANTES
   * do delete, atribuído a quem executou a exclusão (o alvo está
   * prestes a deixar de existir, não pode ser o autor do próprio
   * evento). Tudo dentro de uma transação: se o delete falhar (ex.:
   * o funcionário já criou bloqueios operacionais — FK obrigatória sem
   * como desvincular), nada é alterado, nem a auditoria antiga.
   */
  async purge(id: string, actorId: string, actorName: string): Promise<{ id: string }> {
    if (id === actorId) throw new ForbiddenException('Você não pode excluir permanentemente a própria conta.');

    try {
      await this.prisma.$transaction(async (tx) => {
        await lockRoles(tx);
        const target = await lockTarget(tx, id);
        if (!target.removedAt) throw new BadRequestException('Só é possível excluir permanentemente um funcionário já removido.');
        await assertActorIsActiveSuperAdmin(tx, actorId);

        const snapshot = { name: target.name, phone: target.phone, role: target.role, moduleAccess: target.moduleAccess, removedAt: target.removedAt.toISOString(), createdAt: target.createdAt.toISOString() };
        // Revoga (defesa em profundidade — remove() já revogou antes) e
        // apaga fisicamente as sessões: são efêmeras, nunca precisam
        // sobreviver à conta que autenticam, e a coluna é NOT NULL (não
        // dá pra só desvincular).
        await tx.adminSession.updateMany({ where: { adminUserId: id, revokedAt: null }, data: { revokedAt: new Date() } });
        await tx.adminSession.deleteMany({ where: { adminUserId: id } });

        // Desvincula (nunca apaga) a auditoria histórica dele.
        await tx.adminAuditEvent.updateMany({ where: { adminUserId: id }, data: { adminUserId: null } });

        await writeAdminAuditEvent(tx, {
          adminUserId: actorId,
          adminUserName: actorName,
          action: 'EMPLOYEE_PURGED',
          entityType: 'AdminUser',
          entityId: id,
          before: snapshot,
          after: null,
          detail: { purgedName: target.name, purgedPhone: target.phone, purgedRole: target.role },
        });

        await tx.adminUser.delete({ where: { id } });
      });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (isForeignKeyViolation(err)) {
        throw new ConflictException(
          'Não é possível excluir permanentemente — este funcionário tem bloqueios operacionais registrados em seu nome. Ele continua removido (oculto da lista), mas o registro precisa ser mantido.',
        );
      }
      this.logger.error(`Falha ao excluir permanentemente o funcionário ${id}: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível excluir o funcionário no momento.');
    }

    return { id };
  }

  async updatePermissions(id: string, moduleAccess: AdminModule[], actorId: string, actorName: string): Promise<EmployeeListItem> {
    const updated = await this.write('atualizar as permissões', async (tx) => {
      const target = await lockTarget(tx, id);
      if (target.role === 'SUPER_ADMIN') {
        throw new BadRequestException('SUPER_ADMIN tem sempre acesso a todos os módulos. Para limitar os módulos, altere o papel primeiro.');
      }
      await assertActorIsActiveSuperAdmin(tx, actorId);

      const row = await tx.adminUser.update({ where: { id }, data: { moduleAccess } });
      await writeAdminAuditEvent(tx, {
        adminUserId: actorId,
        adminUserName: actorName,
        action: 'EMPLOYEE_PERMISSIONS_CHANGED',
        entityType: 'AdminUser',
        entityId: id,
        before: { moduleAccess: target.moduleAccess },
        after: { moduleAccess: row.moduleAccess },
      });
      return row;
    });
    return toListItem(updated);
  }

  /**
   * Promover/rebaixar. Promover a SUPER_ADMIN exige a confirmação digitada e
   * grava todos os módulos; rebaixar um SUPER_ADMIN ativo só é possível se
   * sobrar outro SUPER_ADMIN ativo. Nunca na própria conta.
   */
  async updateRole(
    id: string,
    input: { role: AdminRole; moduleAccess?: AdminModule[]; superAdminConfirmation?: string },
    actorId: string,
    actorName: string,
  ): Promise<EmployeeListItem> {
    assertNotSelf(id, actorId, 'alterar o próprio papel');
    const promoting = input.role === 'SUPER_ADMIN';
    if (promoting) assertSuperAdminConfirmation(input.superAdminConfirmation);

    const updated = await this.write('alterar o papel', async (tx) => {
      const target = await lockTarget(tx, id);
      if (target.removedAt) throw new BadRequestException('Funcionário removido — restaure antes de alterar o papel.');
      if (target.role === input.role) throw new BadRequestException('O funcionário já tem este papel.');
      const demoting = target.role === 'SUPER_ADMIN';
      if (demoting && isActiveSuperAdmin(target)) await assertAnotherActiveSuperAdmin(tx, id);
      await assertActorIsActiveSuperAdmin(tx, actorId);

      const moduleAccess = promoting ? ALL_MODULES : (input.moduleAccess ?? target.moduleAccess);
      const row = await tx.adminUser.update({ where: { id }, data: { role: input.role, moduleAccess } });
      await writeAdminAuditEvent(tx, {
        adminUserId: actorId,
        adminUserName: actorName,
        action: promoting ? 'SUPER_ADMIN_PROMOTED' : demoting ? 'SUPER_ADMIN_DEMOTED' : 'EMPLOYEE_ROLE_CHANGED',
        entityType: 'AdminUser',
        entityId: id,
        before: { role: target.role, moduleAccess: target.moduleAccess, active: target.active },
        after: { role: row.role, moduleAccess: row.moduleAccess, active: row.active },
      });
      return row;
    });
    return toListItem(updated);
  }

  private async setActive(id: string, active: boolean, actorId: string, actorName: string): Promise<EmployeeListItem> {
    assertNotSelf(id, actorId, active ? 'reativar a própria conta' : 'bloquear a própria conta');
    const updated = await this.write('atualizar o funcionário', async (tx) => {
      const target = await lockTarget(tx, id);
      if (target.removedAt) {
        throw new BadRequestException(
          active ? 'Funcionário removido não pode ser reativado — cadastre um novo acesso.' : 'Funcionário removido — sem ação de bloquear/reativar disponível.',
        );
      }
      if (!active && isActiveSuperAdmin(target)) await assertAnotherActiveSuperAdmin(tx, id);
      await assertActorIsActiveSuperAdmin(tx, actorId);

      const row = await tx.adminUser.update({ where: { id }, data: { active } });
      if (!active) {
        await tx.adminSession.updateMany({ where: { adminUserId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await writeAdminAuditEvent(tx, {
        adminUserId: actorId,
        adminUserName: actorName,
        action: active ? 'EMPLOYEE_REACTIVATED' : target.role === 'SUPER_ADMIN' ? 'SUPER_ADMIN_BLOCKED' : 'EMPLOYEE_BLOCKED',
        entityType: 'AdminUser',
        entityId: id,
        before: { role: target.role, active: target.active },
        after: { role: row.role, active: row.active },
      });
      return row;
    });
    return toListItem(updated);
  }

  /** Transação com o lock de papéis; erro de negócio (HttpException) passa
   *  direto, erro de banco vira 503 sem vazar detalhe. */
  private async write<T>(what: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockRoles(tx);
        return work(tx);
      }, { timeout: 10_000, maxWait: 5_000 });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (isUniqueViolation(err)) throw new ConflictException('Já existe um funcionário cadastrado com este telefone.');
      this.logger.error(`Falha ao ${what}: ${errorCode(err)}`);
      throw new ServiceUnavailableException(`Não foi possível ${what} no momento.`);
    }
  }
}

/** Serializa toda alteração de funcionário: a contagem de SUPER_ADMINs ativos
 *  feita dentro de uma transação vale até o commit dela. */
async function lockRoles(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('admin-users:roles'))`;
}

async function lockTarget(tx: Tx, id: string): Promise<AdminUser> {
  if (!UUID_RE.test(id)) throw new BadRequestException('id inválido.');
  await tx.$executeRaw`SELECT 1 FROM admin_users WHERE id = ${id}::uuid FOR UPDATE`;
  const target = await tx.adminUser.findUnique({ where: { id } });
  if (!target) throw new NotFoundException('Funcionário não encontrado.');
  return target;
}

/** Defesa em profundidade além do guard: o ator é relido do banco dentro da
 *  transação, então uma sessão de quem acabou de ser rebaixado/bloqueado não
 *  conclui a alteração. */
async function assertActorIsActiveSuperAdmin(tx: Tx, actorId: string): Promise<void> {
  const actor = UUID_RE.test(actorId)
    ? await tx.adminUser.findUnique({ where: { id: actorId }, select: { role: true, active: true, removedAt: true } })
    : null;
  if (!actor || actor.role !== 'SUPER_ADMIN' || !actor.active || actor.removedAt) {
    throw new ForbiddenException('Somente um SUPER_ADMIN ativo pode gerenciar funcionários.');
  }
}

async function assertAnotherActiveSuperAdmin(tx: Tx, targetId: string): Promise<void> {
  const others = await tx.adminUser.count({ where: { role: 'SUPER_ADMIN', active: true, removedAt: null, id: { not: targetId } } });
  if (others === 0) {
    throw new ConflictException('Este é o último SUPER_ADMIN ativo e não pode ser bloqueado, removido ou rebaixado. Promova outro funcionário a SUPER_ADMIN antes.');
  }
}

function assertSuperAdminConfirmation(value: string | undefined): void {
  if (value !== SUPER_ADMIN_CONFIRMATION) {
    throw new BadRequestException(`Para conceder o papel SUPER_ADMIN, confirme digitando ${SUPER_ADMIN_CONFIRMATION}.`);
  }
}

function assertNotSelf(id: string, actorId: string, what: string): void {
  if (id === actorId) throw new ForbiddenException(`Você não pode ${what}.`);
}

function isActiveSuperAdmin(user: Pick<AdminUser, 'role' | 'active' | 'removedAt'>): boolean {
  return user.role === 'SUPER_ADMIN' && user.active && !user.removedAt;
}

function toListItem(row: {
  id: string;
  name: string;
  phone: string;
  role: AdminRole;
  active: boolean;
  isTechnical: boolean;
  moduleAccess: AdminModule[];
  removedAt: Date | null;
  createdAt: Date;
}): EmployeeListItem {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    role: row.role,
    active: row.active,
    isTechnical: row.isTechnical,
    moduleAccess: row.moduleAccess,
    removedAt: row.removedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err && (err as { code: unknown }).code === 'P2002';
}

function isForeignKeyViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err && (err as { code: unknown }).code === 'P2003';
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
