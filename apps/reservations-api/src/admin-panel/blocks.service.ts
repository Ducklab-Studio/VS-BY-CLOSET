import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, type OperationalBlock } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import { civilDateFromISO, civilDateFromPgDate, civilDateToISO, isBefore } from '../rental-rules/civil-date';
import { isStrictIsoDate } from '../rental-rules/validate-rental-config';
import type { CreateBlockDto, UpdateBlockDto } from './dto/create-block.dto';
import { lockOperationalBlocks } from '../admin/operational-blocks';

export interface BlockItem {
  readonly id: string;
  readonly scope: 'STORE_WIDE' | 'UNIT';
  readonly rentalUnitId: string | null;
  readonly rentalUnitCode: string | null;
  readonly startDate: string;
  readonly endDate: string;
  readonly reason: string;
  readonly active: boolean;
  readonly createdByAdminUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly removedAt: string | null;
}

interface BlockShape {
  readonly scope: 'STORE_WIDE' | 'UNIT';
  readonly rentalUnitId: string | null;
  readonly startDate: string;
  readonly endDate: string;
  readonly reason: string;
}

/**
 * Fase 9, item 13 — /closetadmin/regras (bloqueios / períodos fechados).
 * Bloqueio real, lido diretamente por AvailabilityService/HoldsService/
 * AdminReservationsService (ver ../admin/operational-blocks.ts) — nunca só
 * visual. Nunca há override (mesmo princípio de double booking): é
 * realidade operacional, não regra de negócio soft.
 *
 * Toda escrita toma o lock exclusivo de bloqueios: espera HOLDs/reservas em
 * andamento (lock compartilhado) e as seguintes já enxergam o estado novo.
 * Desativar não apaga (`active=false`, reativável); remover é a exclusão
 * lógica (`removedAt`). Reservas existentes nunca são alteradas aqui.
 */
@Injectable()
export class AdminBlocksService {
  private readonly logger = new Logger(AdminBlocksService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** `notRemovedOnly`: esconde os removidos; desativados continuam na lista. */
  async list(notRemovedOnly: boolean): Promise<BlockItem[]> {
    try {
      return await this.prisma.$queryRaw<BlockItem[]>`
        ${SELECT_ITEM}
        WHERE ${notRemovedOnly} = false OR b.removed_at IS NULL
        ORDER BY b.start_date DESC, b.created_at DESC
      `;
    } catch (err) {
      this.logger.error(`Falha ao listar bloqueios: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível listar os bloqueios no momento.');
    }
  }

  async create(dto: CreateBlockDto, adminUserId: string, adminUserName: string): Promise<BlockItem> {
    const shape = validateShape({ scope: dto.scope, rentalUnitId: dto.rentalUnitId ?? null, startDate: dto.startDate, endDate: dto.endDate, reason: dto.reason });

    let created;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        await lockOperationalBlocks(tx, true);
        await assertUnitExists(tx, shape.rentalUnitId);
        const block = await tx.operationalBlock.create({
          data: {
            scope: shape.scope,
            rentalUnitId: shape.rentalUnitId,
            // `@db.Date` — Prisma Client exige um `Date` JS mesmo pra coluna
            // DATE pura (achado real: uma string ISO aqui lança
            // PrismaClientValidationError).
            startDate: new Date(shape.startDate),
            endDate: new Date(shape.endDate),
            reason: shape.reason,
            createdByAdminUserId: adminUserId,
          },
        });
        await writeAdminAuditEvent(tx, {
          adminUserId, adminUserName, action: 'BLOCK_CREATED', entityType: 'OperationalBlock', entityId: block.id,
          after: { ...shape, active: true },
        });
        return block;
      });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`Falha ao criar bloqueio: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível criar o bloqueio no momento.');
    }

    return this.toItem(created.id);
  }

  /** Edita datas, motivo e escopo. Só o que veio no corpo muda; o resto fica. */
  async update(id: string, dto: UpdateBlockDto, adminUserId: string, adminUserName: string): Promise<BlockItem> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockOperationalBlocks(tx, true);
        const current = await lockBlockRow(tx, id);
        if (current.removedAt) throw new ConflictException('Este bloqueio já foi removido e não pode ser editado.');

        const before = shapeOf(current);
        const scope = dto.scope ?? before.scope;
        const next = validateShape({
          scope,
          rentalUnitId: scope === 'STORE_WIDE' ? (dto.rentalUnitId ?? null) : (dto.rentalUnitId ?? before.rentalUnitId),
          startDate: dto.startDate ?? before.startDate,
          endDate: dto.endDate ?? before.endDate,
          reason: dto.reason ?? before.reason,
        });
        if (JSON.stringify(next) === JSON.stringify(before)) return;

        await assertUnitExists(tx, next.rentalUnitId);
        await tx.operationalBlock.update({
          where: { id },
          data: {
            scope: next.scope,
            rentalUnitId: next.rentalUnitId,
            startDate: new Date(next.startDate),
            endDate: new Date(next.endDate),
            reason: next.reason,
            updatedAt: new Date(),
          },
        });
        await writeAdminAuditEvent(tx, {
          adminUserId, adminUserName, action: 'BLOCK_UPDATED', entityType: 'OperationalBlock', entityId: id,
          before, after: next,
        });
      });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`Falha ao editar bloqueio ${id}: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível editar o bloqueio no momento.');
    }
    return this.toItem(id);
  }

  async setActive(id: string, active: boolean, adminUserId: string, adminUserName: string): Promise<BlockItem> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockOperationalBlocks(tx, true);
        const changed = await tx.operationalBlock.updateMany({
          where: { id, removedAt: null, active: !active },
          data: { active, updatedAt: new Date() },
        });
        if (changed.count !== 1) {
          const current = await tx.operationalBlock.findUnique({ where: { id }, select: { removedAt: true } });
          if (!current) throw new NotFoundException('Bloqueio não encontrado.');
          if (current.removedAt) throw new ConflictException('Este bloqueio já foi removido.');
          throw new ConflictException(active ? 'Este bloqueio já está ativo.' : 'Este bloqueio já está desativado.');
        }
        await writeAdminAuditEvent(tx, {
          adminUserId, adminUserName, action: active ? 'BLOCK_ACTIVATED' : 'BLOCK_DEACTIVATED', entityType: 'OperationalBlock', entityId: id,
          before: { active: !active }, after: { active },
        });
      });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`Falha ao ${active ? 'ativar' : 'desativar'} bloqueio ${id}: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível alterar o bloqueio no momento.');
    }
    return this.toItem(id);
  }

  async remove(id: string, adminUserId: string, adminUserName: string): Promise<BlockItem> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockOperationalBlocks(tx, true);
        const removedAt = new Date();
        const updated = await tx.operationalBlock.updateMany({ where: { id, removedAt: null }, data: { removedAt } });
        if (!updated.count) {
          const exists = await tx.operationalBlock.findUnique({ where: { id }, select: { id: true } });
          if (!exists) throw new NotFoundException('Bloqueio não encontrado.');
          throw new ConflictException('Este bloqueio já foi levantado.');
        }
        await writeAdminAuditEvent(tx, {
          adminUserId, adminUserName, action: 'BLOCK_REMOVED', entityType: 'OperationalBlock', entityId: id,
          before: { removedAt: null }, after: { removedAt: removedAt.toISOString() },
        });
      });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`Falha ao remover bloqueio ${id}: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível remover o bloqueio no momento.');
    }

    return this.toItem(id);
  }

  private async toItem(id: string): Promise<BlockItem> {
    const [item] = await this.prisma.$queryRaw<BlockItem[]>`
      ${SELECT_ITEM}
      WHERE b.id = ${id}::uuid
    `;
    return item;
  }
}

// Mesma projeção pra lista e item único.
const SELECT_ITEM = Prisma.sql`
  SELECT
    b.id, b.scope, b.rental_unit_id AS "rentalUnitId", ru.code AS "rentalUnitCode",
    b.start_date::text AS "startDate", b.end_date::text AS "endDate", b.reason, b.active,
    b.created_by_admin_user_id AS "createdByAdminUserId", b.created_at::text AS "createdAt",
    b.updated_at::text AS "updatedAt", b.removed_at::text AS "removedAt"
  FROM operational_blocks b
  LEFT JOIN rental_units ru ON ru.id = b.rental_unit_id
`;

function validateShape(shape: BlockShape): BlockShape {
  if (shape.scope === 'UNIT' && !shape.rentalUnitId) {
    throw new BadRequestException('rentalUnitId é obrigatório quando scope = UNIT.');
  }
  if (shape.scope === 'STORE_WIDE' && shape.rentalUnitId) {
    throw new BadRequestException('rentalUnitId não deve ser informado quando scope = STORE_WIDE.');
  }
  if (!isStrictIsoDate(shape.startDate) || !isStrictIsoDate(shape.endDate)) {
    throw new BadRequestException('Datas precisam existir no calendário (YYYY-MM-DD).');
  }
  if (isBefore(civilDateFromISO(shape.endDate), civilDateFromISO(shape.startDate))) {
    throw new BadRequestException('endDate não pode ser anterior a startDate.');
  }
  return shape;
}

function shapeOf(row: OperationalBlock): BlockShape {
  return {
    scope: row.scope,
    rentalUnitId: row.rentalUnitId,
    startDate: civilDateToISO(civilDateFromPgDate(row.startDate)),
    endDate: civilDateToISO(civilDateFromPgDate(row.endDate)),
    reason: row.reason,
  };
}

async function lockBlockRow(tx: Prisma.TransactionClient, id: string): Promise<OperationalBlock> {
  await tx.$executeRaw`SELECT 1 FROM operational_blocks WHERE id = ${id}::uuid FOR UPDATE`;
  const row = await tx.operationalBlock.findUnique({ where: { id } });
  if (!row) throw new NotFoundException('Bloqueio não encontrado.');
  return row;
}

async function assertUnitExists(tx: Prisma.TransactionClient, rentalUnitId: string | null): Promise<void> {
  if (!rentalUnitId) return;
  const unit = await tx.rentalUnit.findUnique({ where: { id: rentalUnitId }, select: { id: true } });
  if (!unit) throw new NotFoundException('RentalUnit não encontrada.');
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
