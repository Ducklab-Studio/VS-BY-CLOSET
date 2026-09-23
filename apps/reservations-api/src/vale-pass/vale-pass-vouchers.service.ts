import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma, ValePass, ValePassStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import { lockShopifyOrder } from '../webhooks/shopify-order-lock';

export interface ValePassVoucherItem {
  readonly id: string;
  readonly code: string;
  readonly campaignId: string;
  readonly campaignName: string;
  readonly amountCents: number;
  readonly status: ValePassStatus;
  readonly purchasedAt: string;
  readonly expiresAt: string;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly customerEmail: string | null;
  readonly shopifyOrderId: string | null;
  readonly shopifyOrderName: string | null;
  readonly usedAt: string | null;
  readonly cancelledAt: string | null;
  readonly cancelReason: string | null;
  /** Só tem sentido quando `status === 'CANCELLED'`; `false`/`null` nos
   *  demais status. O frontend nunca decide isto sozinho — é só o que
   *  `restore()` já checaria, exposto pra mostrar o botão ou o motivo
   *  sem precisar de uma tentativa que sempre falharia. */
  readonly canBeRestored: boolean;
  readonly restoreBlockedReason: string | null;
}

export interface ValePassVoucherFilters {
  readonly status?: ValePassStatus;
  readonly campaignId?: string;
  /** Busca livre: código, nome, telefone, e-mail ou nº do pedido. */
  readonly search?: string;
}

const TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 } as const;
const STATUS_CHANGED_MESSAGE = 'O status deste Valle Pass mudou durante a operação — recarregue a tela e confira antes de tentar de novo.';

/**
 * "Listar, buscar, validar e marcar o Valle Pass como utilizado" —
 * nunca DELETE; "usar"/"cancelar"/"restaurar" são transições de status
 * (`ValePassStatus`), sempre com trilha em `ValePassEvent` +
 * `AdminAuditEvent` gravadas na MESMA transação da mudança. Expiração é
 * LAZY (mesmo padrão já usado pra `pending_payment` → `expired` em
 * reservas): `ACTIVE` com `expiresAt` no passado vira `EXPIRED` no próximo
 * `list()`/`findByCode()`, nunca por um cron separado.
 */
@Injectable()
export class ValePassVouchersService {
  private readonly logger = new Logger(ValePassVouchersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(filters: ValePassVoucherFilters): Promise<ValePassVoucherItem[]> {
    await this.expireStale();

    const search = filters.search?.trim();
    const rows = await this.prisma.valePass.findMany({
      where: {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
        ...(search
          ? {
              OR: [
                { code: { contains: search, mode: 'insensitive' } },
                { customerName: { contains: search, mode: 'insensitive' } },
                { customerPhone: { contains: search, mode: 'insensitive' } },
                { customerEmail: { contains: search, mode: 'insensitive' } },
                { shopifyOrderName: { contains: search, mode: 'insensitive' } },
                { shopifyOrderId: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: { campaign: { select: { name: true } } },
      orderBy: { purchasedAt: 'desc' },
      take: 200,
    });
    const cancelledOrderIds = await loadCancelledOrderIds(this.prisma, rows);
    return rows.map((row) => toItem(row, row.campaign.name, cancelledOrderIds));
  }

  async findByCode(code: string): Promise<ValePassVoucherItem> {
    await this.expireStale();
    return this.toItemFresh(await this.requireByCode(code));
  }

  async markUsed(code: string, actorId: string, actorName: string): Promise<ValePassVoucherItem> {
    const updated = await this.inVoucherTransaction(code, 'Não foi possível marcar o Valle Pass como utilizado no momento.', async (tx, target) => {
      if (target.status !== 'ACTIVE') {
        throw new BadRequestException(`Este Valle Pass não pode ser utilizado — status atual: ${STATUS_LABELS[target.status]}.`);
      }
      // ACTIVE com pedido cancelado/reembolsado não nasce mais (o webhook
      // cancela os ativos na mesma transação em que registra o pedido); só
      // pode vir de dado legado restaurado antes desta regra existir.
      if (target.shopifyOrderId && (await isOrderCancelled(tx, target.shopifyOrderId))) {
        throw new ConflictException('O pedido Shopify deste Valle Pass foi cancelado ou reembolsado — o vale não pode ser utilizado.');
      }

      // Status no WHERE + contagem: dois resgates simultâneos do mesmo
      // código nunca gravam USED os dois.
      const changed = await tx.valePass.updateMany({
        where: { id: target.id, status: 'ACTIVE' },
        data: { status: 'USED', usedAt: new Date(), usedBy: actorId },
      });
      if (changed.count !== 1) throw new ConflictException(STATUS_CHANGED_MESSAGE);

      await tx.valePassEvent.create({ data: { valePassId: target.id, type: 'USED', detail: { actorId } } });
      await writeAdminAuditEvent(tx, {
        adminUserId: actorId,
        adminUserName: actorName,
        action: 'VALE_PASS_MARKED_USED',
        entityType: 'ValePass',
        entityId: target.id,
        before: { status: target.status },
        after: { status: 'USED' },
        detail: { code: target.code },
      });
      return tx.valePass.findUniqueOrThrow({ where: { id: target.id } });
    });
    return this.toItemFresh(updated);
  }

  async cancel(code: string, reason: string, actorId: string, actorName: string): Promise<ValePassVoucherItem> {
    const updated = await this.inVoucherTransaction(code, 'Não foi possível cancelar o Valle Pass no momento.', async (tx, target) => {
      if (target.status === 'USED') throw new ConflictException('Este Valle Pass já foi utilizado — não pode ser cancelado.');
      if (target.status === 'CANCELLED') throw new BadRequestException('Este Valle Pass já está cancelado.');

      const changed = await tx.valePass.updateMany({
        where: { id: target.id, status: target.status },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: actorId, cancelReason: reason },
      });
      if (changed.count !== 1) throw new ConflictException(STATUS_CHANGED_MESSAGE);

      await tx.valePassEvent.create({ data: { valePassId: target.id, type: 'CANCELLED', detail: { actorId, reason, source: 'admin' } } });
      await writeAdminAuditEvent(tx, {
        adminUserId: actorId,
        adminUserName: actorName,
        action: 'VALE_PASS_CANCELLED_BY_ADMIN',
        entityType: 'ValePass',
        entityId: target.id,
        before: { status: target.status },
        after: { status: 'CANCELLED' },
        detail: { code: target.code, reason },
      });
      return tx.valePass.findUniqueOrThrow({ where: { id: target.id } });
    });
    return this.toItemFresh(updated);
  }

  /**
   * Restaura um Valle Pass CANCELADO pra ACTIVE. Nenhum status novo.
   *
   * Elegível SOMENTE se, simultaneamente: está CANCELLED; nunca foi
   * utilizado; foi cancelado por um ADMIN; o pedido Shopify NÃO tem
   * cancelamento/reembolso confirmado; e ainda não expirou.
   *
   * Roda sob o mesmo lock de pedido do webhook: se um cancelamento/reembolso
   * estiver sendo processado agora, a restauração espera ele terminar e
   * então é recusada — nunca termina ACTIVE com o pedido cancelado.
   *
   * Tentativa recusada por cancelamento Shopify fica registrada
   * (RESTORE_BLOCKED + auditoria) antes do 409.
   */
  async restore(code: string, reason: string, actorId: string, actorName: string): Promise<ValePassVoucherItem> {
    const outcome = await this.inVoucherTransaction(code, 'Não foi possível restaurar o Valle Pass no momento.', async (tx, target) => {
      const block = await restoreBlock(tx, target);
      if (block?.shopify) {
        await tx.valePassEvent.create({
          data: { valePassId: target.id, type: 'RESTORE_BLOCKED', detail: { actorId, reason, blockedBy: 'shopify_order_cancelled', message: block.message } },
        });
        await writeAdminAuditEvent(tx, {
          adminUserId: actorId,
          adminUserName: actorName,
          action: 'VALE_PASS_RESTORE_BLOCKED',
          entityType: 'ValePass',
          entityId: target.id,
          before: { status: target.status, cancelledBy: target.cancelledBy, cancelReason: target.cancelReason },
          detail: { code: target.code, reason, blockedBy: 'shopify_order_cancelled' },
        });
        return { blocked: new ConflictException(block.message) };
      }
      if (block) throw block.error;

      // Status no WHERE: duplo clique ou duas abas → só uma grava.
      const changed = await tx.valePass.updateMany({
        where: { id: target.id, status: 'CANCELLED' },
        // A linha atual volta a representar um vale ativo; o cancelamento
        // anterior fica pra sempre no evento/auditoria abaixo.
        data: { status: 'ACTIVE', cancelledAt: null, cancelledBy: null, cancelReason: null },
      });
      if (changed.count !== 1) throw new ConflictException(STATUS_CHANGED_MESSAGE);

      await tx.valePassEvent.create({
        data: {
          valePassId: target.id,
          type: 'RESTORED',
          detail: { actorId, reason, previousCancelledAt: target.cancelledAt?.toISOString() ?? null, previousCancelledBy: target.cancelledBy, previousCancelReason: target.cancelReason },
        },
      });
      await writeAdminAuditEvent(tx, {
        adminUserId: actorId,
        adminUserName: actorName,
        action: 'VALE_PASS_RESTORED',
        entityType: 'ValePass',
        entityId: target.id,
        before: { status: target.status, cancelledAt: target.cancelledAt, cancelledBy: target.cancelledBy, cancelReason: target.cancelReason },
        after: { status: 'ACTIVE' },
        detail: { code: target.code, reason },
      });
      return { restored: await tx.valePass.findUniqueOrThrow({ where: { id: target.id } }) };
    });

    // Fora da transação: o registro da tentativa bloqueada já foi gravado.
    if ('blocked' in outcome) throw outcome.blocked;
    return this.toItemFresh(outcome.restored);
  }

  /**
   * Toda mudança de status do vale passa por aqui: transação com o lock do
   * pedido Shopify (o MESMO do webhook — `lockShopifyOrder`) e a linha do
   * vale travada, relida depois dos locks. Qualquer falha desfaz a
   * transação inteira: status, evento e auditoria nunca ficam pela metade.
   */
  private async inVoucherTransaction<T>(code: string, unavailableMessage: string, work: (tx: Prisma.TransactionClient, target: ValePass) => Promise<T>): Promise<T> {
    await this.expireStale();
    const located = await this.requireByCode(code);
    try {
      return await this.prisma.$transaction(async (tx) => {
        // `shopifyOrderId` nunca muda depois da emissão, então a leitura
        // fora da transação é suficiente para escolher o lock.
        if (located.shopifyOrderId) await lockShopifyOrder(tx, located.shopifyOrderId);
        await tx.$executeRaw`SELECT 1 FROM vale_passes WHERE id = ${located.id}::uuid FOR UPDATE`;
        const target = await tx.valePass.findUniqueOrThrow({ where: { id: located.id } });
        return work(tx, target);
      }, TX_OPTIONS);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`Falha em operação do Valle Pass ${located.id}: ${errorCode(err)}`);
      throw new ServiceUnavailableException(unavailableMessage);
    }
  }

  private async toItemFresh(row: ValePass): Promise<ValePassVoucherItem> {
    const [campaign, cancelledOrderIds] = await Promise.all([
      this.prisma.valePassCampaign.findUniqueOrThrow({ where: { id: row.campaignId }, select: { name: true } }),
      loadCancelledOrderIds(this.prisma, [row]),
    ]);
    return toItem(row, campaign.name, cancelledOrderIds);
  }

  private async requireByCode(code: string): Promise<ValePass> {
    const normalized = code.trim().toUpperCase();
    const row = await this.prisma.valePass.findUnique({ where: { code: normalized } });
    if (!row) throw new NotFoundException('Valle Pass não encontrado para este código.');
    return row;
  }

  /** Mesmo padrão já usado pra `pending_payment` → `expired`: um
   *  UPDATE escopado, disparado a cada leitura, nunca um cron
   *  separado. */
  private async expireStale(): Promise<void> {
    await this.prisma.valePass.updateMany({ where: { status: 'ACTIVE', expiresAt: { lte: new Date() } }, data: { status: 'EXPIRED' } });
  }
}

const STATUS_LABELS: Record<ValePassStatus, string> = { ACTIVE: 'ativo', USED: 'utilizado', EXPIRED: 'expirado', CANCELLED: 'cancelado' };

type PrismaReader = Pick<PrismaService | Prisma.TransactionClient, 'valePassOrderCancellation' | 'valePass'>;

async function isOrderCancelled(client: PrismaReader, shopifyOrderId: string): Promise<boolean> {
  return (await loadCancelledOrderIds(client, [{ shopifyOrderId }])).has(shopifyOrderId);
}

/** Pedidos (dentre os das linhas dadas) com cancelamento/reembolso
 *  confirmado pela Shopify: o registro do pedido, ou — sinal anterior a ele,
 *  mantido como segunda fonte — algum vale do pedido cancelado pelo webhook
 *  (`cancelledBy` nulo). Duas consultas no total, nunca N+1. */
async function loadCancelledOrderIds(client: PrismaReader, rows: readonly Pick<ValePass, 'shopifyOrderId'>[]): Promise<ReadonlySet<string>> {
  const orderIds = [...new Set(rows.map((r) => r.shopifyOrderId).filter((id): id is string => id !== null))];
  if (orderIds.length === 0) return new Set();
  const recorded = await client.valePassOrderCancellation.findMany({ where: { shopifyOrderId: { in: orderIds } }, select: { shopifyOrderId: true } });
  const cancelledByWebhook = await client.valePass.findMany({
    where: { shopifyOrderId: { in: orderIds }, status: 'CANCELLED', cancelledBy: null },
    select: { shopifyOrderId: true },
    distinct: ['shopifyOrderId'],
  });
  return new Set([...recorded.map((r) => r.shopifyOrderId), ...cancelledByWebhook.map((r) => r.shopifyOrderId as string)]);
}

type RestoreBlockKind = 'used' | 'cancelled_by_shopify' | 'order_cancelled_in_shopify' | 'expired';

const LIST_REASONS: Record<RestoreBlockKind, string> = {
  used: 'Já foi utilizado.',
  cancelled_by_shopify: 'Cancelado automaticamente por um cancelamento/reembolso do pedido na Shopify.',
  order_cancelled_in_shopify: 'O pedido Shopify deste vale foi cancelado ou reembolsado.',
  expired: 'A validade já expirou.',
};

/** Regras de restauração de um vale CANCELLED, numa ordem só, usadas pela
 *  listagem (motivo exibido) e por `restore()` (que relê tudo dentro da
 *  transação — nunca confia no que a tela mostrou antes do clique). */
function restoreBlockKind(row: ValePass, orderCancelled: boolean): RestoreBlockKind | null {
  if (row.usedAt) return 'used';
  if (!row.cancelledBy) return 'cancelled_by_shopify';
  if (orderCancelled) return 'order_cancelled_in_shopify';
  if (row.expiresAt.getTime() <= Date.now()) return 'expired';
  return null;
}

async function restoreBlock(tx: Prisma.TransactionClient, target: ValePass): Promise<{ shopify: true; message: string } | { shopify: false; error: HttpException } | null> {
  if (target.status !== 'CANCELLED') {
    return { shopify: false, error: new BadRequestException(`Este Valle Pass não pode ser restaurado — status atual: ${STATUS_LABELS[target.status]}.`) };
  }
  const orderCancelled = target.shopifyOrderId ? await isOrderCancelled(tx, target.shopifyOrderId) : false;
  switch (restoreBlockKind(target, orderCancelled)) {
    case null:
      return null;
    case 'used':
      return { shopify: false, error: new ConflictException('Este Valle Pass já foi utilizado e não pode ser restaurado.') };
    case 'expired':
      return { shopify: false, error: new BadRequestException('Este Valle Pass já expirou. Restaurar um vale cancelado não reabre a validade — isso exige uma ação separada e explícita.') };
    case 'cancelled_by_shopify':
      return { shopify: true, message: 'Este Valle Pass foi cancelado automaticamente por um cancelamento ou reembolso do pedido na Shopify — não pode ser restaurado por aqui.' };
    case 'order_cancelled_in_shopify':
      return { shopify: true, message: 'O pedido Shopify deste Valle Pass foi cancelado ou reembolsado — não é possível restaurar.' };
  }
}

function restoreEligibility(row: ValePass, cancelledOrderIds: ReadonlySet<string>): { canBeRestored: boolean; restoreBlockedReason: string | null } {
  if (row.status !== 'CANCELLED') return { canBeRestored: false, restoreBlockedReason: null };
  const kind = restoreBlockKind(row, row.shopifyOrderId !== null && cancelledOrderIds.has(row.shopifyOrderId));
  return kind ? { canBeRestored: false, restoreBlockedReason: LIST_REASONS[kind] } : { canBeRestored: true, restoreBlockedReason: null };
}

function toItem(row: ValePass, campaignName: string, cancelledOrderIds: ReadonlySet<string>): ValePassVoucherItem {
  const { canBeRestored, restoreBlockedReason } = restoreEligibility(row, cancelledOrderIds);
  return {
    id: row.id,
    code: row.code,
    campaignId: row.campaignId,
    campaignName,
    amountCents: row.amountCents,
    status: row.status,
    purchasedAt: row.purchasedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    customerEmail: row.customerEmail,
    shopifyOrderId: row.shopifyOrderId,
    shopifyOrderName: row.shopifyOrderName,
    usedAt: row.usedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason,
    canBeRestored,
    restoreBlockedReason,
  };
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
