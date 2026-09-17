import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { AdminModule, AdminRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePhone } from '../admin/admin-phone';
import { hashPin } from '../admin/admin-pin';
import { writeAdminAuditEvent } from '../admin/admin-audit';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Sistema de autorização de funcionários — "Anderson deve ser o
 * proprietário/superadmin. Ele poderá criar, autorizar, bloquear,
 * reativar e remover funcionários." Toda escrita aqui é
 * @RequireRole('SUPER_ADMIN') no controller — este service não
 * reverifica papel (já é a fronteira certa), só nunca deixa a AÇÃO
 * alvejar outro SUPER_ADMIN (item de segurança: ninguém, nem por
 * engano, bloqueia/remove o proprietário por este endpoint).
 */
@Injectable()
export class AdminEmployeesService {
  private readonly logger = new Logger(AdminEmployeesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<EmployeeListItem[]> {
    const rows = await this.prisma.adminUser.findMany({
      where: { role: { not: 'SUPER_ADMIN' } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toListItem);
  }

  async create(
    input: { name: string; phone: string; pin: string; role: 'ADMIN' | 'STAFF'; moduleAccess: AdminModule[] },
    actorId: string,
    actorName: string,
  ): Promise<EmployeeListItem> {
    const phone = normalizePhone(input.phone);
    const pinHash = await hashPin(input.pin);

    let created;
    try {
      created = await this.prisma.adminUser.create({
        data: { name: input.name.trim(), phone, pinHash, role: input.role, moduleAccess: input.moduleAccess, active: true },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('Já existe um funcionário cadastrado com este telefone.');
      this.logger.error(`Falha ao criar funcionário: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível criar o funcionário no momento.');
    }

    await writeAdminAuditEvent(this.prisma, {
      adminUserId: actorId,
      adminUserName: actorName,
      action: 'EMPLOYEE_CREATED',
      entityType: 'AdminUser',
      entityId: created.id,
      after: { name: created.name, role: created.role, moduleAccess: created.moduleAccess },
      // Nunca o PIN nem o hash — só o suficiente pra saber quem/quando/o quê.
    });

    return toListItem(created);
  }

  async block(id: string, actorId: string, actorName: string): Promise<EmployeeListItem> {
    return this.setActive(id, false, 'EMPLOYEE_BLOCKED', actorId, actorName);
  }

  async reactivate(id: string, actorId: string, actorName: string): Promise<EmployeeListItem> {
    const target = await this.requireEmployee(id);
    if (target.removedAt) throw new BadRequestException('Funcionário removido não pode ser reativado — cadastre um novo acesso.');
    return this.setActive(id, true, 'EMPLOYEE_REACTIVATED', actorId, actorName);
  }

  async remove(id: string, actorId: string, actorName: string): Promise<EmployeeListItem> {
    await this.requireEmployee(id);

    let updated;
    try {
      updated = await this.prisma.adminUser.update({
        where: { id },
        data: { active: false, removedAt: new Date(), removedBy: actorId },
      });
    } catch (err) {
      this.logger.error(`Falha ao remover funcionário ${id}: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível remover o funcionário no momento.');
    }

    // Revoga qualquer sessão ativa — remover precisa cortar acesso na
    // hora, não só na próxima expiração natural do cookie.
    await this.prisma.adminSession.updateMany({ where: { adminUserId: id, revokedAt: null }, data: { revokedAt: new Date() } });

    await writeAdminAuditEvent(this.prisma, {
      adminUserId: actorId,
      adminUserName: actorName,
      action: 'EMPLOYEE_REMOVED',
      entityType: 'AdminUser',
      entityId: id,
      before: { active: true },
      after: { active: false, removedAt: updated.removedAt },
    });

    return toListItem(updated);
  }

  async updatePermissions(id: string, moduleAccess: AdminModule[], actorId: string, actorName: string): Promise<EmployeeListItem> {
    const target = await this.requireEmployee(id);

    let updated;
    try {
      updated = await this.prisma.adminUser.update({ where: { id }, data: { moduleAccess } });
    } catch (err) {
      this.logger.error(`Falha ao atualizar permissões do funcionário ${id}: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível atualizar as permissões no momento.');
    }

    await writeAdminAuditEvent(this.prisma, {
      adminUserId: actorId,
      adminUserName: actorName,
      action: 'EMPLOYEE_PERMISSIONS_CHANGED',
      entityType: 'AdminUser',
      entityId: id,
      before: { moduleAccess: target.moduleAccess },
      after: { moduleAccess: updated.moduleAccess },
    });

    return toListItem(updated);
  }

  private async setActive(id: string, active: boolean, action: string, actorId: string, actorName: string): Promise<EmployeeListItem> {
    const target = await this.requireEmployee(id);
    if (target.removedAt) throw new BadRequestException('Funcionário removido — sem ação de bloquear/reativar disponível.');

    let updated;
    try {
      updated = await this.prisma.adminUser.update({ where: { id }, data: { active } });
    } catch (err) {
      this.logger.error(`Falha ao atualizar status do funcionário ${id}: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível atualizar o funcionário no momento.');
    }

    if (!active) {
      await this.prisma.adminSession.updateMany({ where: { adminUserId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }

    await writeAdminAuditEvent(this.prisma, {
      adminUserId: actorId,
      adminUserName: actorName,
      action,
      entityType: 'AdminUser',
      entityId: id,
      before: { active: target.active },
      after: { active: updated.active },
    });

    return toListItem(updated);
  }

  private async requireEmployee(id: string) {
    if (!UUID_RE.test(id)) throw new BadRequestException('id inválido.');
    const target = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('Funcionário não encontrado.');
    if (target.role === 'SUPER_ADMIN') throw new ForbiddenException('O proprietário não pode ser gerenciado por este endpoint.');
    return target;
  }
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

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
