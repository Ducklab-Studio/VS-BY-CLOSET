import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import { OCCUPYING_RESERVATION_STATUSES } from '../reservation-status';

export interface PieceListItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly shopifyProductId: string | null;
  readonly shopifyVariantId: string | null;
  readonly shopifySku: string | null;
  readonly active: boolean;
  readonly reservableOnline: boolean;
  readonly countsTowardRentalDuration: boolean;
  readonly currentlyOccupied: boolean;
  readonly upcomingReservations: number;
}

export interface UpdatePieceInput {
  readonly active?: boolean;
  readonly reservableOnline?: boolean;
  readonly countsTowardRentalDuration?: boolean;
}

/**
 * Fase 9, item 11 — /closetadmin/pecas. Só campos OPERACIONAIS
 * (active/reservableOnline/countsTowardRentalDuration) — nome, preço,
 * foto, descrição, variante comercial continuam sendo do Shopify, nunca
 * editados aqui (item 11: "não recriar editor de nome do produto/preço/
 * fotos/descrição").
 */
@Injectable()
export class AdminPiecesService {
  private readonly logger = new Logger(AdminPiecesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<PieceListItem[]> {
    try {
      return await this.prisma.$queryRaw<PieceListItem[]>`
        SELECT
          ru.id, ru.code, ru.name, ru.shopify_product_id AS "shopifyProductId",
          ru.shopify_variant_id AS "shopifyVariantId", ru.shopify_sku AS "shopifySku",
          ru.active, ru.reservable_online AS "reservableOnline", ru.counts_toward_rental_duration AS "countsTowardRentalDuration",
          EXISTS (
            SELECT 1 FROM reservation_items ri
            WHERE ri.rental_unit_id = ru.id
              AND ri.status = ANY(${OCCUPYING_RESERVATION_STATUSES}::"reservation_status"[])
              AND ri.blocked_range @> CURRENT_DATE
          ) AS "currentlyOccupied",
          (
            SELECT count(*)::int FROM reservation_items ri
            WHERE ri.rental_unit_id = ru.id
              AND ri.status = ANY(${OCCUPYING_RESERVATION_STATUSES}::"reservation_status"[])
              AND lower(ri.blocked_range) > CURRENT_DATE
          ) AS "upcomingReservations"
        FROM rental_units ru
        ORDER BY ru.code
      `;
    } catch (err) {
      this.logger.error(`Falha ao listar peças: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível listar as peças no momento.');
    }
  }

  async update(id: string, input: UpdatePieceInput, adminUserId: string, adminUserName: string): Promise<PieceListItem> {
    if (Object.keys(input).length === 0) {
      throw new BadRequestException('Nenhum campo pra atualizar.');
    }

    const before = await this.prisma.rentalUnit.findUnique({ where: { id } });
    if (!before) {
      throw new NotFoundException('Peça não encontrada.');
    }

    let after;
    try {
      after = await this.prisma.rentalUnit.update({ where: { id }, data: input });
    } catch (err) {
      this.logger.error(`Falha ao atualizar peça ${id}: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível atualizar a peça no momento.');
    }

    await writeAdminAuditEvent(this.prisma, {
      adminUserId,
      adminUserName,
      action: after.active !== before.active ? (after.active ? 'UNIT_ACTIVATED' : 'UNIT_DEACTIVATED') : 'UNIT_UPDATED',
      entityType: 'RentalUnit',
      entityId: id,
      before: { active: before.active, reservableOnline: before.reservableOnline, countsTowardRentalDuration: before.countsTowardRentalDuration },
      after: { active: after.active, reservableOnline: after.reservableOnline, countsTowardRentalDuration: after.countsTowardRentalDuration },
    });

    const [item] = await this.prisma.$queryRaw<PieceListItem[]>`
      SELECT
        ru.id, ru.code, ru.name, ru.shopify_product_id AS "shopifyProductId",
        ru.shopify_variant_id AS "shopifyVariantId", ru.shopify_sku AS "shopifySku",
        ru.active, ru.reservable_online AS "reservableOnline", ru.counts_toward_rental_duration AS "countsTowardRentalDuration",
        EXISTS (
          SELECT 1 FROM reservation_items ri
          WHERE ri.rental_unit_id = ru.id
            AND ri.status = ANY(${OCCUPYING_RESERVATION_STATUSES}::"reservation_status"[])
            AND ri.blocked_range @> CURRENT_DATE
        ) AS "currentlyOccupied",
        (
          SELECT count(*)::int FROM reservation_items ri
          WHERE ri.rental_unit_id = ru.id
            AND ri.status = ANY(${OCCUPYING_RESERVATION_STATUSES}::"reservation_status"[])
            AND lower(ri.blocked_range) > CURRENT_DATE
        ) AS "upcomingReservations"
      FROM rental_units ru WHERE ru.id = ${id}::uuid
    `;
    return item;
  }
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
