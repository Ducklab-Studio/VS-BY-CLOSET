import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type AdminRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { writeAdminAuditEvent } from '../../admin/admin-audit';
import { decideCompanyAccess, OPERATOR_COMPANIES, type AccessBasis, type OperatorCompany } from './operator-scope';

type Db = Pick<PrismaService | Prisma.TransactionClient, 'valePassOperatorScope'>;

export interface ScopedActor {
  readonly id: string;
  readonly role: AdminRole;
}

/** Empresas autorizadas (ativas) do operador. Lido do banco a cada operação: revogar vale na hora. */
export async function activeCompanies(db: Db, adminUserId: string): Promise<OperatorCompany[]> {
  const rows = await db.valePassOperatorScope.findMany({ where: { adminUserId, revokedAt: null }, select: { company: true } });
  return rows.map((row) => row.company);
}

/**
 * Autoriza (ou recusa com 403) uma operação de saldo do operador numa empresa. Chamado SEMPRE no backend, dentro da transação do resgate/reversão
 * (sob o lock do voucher): a interface nunca é a barreira. Devolve a base da autorização para constar na auditoria.
 */
export async function authorizeCompany(db: Db, actor: ScopedActor, company: OperatorCompany): Promise<AccessBasis> {
  const decision = decideCompanyAccess(actor.role, await activeCompanies(db, actor.id), company);
  if (!decision.allowed) throw new ForbiddenException({ statusCode: 403, error: 'Forbidden', code: decision.code, message: decision.message });
  return decision.basis;
}

export interface OperatorScopeView {
  readonly adminUserId: string;
  readonly companies: readonly OperatorCompany[];
  readonly history: readonly { readonly company: OperatorCompany; readonly grantedAt: string; readonly grantedByName: string | null; readonly revokedAt: string | null; readonly revokedByName: string | null }[];
}

const isCompany = (value: string): value is OperatorCompany => (OPERATOR_COMPANIES as readonly string[]).includes(value);

/**
 * Gestão do vínculo operador↔estabelecimento: SOMENTE o proprietário (SUPER_ADMIN), com auditoria crítica. Nada é concedido automaticamente nem por
 * migration; conceder/revogar é idempotente (repetir não duplica linha nem auditoria).
 */
@Injectable()
export class ValePassOperatorScopeService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async view(adminUserId: string, actor: { role: AdminRole }): Promise<OperatorScopeView> {
    this.requireOwner(actor);
    await this.requireUser(this.prisma, adminUserId);
    const rows = await this.prisma.valePassOperatorScope.findMany({ where: { adminUserId }, orderBy: { grantedAt: 'asc' } });
    return {
      adminUserId,
      companies: rows.filter((row) => row.revokedAt === null).map((row) => row.company),
      history: rows.map((row) => ({ company: row.company, grantedAt: row.grantedAt.toISOString(), grantedByName: row.grantedByName, revokedAt: row.revokedAt?.toISOString() ?? null, revokedByName: row.revokedByName })),
    };
  }

  async grant(adminUserId: string, companyInput: string, actor: { id: string; name: string; role: AdminRole }): Promise<{ changed: boolean; view: OperatorScopeView }> {
    this.requireOwner(actor);
    const company = this.parseCompany(companyInput);
    let changed = false;
    try {
      await this.prisma.$transaction(async (tx) => {
        const target = await this.requireUser(tx, adminUserId);
        if (!target.active) throw new ConflictException('O usuário está inativo: reative antes de autorizar.');
        const active = await tx.valePassOperatorScope.findFirst({ where: { adminUserId, company, revokedAt: null } });
        if (active) return;
        await tx.valePassOperatorScope.create({ data: { adminUserId, company, grantedBy: actor.id, grantedByName: actor.name } });
        await writeAdminAuditEvent(tx, { adminUserId: actor.id, adminUserName: actor.name, action: 'VALE_PASS_OPERATOR_SCOPE_GRANTED', entityType: 'AdminUser', entityId: adminUserId, detail: { company } });
        changed = true;
      });
    } catch (err) {
      // Duas concessões simultâneas: o índice único impede a duplicata; trata como repetição segura.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
    return { changed, view: await this.view(adminUserId, actor) };
  }

  async revoke(adminUserId: string, companyInput: string, actor: { id: string; name: string; role: AdminRole }): Promise<{ changed: boolean; view: OperatorScopeView }> {
    this.requireOwner(actor);
    const company = this.parseCompany(companyInput);
    let changed = false;
    await this.prisma.$transaction(async (tx) => {
      await this.requireUser(tx, adminUserId);
      const result = await tx.valePassOperatorScope.updateMany({ where: { adminUserId, company, revokedAt: null }, data: { revokedAt: new Date(), revokedBy: actor.id, revokedByName: actor.name } });
      if (result.count === 0) return;
      await writeAdminAuditEvent(tx, { adminUserId: actor.id, adminUserName: actor.name, action: 'VALE_PASS_OPERATOR_SCOPE_REVOKED', entityType: 'AdminUser', entityId: adminUserId, detail: { company } });
      changed = true;
    });
    return { changed, view: await this.view(adminUserId, actor) };
  }

  private requireOwner(actor: { role: AdminRole }): void {
    if (actor.role !== 'SUPER_ADMIN') throw new ForbiddenException('Somente o proprietário define quem opera cada estabelecimento.');
  }

  private parseCompany(value: string): OperatorCompany {
    if (!isCompany(value)) throw new BadRequestException('Estabelecimento inválido.');
    return value;
  }

  private async requireUser(db: Pick<PrismaService | Prisma.TransactionClient, 'adminUser'>, id: string) {
    const user = /^[0-9a-f-]{36}$/i.test(id) ? await db.adminUser.findUnique({ where: { id }, select: { id: true, active: true } }) : null;
    if (!user) throw new NotFoundException('Usuário não encontrado.');
    return user;
  }
}
