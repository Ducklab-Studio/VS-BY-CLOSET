import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import { civilDateFromISO, civilDateToISO, isBefore } from '../rental-rules/civil-date';
import type { CreateBlockDto } from './dto/create-block.dto';

export interface BlockItem {
  readonly id: string;
  readonly scope: 'STORE_WIDE' | 'UNIT';
  readonly rentalUnitId: string | null;
  readonly rentalUnitCode: string | null;
  readonly startDate: string;
  readonly endDate: string;
  readonly reason: string;
  readonly createdByAdminUserId: string;
  readonly createdAt: string;
  readonly removedAt: string | null;
}

/**
 * Fase 9, item 13 — /closetadmin/regras (bloqueios). Bloqueio real,
 * lido diretamente por AvailabilityService/HoldsService/
 * AdminReservationsService (ver ../admin/operational-blocks.ts) —
 * nunca só visual. Nunca há override (mesmo princípio de double
 * booking): é realidade operacional, não regra de negócio soft.
 */
@Injectable()
export class AdminBlocksService {
  private readonly logger = new Logger(AdminBlocksService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(activeOnly: boolean): Promise<BlockItem[]> {
    try {
      return await this.prisma.$queryRaw<BlockItem[]>`
        SELECT
          b.id, b.scope, b.rental_unit_id AS "rentalUnitId", ru.code AS "rentalUnitCode",
          b.start_date::text AS "startDate", b.end_date::text AS "endDate", b.reason,
          b.created_by_admin_user_id AS "createdByAdminUserId", b.created_at::text AS "createdAt", b.removed_at::text AS "removedAt"
        FROM operational_blocks b
        LEFT JOIN rental_units ru ON ru.id = b.rental_unit_id
        WHERE ${activeOnly} = false OR b.removed_at IS NULL
        ORDER BY b.created_at DESC
      `;
    } catch (err) {
      this.logger.error(`Falha ao listar bloqueios: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível listar os bloqueios no momento.');
    }
  }

  async create(dto: CreateBlockDto, adminUserId: string, adminUserName: string): Promise<BlockItem> {
    if (dto.scope === 'UNIT' && !dto.rentalUnitId) {
      throw new BadRequestException('rentalUnitId é obrigatório quando scope = UNIT.');
    }
    if (dto.scope === 'STORE_WIDE' && dto.rentalUnitId) {
      throw new BadRequestException('rentalUnitId não deve ser informado quando scope = STORE_WIDE.');
    }

    const start = civilDateFromISO(dto.startDate);
    const end = civilDateFromISO(dto.endDate);
    if (isBefore(end, start)) {
      throw new BadRequestException('endDate não pode ser anterior a startDate.');
    }

    if (dto.rentalUnitId) {
      const unit = await this.prisma.rentalUnit.findUnique({ where: { id: dto.rentalUnitId } });
      if (!unit) throw new NotFoundException('RentalUnit não encontrada.');
    }

    let created;
    try {
      created = await this.prisma.operationalBlock.create({
        data: {
          scope: dto.scope,
          rentalUnitId: dto.rentalUnitId ?? null,
          // `@db.Date` — Prisma Client exige um `Date` JS mesmo pra coluna
          // DATE pura (achado real: uma string ISO aqui lança
          // PrismaClientValidationError).
          startDate: new Date(civilDateToISO(start)),
          endDate: new Date(civilDateToISO(end)),
          reason: dto.reason,
          createdByAdminUserId: adminUserId,
        },
      });
    } catch (err) {
      this.logger.error(`Falha ao criar bloqueio: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível criar o bloqueio no momento.');
    }

    await writeAdminAuditEvent(this.prisma, {
      adminUserId,
      adminUserName,
      action: 'BLOCK_CREATED',
      entityType: 'OperationalBlock',
      entityId: created.id,
      after: { scope: created.scope, rentalUnitId: created.rentalUnitId, startDate: dto.startDate, endDate: dto.endDate, reason: dto.reason },
    });

    return this.toItem(created.id);
  }

  async remove(id: string, adminUserId: string, adminUserName: string): Promise<BlockItem> {
    const block = await this.prisma.operationalBlock.findUnique({ where: { id } });
    if (!block) throw new NotFoundException('Bloqueio não encontrado.');
    if (block.removedAt) {
      throw new ConflictException('Este bloqueio já foi levantado.');
    }

    try {
      await this.prisma.operationalBlock.update({ where: { id }, data: { removedAt: new Date() } });
    } catch (err) {
      this.logger.error(`Falha ao remover bloqueio ${id}: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível remover o bloqueio no momento.');
    }

    await writeAdminAuditEvent(this.prisma, {
      adminUserId,
      adminUserName,
      action: 'BLOCK_REMOVED',
      entityType: 'OperationalBlock',
      entityId: id,
      before: { removedAt: null },
      after: { removedAt: new Date().toISOString() },
    });

    return this.toItem(id);
  }

  private async toItem(id: string): Promise<BlockItem> {
    const [item] = await this.prisma.$queryRaw<BlockItem[]>`
      SELECT
        b.id, b.scope, b.rental_unit_id AS "rentalUnitId", ru.code AS "rentalUnitCode",
        b.start_date::text AS "startDate", b.end_date::text AS "endDate", b.reason,
        b.created_by_admin_user_id AS "createdByAdminUserId", b.created_at::text AS "createdAt", b.removed_at::text AS "removedAt"
      FROM operational_blocks b
      LEFT JOIN rental_units ru ON ru.id = b.rental_unit_id
      WHERE b.id = ${id}::uuid
    `;
    return item;
  }
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
