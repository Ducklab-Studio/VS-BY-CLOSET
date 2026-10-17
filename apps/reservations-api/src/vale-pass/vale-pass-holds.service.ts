import { ConflictException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { ValePassHoldReason, ValePassHoldStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import { lockShopifyOrder } from '../webhooks/shopify-order-lock';
import { ValePassIssuanceService } from './vale-pass-issuance.service';
import { PASS_UNIT_KEY } from './vale-pass-capacity';

export interface HoldItem {
  readonly id: string;
  readonly shopifyOrderId: string;
  readonly shopifyOrderName: string | null;
  readonly campaignId: string;
  readonly campaignName: string;
  /** Unidades comerciais que ficaram sem emissão. */
  readonly units: number;
  readonly reason: ValePassHoldReason;
  readonly status: ValePassHoldStatus;
  /** Situação do pedido na Shopify segundo o registro (CONFIRMED = ainda pago). */
  readonly orderStatus: string | null;
  readonly detail: unknown;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly resolutionNote: string | null;
  readonly issuedUnits: number | null;
}

const TX = { timeout: 20_000, maxWait: 5_000 } as const;

/**
 * Fila de resolução: pagamentos CONFIRMADOS que não puderam ser emitidos sozinhos (limite global esgotado ou campanha sem validade).
 * Só um ADMIN resolve, sempre com justificativa e auditoria:
 *  - EMITIR (excedente aprovado): cria os vouchers mesmo acima do limite global; exige o pedido ainda pago e ativo;
 *  - DESCARTAR: só depois que o pedido deixou de estar pago (cancelado/reembolsado/excluído na Shopify). Descartar NUNCA reembolsa nem
 *    cancela nada: o reembolso é feito na Shopify (e chega aqui pelo webhook).
 * Nenhuma ação é automática.
 */
@Injectable()
export class ValePassHoldsService {
  private readonly logger = new Logger(ValePassHoldsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly issuance: ValePassIssuanceService,
  ) {}

  async list(options: { includeResolved?: boolean } = {}): Promise<HoldItem[]> {
    const holds = await this.prisma.valePassIssuanceHold.findMany({
      where: options.includeResolved ? {} : { status: 'OPEN' },
      orderBy: [{ createdAt: 'asc' }],
      take: 200,
      include: { campaign: { select: { name: true } } },
    });
    if (holds.length === 0) return [];
    const orders = await this.prisma.valePassOrder.findMany({
      where: { shopifyOrderId: { in: holds.map((hold) => hold.shopifyOrderId) } },
      select: { shopifyOrderId: true, shopifyOrderName: true, status: true, deletedInShopifyAt: true },
    });
    const byOrder = new Map(orders.map((order) => [order.shopifyOrderId, order]));
    return holds.map((hold) => {
      const order = byOrder.get(hold.shopifyOrderId);
      return {
        id: hold.id,
        shopifyOrderId: hold.shopifyOrderId,
        shopifyOrderName: order?.shopifyOrderName ?? null,
        campaignId: hold.campaignId,
        campaignName: hold.campaign.name,
        units: hold.units,
        reason: hold.reason,
        status: hold.status,
        orderStatus: order ? (order.deletedInShopifyAt ? 'DELETED' : order.status) : null,
        detail: hold.detail,
        createdAt: hold.createdAt.toISOString(),
        resolvedAt: hold.resolvedAt?.toISOString() ?? null,
        resolutionNote: hold.resolutionNote,
        issuedUnits: hold.issuedUnits,
      };
    });
  }

  /** Emite as unidades retidas (excedente aprovado por um ADMIN). */
  async issue(holdId: string, note: string, actorId: string, actorName: string): Promise<HoldItem> {
    const reason = note.trim();
    if (reason.length < 3) throw new UnprocessableEntityException('Informe a justificativa (mínimo 3 caracteres).');
    try {
      await this.prisma.$transaction(async (tx) => {
        const located = await tx.valePassIssuanceHold.findUnique({ where: { id: holdId } });
        if (!located) throw new NotFoundException('Retenção não encontrada.');
        await lockShopifyOrder(tx, located.shopifyOrderId); // mesmo lock do webhook: um cancelamento em andamento é esperado
        const hold = await tx.valePassIssuanceHold.findUniqueOrThrow({ where: { id: holdId } });
        if (hold.status !== 'OPEN') throw new ConflictException('Esta retenção já foi resolvida.');

        const order = await tx.valePassOrder.findUnique({ where: { shopifyOrderId: hold.shopifyOrderId } });
        const cancelled = await tx.valePassOrderCancellation.findUnique({ where: { shopifyOrderId: hold.shopifyOrderId } });
        if (!order || order.status !== 'CONFIRMED' || order.deletedInShopifyAt || cancelled) {
          throw new ConflictException('O pedido não está mais pago/ativo na Shopify: não há o que emitir. Use "Descartar" para encerrar a retenção.');
        }

        const [existing] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(DISTINCT ${PASS_UNIT_KEY})::int AS n FROM vale_passes v WHERE v.shopify_order_id = ${hold.shopifyOrderId} AND v.campaign_id = ${hold.campaignId}::uuid`;
        const outcome = await this.issuance.issueForCampaign(tx, {
          campaignId: hold.campaignId,
          order: {
            orderId: order.shopifyOrderId,
            orderGid: order.shopifyOrderGid,
            orderName: order.shopifyOrderName,
            customerName: order.customerName,
            customerPhone: order.customerPhone,
            customerEmail: order.customerEmail,
          },
          units: (existing?.n ?? 0) + hold.units,
          mode: 'override',
          actor: { id: actorId, name: actorName },
          resolutionNote: reason,
        });
        if (outcome.mode !== 'benefits' || outcome.heldUnits > 0) {
          // Campanha ainda não pronta (sem validade/voucher ativo): nada foi emitido e a retenção continua aberta.
          throw new UnprocessableEntityException('A campanha ainda não está pronta para emitir (configure os vouchers ativos e a validade) — a retenção continua aberta.');
        }
        await writeAdminAuditEvent(tx, {
          adminUserId: actorId,
          adminUserName: actorName,
          action: 'VALE_PASS_HOLD_ISSUED',
          entityType: 'ValePassIssuanceHold',
          entityId: hold.id,
          before: { status: 'OPEN', units: hold.units, reason: hold.reason },
          after: { status: 'ISSUED', issuedUnits: outcome.issuedUnits, completedUnits: outcome.completedUnits, vouchers: outcome.vouchersCreated },
          detail: { orderId: hold.shopifyOrderId, note: reason, override: true },
        });
      }, TX);
    } catch (err) {
      throw this.translate(err, 'emitir os vouchers');
    }
    return this.one(holdId);
  }

  /** Encerra a retenção de um pedido que NÃO está mais pago (cancelado/reembolsado/excluído). */
  async dismiss(holdId: string, note: string, actorId: string, actorName: string): Promise<HoldItem> {
    const reason = note.trim();
    if (reason.length < 3) throw new UnprocessableEntityException('Informe a justificativa (mínimo 3 caracteres).');
    try {
      await this.prisma.$transaction(async (tx) => {
        const located = await tx.valePassIssuanceHold.findUnique({ where: { id: holdId } });
        if (!located) throw new NotFoundException('Retenção não encontrada.');
        await lockShopifyOrder(tx, located.shopifyOrderId);
        const hold = await tx.valePassIssuanceHold.findUniqueOrThrow({ where: { id: holdId } });
        if (hold.status !== 'OPEN') throw new ConflictException('Esta retenção já foi resolvida.');

        const order = await tx.valePassOrder.findUnique({ where: { shopifyOrderId: hold.shopifyOrderId } });
        const cancelled = await tx.valePassOrderCancellation.findUnique({ where: { shopifyOrderId: hold.shopifyOrderId } });
        const stillPaid = order && order.status === 'CONFIRMED' && !order.deletedInShopifyAt && !cancelled;
        if (stillPaid) {
          throw new ConflictException('O pedido continua pago na Shopify. Emita os vouchers ou faça o reembolso na Shopify primeiro; depois descarte.');
        }
        await tx.valePassIssuanceHold.update({
          where: { id: hold.id },
          data: { status: 'DISMISSED', openFlag: null, resolvedAt: new Date(), resolvedBy: actorId, resolutionNote: reason },
        });
        await writeAdminAuditEvent(tx, {
          adminUserId: actorId,
          adminUserName: actorName,
          action: 'VALE_PASS_HOLD_DISMISSED',
          entityType: 'ValePassIssuanceHold',
          entityId: hold.id,
          before: { status: 'OPEN', units: hold.units, reason: hold.reason },
          after: { status: 'DISMISSED', orderStatus: order?.status ?? null },
          detail: { orderId: hold.shopifyOrderId, note: reason },
        });
      }, TX);
    } catch (err) {
      throw this.translate(err, 'descartar a retenção');
    }
    return this.one(holdId);
  }

  private async one(holdId: string): Promise<HoldItem> {
    const all = await this.list({ includeResolved: true });
    const found = all.find((hold) => hold.id === holdId);
    if (!found) throw new NotFoundException('Retenção não encontrada.');
    return found;
  }

  private translate(err: unknown, what: string): Error {
    if (err instanceof HttpException) return err;
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : err instanceof Error ? err.name : 'unknown';
    this.logger.error(`Falha ao ${what}: ${code}`);
    return new ServiceUnavailableException(`Não foi possível ${what} no momento.`);
  }
}
