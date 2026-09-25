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
  /// Presente = esta peça foi desativada pela sincronização de catálogo
  /// (ShopifyCatalogSyncService), não por uma decisão manual — a variante
  /// vinculada não existe mais na Shopify no momento da última checagem.
  readonly shopifyVariantMissingAt: string | null;
}

export interface UpdatePieceInput {
  readonly active?: boolean;
  readonly reservableOnline?: boolean;
  readonly countsTowardRentalDuration?: boolean;
  readonly reason?: string;
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
          ru.shopify_variant_missing_at AS "shopifyVariantMissingAt",
          EXISTS (
            SELECT 1 FROM reservation_items ri
            WHERE ri.rental_unit_id = ru.id
              AND ri.status = ANY(${OCCUPYING_RESERVATION_STATUSES}::"reservation_status"[])
              AND (
                ri.blocked_range @> (now() AT TIME ZONE (SELECT timezone FROM rental_rule_config WHERE id = 'default'))::date
                OR ri.status IN ('returned', 'cleaning')
              )
          ) AS "currentlyOccupied",
          (
            SELECT count(*)::int FROM reservation_items ri
            WHERE ri.rental_unit_id = ru.id
              AND ri.status = ANY(${OCCUPYING_RESERVATION_STATUSES}::"reservation_status"[])
              AND lower(ri.blocked_range) > (now() AT TIME ZONE (SELECT timezone FROM rental_rule_config WHERE id = 'default'))::date
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

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM rental_units WHERE id = ${id}::uuid FOR UPDATE`;
        const before = await tx.rentalUnit.findUnique({ where: { id } });
        if (!before) throw new NotFoundException('Peça não encontrada.');
        const after = await tx.rentalUnit.update({
          where: { id },
          data: {
            active: input.active,
            reservableOnline: input.reservableOnline,
            countsTowardRentalDuration: input.countsTowardRentalDuration,
            // Reativação MANUAL: o humano está tomando a responsabilidade
            // agora, então o marcador da sincronização (que só faz sentido
            // enquanto NINGUÉM decidiu nada) deixa de valer. Se a variante
            // ainda estiver mesmo ausente na Shopify, a próxima sincronização
            // detecta de novo e desativa de novo — autocorretivo, sem
            // precisar bloquear o PATCH aqui.
            ...(input.active === true ? { shopifyVariantMissingAt: null } : {}),
          },
        });
        await writeAdminAuditEvent(tx, {
          adminUserId, adminUserName,
          action: after.active !== before.active ? (after.active ? 'UNIT_ACTIVATED' : 'UNIT_DEACTIVATED') : 'UNIT_UPDATED',
          entityType: 'RentalUnit', entityId: id,
          before: { active: before.active, reservableOnline: before.reservableOnline, countsTowardRentalDuration: before.countsTowardRentalDuration },
          after: { active: after.active, reservableOnline: after.reservableOnline, countsTowardRentalDuration: after.countsTowardRentalDuration },
          detail: input.active === false && input.reason ? { origin: 'closetadmin', reason: input.reason } : undefined,
        });
      });
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      this.logger.error(`Falha ao atualizar peça ${id}: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível atualizar a peça no momento.');
    }

    const [item] = await this.prisma.$queryRaw<PieceListItem[]>`
      SELECT
        ru.id, ru.code, ru.name, ru.shopify_product_id AS "shopifyProductId",
        ru.shopify_variant_id AS "shopifyVariantId", ru.shopify_sku AS "shopifySku",
        ru.active, ru.reservable_online AS "reservableOnline", ru.counts_toward_rental_duration AS "countsTowardRentalDuration",
        ru.shopify_variant_missing_at AS "shopifyVariantMissingAt",
        EXISTS (
          SELECT 1 FROM reservation_items ri
          WHERE ri.rental_unit_id = ru.id
            AND ri.status = ANY(${OCCUPYING_RESERVATION_STATUSES}::"reservation_status"[])
            AND (
              ri.blocked_range @> (now() AT TIME ZONE (SELECT timezone FROM rental_rule_config WHERE id = 'default'))::date
              OR ri.status IN ('returned', 'cleaning')
            )
        ) AS "currentlyOccupied",
        (
          SELECT count(*)::int FROM reservation_items ri
          WHERE ri.rental_unit_id = ru.id
            AND ri.status = ANY(${OCCUPYING_RESERVATION_STATUSES}::"reservation_status"[])
            AND lower(ri.blocked_range) > (now() AT TIME ZONE (SELECT timezone FROM rental_rule_config WHERE id = 'default'))::date
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
