import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import { OCCUPYING_RESERVATION_STATUSES } from '../reservation-status';
import { ShopifyAdminClient, type ShopifyCatalogVariant } from './shopify-admin.client';

export type CatalogDivergenceKind = 'variant_missing' | 'product_inactive' | 'variant_restored' | 'sku_changed' | 'variant_deleted_inactive';
export type CatalogDivergenceAction = 'deactivate' | 'reactivate' | 'sync_sku' | 'archive';

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
  /** Status do produto na Shopify quando a variante ainda existe (DRAFT,
   *  ARCHIVED…); `null` quando a variante sumiu de vez. */
  readonly shopifyProductStatus: string | null;
  /** Só em `sku_changed`: SKU gravado na peça e SKU atual da variante na
   *  Shopify (`null` = sem SKU / SKU removido). */
  readonly previousSku?: string | null;
  readonly shopifySku?: string | null;
  /** Só em `sku_changed`: código da peça antes/depois. O código acompanha o
   *  SKU quando a variante tem uma única peça física (ver reconcile). */
  readonly previousCode?: string;
  readonly newCode?: string;
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
  readonly shopifySku: string | null;
}

/** SKU vazio ou só com espaços vale o mesmo que "sem SKU" (mesma regra do
 *  ShopifyAdminClient ao ler a variante). */
function normalizeSku(sku: string | null | undefined): string | null {
  return sku?.trim() || null;
}

function isLiveShopifyVariant(variant: { id: string; product: { status: string } }): boolean {
  return variant.product.status.trim().toUpperCase() === 'ACTIVE';
}

/**
 * Sincroniza o catálogo Shopify (fonte de verdade de produto/variante) com
 * as peças físicas (RentalUnit). Nunca cria pedido/pagamento/reserva/HOLD;
 * só lê a Admin API e escreve `active`/`shopifyVariantMissingAt`/SKU da peça,
 * sempre por transição condicional (nunca reescreve algo que já mudou por
 * fora, nunca sobrepõe uma decisão manual — ver applyDeactivate/applyReactivate).
 *
 * `reconcile({apply:false})` é o relatório somente-leitura; `{apply:true}`
 * aplica o subconjunto de ações seguras, uma peça por vez, cada uma na sua
 * própria transação com lock por peça (mesmo padrão de
 * ShopifyReconciliationService.applyOne — uma falha isolada não derruba as
 * demais). Idempotente: rodar de novo sem nada ter mudado não gera evento
 * nem toca nenhuma linha (todo UPDATE é condicional no estado atual).
 *
 * Arquivamento lógico: variante removida, produto DRAFT/ARCHIVED (qualquer
 * status diferente de ACTIVE) ou produto sem variante → a peça fica
 * `active=false`, com `shopifyVariantMissingAt` preenchido (o marcador de
 * "arquivada pela sincronização" — sai da lista principal de Peças físicas)
 * e SKU desvinculado. Nunca DELETE: reservas, bloqueios e auditoria
 * continuam apontando para a mesma linha, e a mesma variante voltando
 * ACTIVE reativa a MESMA peça, com SKU e produto relidos da Shopify.
 */
@Injectable()
export class ShopifyCatalogSyncService {
  private readonly logger = new Logger(ShopifyCatalogSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopify: ShopifyAdminClient,
  ) {}

  async reconcile(options: { apply: boolean; actor?: { id: string; name: string }; rentalUnitIds?: readonly string[]; shopifyProductId?: string }): Promise<CatalogSyncReport> {
    const variants = await this.shopify.listVariants();
    const productIds = options.shopifyProductId
      ? [options.shopifyProductId, `gid://shopify/Product/${options.shopifyProductId.replace(/\D/g, '')}`]
      : undefined;
    const units = await this.prisma.rentalUnit.findMany({
      // `rentalUnitIds` existe só para os testes de integração escoparem a
      // varredura às peças da própria fixture (mesmo motivo de `orderIds`
      // em ShopifyReconciliationService) — o painel/produção sempre chama
      // sem isso, e sincroniza a tabela inteira.
      where: {
        shopifyVariantId: { not: null },
        ...(options.rentalUnitIds ? { id: { in: [...options.rentalUnitIds] } } : {}),
        ...(productIds ? { shopifyProductId: { in: productIds } } : {}),
      },
      select: { id: true, code: true, name: true, active: true, shopifyVariantId: true, shopifyVariantMissingAt: true, shopifySku: true },
      orderBy: { code: 'asc' },
    });

    // Fail closed: Admin API respondendo vazio (bug/instabilidade), com
    // peças vinculadas no banco, NUNCA pode ser lido como "todas as
    // variantes sumiram" — isso desativaria o catálogo físico inteiro por
    // uma falha transitória. Um catálogo genuinamente vazio na Shopify com
    // peças já cadastradas aqui é, na prática, o mesmo sinal de alerta.
    // Vale também para o webhook (escopo de um produto): antes, com
    // `shopifyProductId`, uma resposta vazia desativava as peças daquele
    // produto — agora conta qualquer peça ativa vinculada no banco.
    if (variants.length === 0 && (units.length > 0 || (await this.hasActiveLinkedUnits()))) {
      this.logger.error('Shopify retornou 0 variantes com peças físicas vinculadas — sincronização abortada por segurança.');
      throw new ServiceUnavailableException('A Shopify não retornou nenhuma variante; sincronização abortada por segurança.');
    }

    const variantById = new Map(variants.map((v) => [v.id, v]));
    const liveVariantIds = new Set(variants.filter(isLiveShopifyVariant).map((v) => v.id));
    const inactiveVariantIds = new Set(variants.filter((v) => !isLiveShopifyVariant(v)).map((v) => v.id));
    const divergent: { unit: LinkedUnit; kind: CatalogDivergenceKind; action: CatalogDivergenceAction; codeTarget?: string; releaseFrom?: string }[] = [];
    // O código da peça é o SKU da variante — mas só quando a variante tem UMA
    // peça física (não arquivada): com várias peças no mesmo SKU (ex.: dois
    // sobretudos iguais), os códigos precisam continuar distintos e ficam
    // como foram cadastrados.
    const singleUnitVariants = await this.singleUnitVariantIds(units.map((u) => u.shopifyVariantId).filter((v): v is string => !!v));
    for (const unit of units as LinkedUnit[]) {
      const variantId = unit.shopifyVariantId;
      if (!variantId) continue;
      const live = liveVariantIds.has(variantId);
      if (!live && unit.active) {
        divergent.push({
          unit,
          kind: inactiveVariantIds.has(variantId) ? 'product_inactive' : 'variant_missing',
          action: 'deactivate',
        });
      } else if (live && !unit.active && unit.shopifyVariantMissingAt) {
        // Só reativa o que a PRÓPRIA sincronização desativou (marcador
        // presente). Peça inativa por decisão manual (marcador ausente)
        // nunca é tocada aqui — item 5: "não altere reservas existentes
        // nem cancele automaticamente" se estende ao mesmo espírito para
        // decisões humanas sobre a peça.
        divergent.push({ unit, kind: 'variant_restored', action: 'reactivate' });
      } else if (!unit.active && !unit.shopifyVariantMissingAt && !variantById.has(variantId)) {
        // Peça desativada à mão cuja variante sumiu da Shopify. Só é arquivada
        // se a Shopify CONFIRMAR a exclusão (ver applyArchiveInactive): id de
        // variante excluída nunca volta, então o marcador nunca leva a uma
        // reativação automática que atropele a decisão humana.
        divergent.push({ unit, kind: 'variant_deleted_inactive', action: 'archive' });
      } else if (!unit.shopifyVariantMissingAt) {
        // SKU: a Shopify é a fonte e o vínculo é SEMPRE o `shopifyVariantId`
        // (o SKU vem da variante lida na Admin API, nunca de payload de
        // webhook). Só vale para peça não arquivada pela sincronização —
        // arquivada fica com SKU desvinculado de propósito, e a reativação
        // já relê o SKU. Peça inativa por decisão manual também acompanha
        // o SKU (só o dado comercial; `active` não é tocado).
        const shopifyVariant = variantById.get(variantId);
        if (shopifyVariant) {
          const skuDiffers = normalizeSku(unit.shopifySku) !== shopifyVariant.sku;
          // SKU removido/vazio nunca vira código (a peça não pode ficar sem código).
          const codeTarget = shopifyVariant.sku && singleUnitVariants.has(variantId) ? shopifyVariant.sku : undefined;
          if (skuDiffers || (codeTarget && unit.code !== codeTarget)) {
            divergent.push({ unit, kind: 'sku_changed', action: 'sync_sku', codeTarget });
          }
        }
      }
    }

    // Código já usado por OUTRA peça (o código é único). Se quem ocupa é uma
    // peça ARQUIVADA pela sincronização (fora de operação, só histórico), ela
    // libera o código e passa a "<código>-ARQ" (applySkuSync). Peça ativa ou
    // desativada à mão nunca é renomeada: aí não troca — só o SKU é atualizado,
    // e se nem o SKU mudou, não há o que fazer.
    const wantedCodes = divergent.filter((d) => d.codeTarget && d.codeTarget !== d.unit.code).map((d) => d.codeTarget as string);
    if (wantedCodes.length > 0) {
      const taken = await this.prisma.rentalUnit.findMany({ where: { code: { in: wantedCodes } }, select: { id: true, code: true, shopifyVariantMissingAt: true } });
      const owner = new Map(taken.map((t) => [t.code, t]));
      for (let i = divergent.length - 1; i >= 0; i--) {
        const d = divergent[i];
        const holderRow = d.codeTarget ? owner.get(d.codeTarget) : undefined;
        const holder = holderRow?.id;
        if (holderRow && holder !== d.unit.id && holderRow.shopifyVariantMissingAt) {
          d.releaseFrom = holderRow.id;
          continue;
        }
        if (holder && holder !== d.unit.id) {
          this.logger.warn(`Código ${d.codeTarget} já é de outra peça — ${d.unit.code} mantém o código atual.`);
          d.codeTarget = undefined;
          if (normalizeSku(d.unit.shopifySku) === (variantById.get(d.unit.shopifyVariantId as string)?.sku ?? null)) divergent.splice(i, 1);
        }
      }
    }

    const missingIds = divergent.filter((d) => d.action === 'deactivate').map((d) => d.unit.id);
    const upcomingByUnit = missingIds.length > 0 ? await this.upcomingReservationCounts(missingIds) : new Map<string, number>();

    const divergences: CatalogDivergence[] = divergent.map(({ unit, kind, action, codeTarget, releaseFrom }) => {
      if (kind === 'variant_deleted_inactive') {
        return {
          kind,
          rentalUnitId: unit.id,
          code: unit.code,
          name: unit.name,
          shopifyVariantId: unit.shopifyVariantId as string,
          action,
          applied: false,
          upcomingReservations: 0,
          shopifyProductStatus: null,
          note: 'Peça já desativada e produto/variante excluído da Shopify — vai para Peças arquivadas (nada é apagado).',
        };
      }
      if (kind === 'sku_changed') {
        const previousSku = normalizeSku(unit.shopifySku);
        const shopifySku = variantById.get(unit.shopifyVariantId as string)?.sku ?? null;
        const newCode = codeTarget ?? unit.code;
        const codeNote =
          (newCode !== unit.code ? ` Código da peça ${unit.code} → ${newCode}.` : '') +
          (releaseFrom ? ` A peça arquivada que usava ${newCode} passa a ${newCode}-ARQ.` : '');
        return {
          kind,
          rentalUnitId: unit.id,
          code: unit.code,
          name: unit.name,
          shopifyVariantId: unit.shopifyVariantId as string,
          action,
          applied: false,
          upcomingReservations: 0,
          shopifyProductStatus: variantById.get(unit.shopifyVariantId as string)?.product.status ?? null,
          previousSku,
          shopifySku,
          previousCode: unit.code,
          newCode,
          note:
            (!shopifySku
              ? 'SKU removido na Shopify — peça segue vinculada pela variante, marcada como SKU ausente.'
              : previousSku === shopifySku
                ? 'Código da peça passa a ser o SKU da Shopify.'
                : previousSku
                  ? `SKU alterado na Shopify (${previousSku} → ${shopifySku}).`
                  : `SKU cadastrado na Shopify (${shopifySku}).`) + (previousSku === shopifySku ? ` (${unit.code} → ${newCode})` + (releaseFrom ? ` A peça arquivada que usava ${newCode} passa a ${newCode}-ARQ.` : '') : codeNote),
        };
      }
      return {
      kind,
      rentalUnitId: unit.id,
      code: unit.code,
      name: unit.name,
      shopifyVariantId: unit.shopifyVariantId as string,
      action,
      applied: false,
      upcomingReservations: action === 'deactivate' ? (upcomingByUnit.get(unit.id) ?? 0) : 0,
      shopifyProductStatus: variantById.get(unit.shopifyVariantId as string)?.product.status ?? null,
      note:
        kind === 'variant_missing'
          ? 'Variante removida da Shopify — peça desativada, indisponível para novas reservas e para disponibilidade online até reativação.'
          : kind === 'product_inactive'
            ? 'Produto arquivado ou inativo na Shopify — peça desativada, indisponível para novas reservas e para disponibilidade online até reativação.'
          : 'Variante voltou a existir na Shopify — peça pode ser reativada com segurança, sem duplicar cadastro.',
      };
    });

    const state = await this.prisma.catalogSyncState.findUnique({ where: { id: 'default' } });

    if (options.apply) {
      let deactivated = 0;
      let reactivated = 0;
      for (let i = 0; i < divergences.length; i++) {
        const d = divergences[i];
        const applied =
          d.action === 'deactivate'
            ? await this.applyDeactivate(d, options.actor)
            : d.action === 'sync_sku'
              ? await this.applySkuSync(d, divergent[i].unit.shopifySku, divergent[i].unit.code, options.actor, divergent[i].releaseFrom)
              : d.action === 'archive'
                ? await this.applyArchiveInactive(d, options.actor)
                : await this.applyReactivate(d, variantById.get(d.shopifyVariantId), options.actor);
        if (applied) {
          divergences[i] = { ...d, applied: true };
          if (d.action === 'deactivate') deactivated++;
          else if (d.action === 'reactivate') reactivated++;
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

  private async hasActiveLinkedUnits(): Promise<boolean> {
    return (await this.prisma.rentalUnit.count({ where: { active: true, shopifyVariantId: { not: null } } })) > 0;
  }

  /** Peça ARQUIVADA pela sincronização libera `code` para a peça ativa: passa
   *  a `<code>-ARQ` (ou `-ARQ-2`, `-ARQ-3`… se já existir). Condicional em
   *  "continua arquivada e com este código"; reservas e histórico apontam para
   *  a peça pelo id, então nada se perde. Auditado nas duas pontas. */
  private async releaseArchivedCode(
    tx: Prisma.TransactionClient,
    holderId: string,
    code: string,
    d: CatalogDivergence,
    actor?: { id: string; name: string },
  ): Promise<boolean> {
    let freed = `${code}-ARQ`;
    for (let n = 2; await tx.rentalUnit.findUnique({ where: { code: freed }, select: { id: true } }); n++) freed = `${code}-ARQ-${n}`;
    const moved = await tx.rentalUnit.updateMany({
      where: { id: holderId, code, shopifyVariantMissingAt: { not: null } },
      data: { code: freed },
    });
    if (moved.count !== 1) return false;
    await writeAdminAuditEvent(tx, {
      adminUserId: actor?.id ?? null,
      adminUserName: actor?.name ?? 'Sistema (sincronização de catálogo)',
      action: 'CATALOG_UNIT_CODE_RELEASED',
      entityType: 'RentalUnit',
      entityId: holderId,
      before: { code },
      after: { code: freed },
      detail: { origin: 'shopify_catalog_sync', reason: 'code_released_to_active_piece', code, takenBy: d.rentalUnitId, takenByCode: d.code },
    });
    return true;
  }

  /** Variantes com exatamente UMA peça física não arquivada. */
  private async singleUnitVariantIds(variantIds: readonly string[]): Promise<Set<string>> {
    if (variantIds.length === 0) return new Set();
    const rows = await this.prisma.rentalUnit.groupBy({
      by: ['shopifyVariantId'],
      where: { shopifyVariantId: { in: [...new Set(variantIds)] }, shopifyVariantMissingAt: null },
      _count: { _all: true },
    });
    return new Set(rows.filter((r) => r._count._all === 1 && r.shopifyVariantId).map((r) => r.shopifyVariantId as string));
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
          const current = await tx.rentalUnit.findUnique({ where: { id: d.rentalUnitId }, select: { shopifySku: true } });
          // SKU desvinculado: a variante não vale mais. O id da variante fica
          // (é por ele que a mesma peça é reencontrada se a variante voltar) e
          // o SKU anterior fica no `before` da auditoria.
          const updated = await tx.rentalUnit.updateMany({
            where: { id: d.rentalUnitId, active: true, shopifyVariantId: d.shopifyVariantId },
            data: { active: false, shopifyVariantMissingAt: new Date(), shopifySku: null },
          });
          if (updated.count !== 1) return false;

          await writeAdminAuditEvent(tx, {
            adminUserId: actor?.id ?? null,
            adminUserName: actor?.name ?? 'Sistema (sincronização de catálogo)',
            action: 'CATALOG_UNIT_DEACTIVATED',
            entityType: 'RentalUnit',
            entityId: d.rentalUnitId,
            before: { active: true, shopifySku: current?.shopifySku ?? null },
            after: { active: false, shopifySku: null, archived: true },
            detail: {
              origin: 'shopify_catalog_sync',
              reason: d.kind === 'product_inactive' ? 'shopify_product_inactive' : 'shopify_variant_missing',
              code: d.code,
              shopifyVariantId: d.shopifyVariantId,
              shopifyProductStatus: d.shopifyProductStatus,
            },
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

  /** Peça desativada à mão (sem marcador) cuja variante foi EXCLUÍDA da
   *  Shopify → arquivada: marcador + SKU desvinculado, `active` continua false.
   *  Só com a Shopify confirmando, na própria variante, que ela não existe
   *  (`getVariant` → null); lista incompleta ou erro na consulta = não mexe.
   *  Nunca apaga nada; reservas, bloqueios e histórico ficam como estão. */
  private async applyArchiveInactive(d: CatalogDivergence, actor?: { id: string; name: string }): Promise<boolean> {
    try {
      if ((await this.shopify.getVariant(d.shopifyVariantId)) !== null) return false;
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'rental-unit:' + d.rentalUnitId}))`;
          const current = await tx.rentalUnit.findUnique({ where: { id: d.rentalUnitId }, select: { shopifySku: true } });
          const updated = await tx.rentalUnit.updateMany({
            where: { id: d.rentalUnitId, active: false, shopifyVariantMissingAt: null, shopifyVariantId: d.shopifyVariantId },
            data: { shopifyVariantMissingAt: new Date(), shopifySku: null },
          });
          if (updated.count !== 1) return false;

          await writeAdminAuditEvent(tx, {
            adminUserId: actor?.id ?? null,
            adminUserName: actor?.name ?? 'Sistema (sincronização de catálogo)',
            action: 'CATALOG_UNIT_DEACTIVATED',
            entityType: 'RentalUnit',
            entityId: d.rentalUnitId,
            before: { active: false, shopifySku: current?.shopifySku ?? null },
            after: { active: false, shopifySku: null, archived: true },
            detail: {
              origin: 'shopify_catalog_sync',
              reason: 'shopify_variant_deleted_confirmed',
              note: 'peça já estava desativada manualmente',
              code: d.code,
              shopifyVariantId: d.shopifyVariantId,
            },
          });
          return true;
        },
        { timeout: 15_000, maxWait: 5_000 },
      );
    } catch (err) {
      this.logger.error(`Arquivamento da peça ${d.rentalUnitId} não concluído: ${errorCode(err)}`);
      return false;
    }
  }

  /** SKU da variante mudou na Shopify (cadastrado, alterado ou removido) →
   *  grava o SKU atual na peça. Condicional no vínculo (`shopifyVariantId`),
   *  em "não arquivada" e no SKU exatamente como foi lido: se algo mudou por
   *  fora no meio tempo, não aplica — a próxima rodada relê tudo. Idempotente:
   *  rodar de novo encontra o SKU já igual e nem chega aqui. Só escreve
   *  `shopifySku` — `active`, reservas, bloqueios e histórico não são tocados. */
  private async applySkuSync(
    d: CatalogDivergence,
    storedSku: string | null,
    storedCode: string,
    actor?: { id: string; name: string },
    releaseFrom?: string,
  ): Promise<boolean> {
    const shopifySku = d.shopifySku ?? null;
    const newCode = d.newCode ?? storedCode;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Duas peças na mesma transação: locks sempre em ordem de id (sem deadlock).
          for (const id of [d.rentalUnitId, ...(releaseFrom ? [releaseFrom] : [])].sort()) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'rental-unit:' + id}))`;
          }
          if (releaseFrom && newCode !== storedCode) {
            const released = await this.releaseArchivedCode(tx, releaseFrom, newCode, d, actor);
            if (!released) return false; // quem ocupava não está mais arquivado/no código: nada muda
          }
          const updated = await tx.rentalUnit.updateMany({
            where: { id: d.rentalUnitId, shopifyVariantId: d.shopifyVariantId, shopifyVariantMissingAt: null, shopifySku: storedSku, code: storedCode },
            data: { shopifySku, ...(newCode !== storedCode ? { code: newCode } : {}) },
          });
          if (updated.count !== 1) return false;

          await writeAdminAuditEvent(tx, {
            adminUserId: actor?.id ?? null,
            adminUserName: actor?.name ?? 'Sistema (sincronização de catálogo)',
            action: 'CATALOG_UNIT_SKU_SYNCED',
            entityType: 'RentalUnit',
            entityId: d.rentalUnitId,
            before: { shopifySku: d.previousSku ?? null, code: storedCode },
            after: { shopifySku, code: newCode },
            detail: {
              origin: 'shopify_catalog_sync',
              reason: !shopifySku
                ? 'shopify_sku_removed'
                : d.previousSku === shopifySku
                  ? 'code_follows_sku'
                  : d.previousSku
                    ? 'shopify_sku_changed'
                    : 'shopify_sku_added',
              code: d.code,
              shopifyVariantId: d.shopifyVariantId,
            },
          });
          return true;
        },
        { timeout: 15_000, maxWait: 5_000 },
      );
    } catch (err) {
      // P2002: outra peça pegou o mesmo código no meio tempo — não renomeia agora.
      this.logger.error(`Falha ao sincronizar SKU da peça ${d.rentalUnitId}: ${errorCode(err)}`);
      return false;
    }
  }

  /** Só reativa o que a PRÓPRIA sincronização desativou (`shopifyVariantMissingAt`
   *  presente) e cujo `shopifyVariantId` ainda é o mesmo. Se um humano já
   *  reativou manualmente (PATCH limpa o marcador) ou desativou por outro
   *  motivo depois, este UPDATE simplesmente não encontra a linha — no-op.
   *  SKU e produto são relidos da variante na Shopify (o dado atual, não o
   *  que estava gravado antes do arquivamento). */
  private async applyReactivate(
    d: CatalogDivergence,
    variant: ShopifyCatalogVariant | undefined,
    actor?: { id: string; name: string },
  ): Promise<boolean> {
    if (!variant) return false;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'rental-unit:' + d.rentalUnitId}))`;
          const updated = await tx.rentalUnit.updateMany({
            where: { id: d.rentalUnitId, active: false, shopifyVariantMissingAt: { not: null }, shopifyVariantId: d.shopifyVariantId },
            data: { active: true, shopifyVariantMissingAt: null, shopifySku: variant.sku, shopifyProductId: variant.product.id },
          });
          if (updated.count !== 1) return false;

          await writeAdminAuditEvent(tx, {
            adminUserId: actor?.id ?? null,
            adminUserName: actor?.name ?? 'Sistema (sincronização de catálogo)',
            action: 'CATALOG_UNIT_REACTIVATED',
            entityType: 'RentalUnit',
            entityId: d.rentalUnitId,
            before: { active: false, shopifySku: null },
            after: { active: true, shopifySku: variant.sku },
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
