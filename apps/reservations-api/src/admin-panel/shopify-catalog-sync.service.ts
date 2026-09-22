import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import { OCCUPYING_RESERVATION_STATUSES } from '../reservation-status';
import { ShopifyAdminClient } from './shopify-admin.client';

export type CatalogDivergenceKind = 'variant_missing' | 'variant_restored';
export type CatalogDivergenceAction = 'deactivate' | 'reactivate';

export interface CatalogDivergence {
  readonly kind: CatalogDivergenceKind;
  readonly rentalUnitId: string;
  readonly code: string;
  readonly name: string;
  readonly shopifyVariantId: string;
  readonly action: CatalogDivergenceAction;
  readonly applied: boolean;
  readonly upcomingReservations: number;
  readonly note: string;
}

export interface CatalogSyncReport {
  readonly generatedAt: string;
  readonly mode: 'report' | 'apply';
  readonly totalRentalUnitsLinked: number;
  readonly totalShopifyVariants: number;
  readonly lastSyncedAt: string | null;
  readonly lastSyncedByName: string | null;
  readonly divergences: readonly CatalogDivergence[];
}

interface LinkedUnit {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly active: boolean;
  readonly shopifyVariantId: string | null;
  readonly shopifyVariantMissingAt: Date | null;
}

/**
 * Sincroniza o catálogo Shopify (fonte de verdade de produto/variante) com
 * as peças físicas (RentalUnit). Nunca cria pedido/pagamento/reserva/HOLD;
 * só lê a Admin API e escreve `active`/`shopifyVariantMissingAt` da peça,
 * sempre por transição condicional (nunca reescreve algo que já mudou por
 * fora, nunca sobrepõe uma decisão manual — ver applyDeactivate/applyReactivate).
 *
 * `reconcile({apply:false})` é o relatório somente-leitura; `{apply:true}`
 * aplica o subconjunto de ações seguras, uma peça por vez, cada uma na sua
 * própria transação com lock por peça (mesmo padrão de
 * ShopifyReconciliationService.applyOne — uma falha isolada não derruba as
 * demais). Idempotente: rodar de novo sem nada ter mudado não gera evento
 * nem toca nenhuma linha (todo UPDATE é condicional no estado atual).
 */
@Injectable()
export class ShopifyCatalogSyncService {
  private readonly logger = new Logger(ShopifyCatalogSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopify: ShopifyAdminClient,
  ) {}

  async reconcile(options: { apply: boolean; actor?: { id: string; name: string }; rentalUnitIds?: readonly string[] }): Promise<CatalogSyncReport> {
    const variants = await this.shopify.listVariants();
    const units = await this.prisma.rentalUnit.findMany({
      // `rentalUnitIds` existe só para os testes de integração escoparem a
      // varredura às peças da própria fixture (mesmo motivo de `orderIds`
      // em ShopifyReconciliationService) — o painel/produção sempre chama
      // sem isso, e sincroniza a tabela inteira.
      where: { shopifyVariantId: { not: null }, ...(options.rentalUnitIds ? { id: { in: [...options.rentalUnitIds] } } : {}) },
      select: { id: true, code: true, name: true, active: true, shopifyVariantId: true, shopifyVariantMissingAt: true },
      orderBy: { code: 'asc' },
    });

    // Fail closed: Admin API respondendo vazio (bug/instabilidade), com
    // peças vinculadas no banco, NUNCA pode ser lido como "todas as
    // variantes sumiram" — isso desativaria o catálogo físico inteiro por
    // uma falha transitória. Um catálogo genuinamente vazio na Shopify com
    // peças já cadastradas aqui é, na prática, o mesmo sinal de alerta.
    if (variants.length === 0 && units.length > 0) {
      this.logger.error('Shopify retornou 0 variantes com peças físicas vinculadas — sincronização abortada por segurança.');
      throw new ServiceUnavailableException('A Shopify não retornou nenhuma variante; sincronização abortada por segurança.');
    }

    const liveVariantIds = new Set(variants.map((v) => v.id));
    const divergent: { unit: LinkedUnit; kind: CatalogDivergenceKind; action: CatalogDivergenceAction }[] = [];
    for (const unit of units as LinkedUnit[]) {
      const variantId = unit.shopifyVariantId;
      if (!variantId) continue;
      const live = liveVariantIds.has(variantId);
      if (!live && unit.active) {
        divergent.push({ unit, kind: 'variant_missing', action: 'deactivate' });
      } else if (live && !unit.active && unit.shopifyVariantMissingAt) {
        // Só reativa o que a PRÓPRIA sincronização desativou (marcador
        // presente). Peça inativa por decisão manual (marcador ausente)
        // nunca é tocada aqui — item 5: "não altere reservas existentes
        // nem cancele automaticamente" se estende ao mesmo espírito para
        // decisões humanas sobre a peça.
        divergent.push({ unit, kind: 'variant_restored', action: 'reactivate' });
      }
    }

    const missingIds = divergent.filter((d) => d.kind === 'variant_missing').map((d) => d.unit.id);
    const upcomingByUnit = missingIds.length > 0 ? await this.upcomingReservationCounts(missingIds) : new Map<string, number>();

    const divergences: CatalogDivergence[] = divergent.map(({ unit, kind, action }) => ({
      kind,
      rentalUnitId: unit.id,
      code: unit.code,
      name: unit.name,
      shopifyVariantId: unit.shopifyVariantId as string,
      action,
      applied: false,
      upcomingReservations: kind === 'variant_missing' ? (upcomingByUnit.get(unit.id) ?? 0) : 0,
      note:
        kind === 'variant_missing'
          ? 'Variante removida da Shopify — peça desativada, indisponível para novas reservas e para disponibilidade online até reativação.'
          : 'Variante voltou a existir na Shopify — peça pode ser reativada com segurança, sem duplicar cadastro.',
    }));

    const state = await this.prisma.catalogSyncState.findUnique({ where: { id: 'default' } });

    if (options.apply) {
      let deactivated = 0;
      let reactivated = 0;
      for (let i = 0; i < divergences.length; i++) {
        const d = divergences[i];
        const applied = d.action === 'deactivate' ? await this.applyDeactivate(d, options.actor) : await this.applyReactivate(d, options.actor);
        if (applied) {
          divergences[i] = { ...d, applied: true };
          if (d.action === 'deactivate') deactivated++;
          else reactivated++;
        }
      }
      await this.prisma.catalogSyncState.upsert({
        where: { id: 'default' },
        create: {
          id: 'default',
          lastSyncedAt: new Date(),
          lastSyncedBy: options.actor?.id ?? null,
          lastSyncedByName: options.actor?.name ?? null,
          checkedVariants: variants.length,
          deactivatedCount: deactivated,
          reactivatedCount: reactivated,
        },
        update: {
          lastSyncedAt: new Date(),
          lastSyncedBy: options.actor?.id ?? null,
          lastSyncedByName: options.actor?.name ?? null,
          checkedVariants: variants.length,
          deactivatedCount: deactivated,
          reactivatedCount: reactivated,
        },
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      mode: options.apply ? 'apply' : 'report',
      totalRentalUnitsLinked: units.length,
      totalShopifyVariants: variants.length,
      lastSyncedAt: options.apply ? new Date().toISOString() : (state?.lastSyncedAt.toISOString() ?? null),
      lastSyncedByName: options.apply ? (options.actor?.name ?? null) : (state?.lastSyncedByName ?? null),
      divergences,
    };
  }

  private async upcomingReservationCounts(unitIds: readonly string[]): Promise<Map<string, number>> {
    const rows = await this.prisma.$queryRaw<{ unitId: string; n: number }[]>`
      SELECT rental_unit_id AS "unitId", count(DISTINCT reservation_id)::int AS "n"
      FROM reservation_items
      WHERE rental_unit_id = ANY(${unitIds}::uuid[])
        AND status = ANY(${OCCUPYING_RESERVATION_STATUSES}::"reservation_status"[])
        AND lower(blocked_range) > (now() AT TIME ZONE (SELECT timezone FROM rental_rule_config WHERE id = 'default'))::date
      GROUP BY rental_unit_id
    `;
    return new Map(rows.map((r) => [r.unitId, r.n]));
  }

  /** Peça ativa cuja variante sumiu → inativa. Condicional em `active=true`
   *  E no mesmo `shopifyVariantId` já lido (evita corrida com um PATCH
   *  manual concorrente que já mudou o vínculo). Idempotente: rodar de novo
   *  encontra `active=false` e não bate mais no WHERE — sem efeito, sem
   *  evento repetido. */
  private async applyDeactivate(d: CatalogDivergence, actor?: { id: string; name: string }): Promise<boolean> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'rental-unit:' + d.rentalUnitId}))`;
          const updated = await tx.rentalUnit.updateMany({
            where: { id: d.rentalUnitId, active: true, shopifyVariantId: d.shopifyVariantId },
            data: { active: false, shopifyVariantMissingAt: new Date() },
          });
          if (updated.count !== 1) return false;

          await writeAdminAuditEvent(tx, {
            adminUserId: actor?.id ?? null,
            adminUserName: actor?.name ?? 'Sistema (sincronização de catálogo)',
            action: 'CATALOG_UNIT_DEACTIVATED',
            entityType: 'RentalUnit',
            entityId: d.rentalUnitId,
            before: { active: true },
            after: { active: false },
            detail: { origin: 'shopify_catalog_sync', reason: 'shopify_variant_missing', code: d.code, shopifyVariantId: d.shopifyVariantId },
          });

          // Item 6: reserva futura com esta peça vira alerta, sem apagar
          // nada. Idempotente por checagem explícita (não só pela
          // transição de `active`, pra sobreviver a qualquer reprocesso).
          const upcoming = await tx.$queryRaw<{ id: string }[]>`
            SELECT DISTINCT reservation_id AS id FROM reservation_items
            WHERE rental_unit_id = ${d.rentalUnitId}::uuid
              AND status = ANY(${OCCUPYING_RESERVATION_STATUSES}::"reservation_status"[])
              AND lower(blocked_range) > (now() AT TIME ZONE (SELECT timezone FROM rental_rule_config WHERE id = 'default'))::date
          `;
          for (const { id: reservationId } of upcoming) {
            const [existing] = await tx.$queryRaw<{ id: string }[]>`
              SELECT id FROM reservation_events
              WHERE reservation_id = ${reservationId}::uuid
                AND type = 'SHOPIFY_CATALOG_UNIT_MISSING_RESERVATION_ALERT'
                AND detail ->> 'rentalUnitId' = ${d.rentalUnitId}
              LIMIT 1
            `;
            if (existing) continue;
            await tx.reservationEvent.create({
              data: {
                reservationId,
                type: 'SHOPIFY_CATALOG_UNIT_MISSING_RESERVATION_ALERT',
                detail: {
                  origin: 'shopify_catalog_sync',
                  rentalUnitId: d.rentalUnitId,
                  code: d.code,
                  shopifyVariantId: d.shopifyVariantId,
                  note: 'Peça desta reserva futura teve a variante removida da Shopify. A reserva NÃO foi alterada ou cancelada — requer revisão manual.',
                },
              },
            });
          }
          return true;
        },
        { timeout: 15_000, maxWait: 5_000 },
      );
    } catch (err) {
      this.logger.error(`Falha ao desativar peça ${d.rentalUnitId} na sincronização de catálogo: ${errorCode(err)}`);
      return false;
    }
  }

  /** Só reativa o que a PRÓPRIA sincronização desativou (`shopifyVariantMissingAt`
   *  presente) e cujo `shopifyVariantId` ainda é o mesmo. Se um humano já
   *  reativou manualmente (PATCH limpa o marcador) ou desativou por outro
   *  motivo depois, este UPDATE simplesmente não encontra a linha — no-op. */
  private async applyReactivate(d: CatalogDivergence, actor?: { id: string; name: string }): Promise<boolean> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'rental-unit:' + d.rentalUnitId}))`;
          const updated = await tx.rentalUnit.updateMany({
            where: { id: d.rentalUnitId, active: false, shopifyVariantMissingAt: { not: null }, shopifyVariantId: d.shopifyVariantId },
            data: { active: true, shopifyVariantMissingAt: null },
          });
          if (updated.count !== 1) return false;

          await writeAdminAuditEvent(tx, {
            adminUserId: actor?.id ?? null,
            adminUserName: actor?.name ?? 'Sistema (sincronização de catálogo)',
            action: 'CATALOG_UNIT_REACTIVATED',
            entityType: 'RentalUnit',
            entityId: d.rentalUnitId,
            before: { active: false },
            after: { active: true },
            detail: { origin: 'shopify_catalog_sync', reason: 'shopify_variant_restored', code: d.code, shopifyVariantId: d.shopifyVariantId },
          });
          return true;
        },
        { timeout: 15_000, maxWait: 5_000 },
      );
    } catch (err) {
      this.logger.error(`Falha ao reativar peça ${d.rentalUnitId} na sincronização de catálogo: ${errorCode(err)}`);
      return false;
    }
  }
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
