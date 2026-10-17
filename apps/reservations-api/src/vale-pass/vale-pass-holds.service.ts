import { ConflictException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma, ValePassHoldReason, ValePassHoldStatus, ValePassIssuanceHold } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import { lockShopifyOrder } from '../webhooks/shopify-order-lock';
import { ValePassIssuanceService } from './vale-pass-issuance.service';
import { PASS_UNIT_KEY, loadCapacity } from './vale-pass-capacity';

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

/** Números que a pessoa viu na tela de confirmação. O servidor recalcula tudo e recusa se algo mudou. */
export interface IssueHoldExpected {
  readonly projectedTotal: number;
  readonly consumedTotal: number;
  readonly globalLimit: number | null;
  readonly holdUpdatedAt: string;
}

export interface IssueHoldInput {
  /** Justificativa (mínimo de 10 caracteres). */
  readonly note: string;
  /** Total projetado digitado pela pessoa. */
  readonly confirmTotal: number;
  readonly expected: IssueHoldExpected;
}

/** Retrato da emissão excepcional: o que é hoje e o que passa a ser depois. */
export interface HoldProjection {
  readonly holdId: string;
  readonly campaignId: string;
  readonly campaignName: string;
  readonly orderId: string;
  readonly orderName: string | null;
  readonly orderStatus: string | null;
  readonly units: number;
  readonly reason: ValePassHoldReason;
  readonly globalLimit: number | null;
  readonly soldBefore: number;
  readonly pendingBefore: number;
  /** O que o limite global compara hoje (vendidos + pagos aguardando, incluindo esta retenção). */
  readonly consumedBefore: number;
  readonly soldAfter: number;
  readonly pendingAfter: number;
  /** Total que o limite compara DEPOIS da emissão: é o número que a pessoa digita para confirmar. */
  readonly projectedTotal: number;
  readonly exceedsLimit: boolean;
  readonly exceededBy: number;
  readonly holdUpdatedAt: string;
  readonly canIssue: boolean;
  readonly blockedReason: string | null;
}

export const MIN_ISSUE_NOTE = 10;

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

  /**
   * Retrato da emissão excepcional (somente leitura): limite, consumo de hoje e total depois da emissão. É o que a tela de confirmação
   * mostra; a emissão de verdade recalcula tudo no servidor, com as travas, e recusa se algum número tiver mudado.
   */
  async preview(holdId: string): Promise<HoldProjection> {
    const hold = await this.prisma.valePassIssuanceHold.findUnique({ where: { id: holdId }, include: { campaign: { select: { name: true, globalLimit: true } } } });
    if (!hold) throw new NotFoundException('Retenção não encontrada.');
    if (hold.status !== 'OPEN') throw new ConflictException('Esta retenção já foi resolvida.');
    return this.project(this.prisma, hold);
  }

  private async project(
    client: Pick<Prisma.TransactionClient, '$queryRaw' | 'valePassOrder' | 'valePassOrderCancellation'>,
    hold: ValePassIssuanceHold & { campaign: { name: string; globalLimit: number | null } },
  ): Promise<HoldProjection> {
    const order = await client.valePassOrder.findUnique({ where: { shopifyOrderId: hold.shopifyOrderId } });
    const cancelled = await client.valePassOrderCancellation.findUnique({ where: { shopifyOrderId: hold.shopifyOrderId } });
    const others = await loadCapacity(client, hold.campaignId, hold.shopifyOrderId); // consumo SEM este pedido
    const full = await loadCapacity(client, hold.campaignId);
    const [own] = await client.$queryRaw<{ n: number }[]>`
      SELECT count(DISTINCT ${PASS_UNIT_KEY})::int AS n FROM vale_passes v
      WHERE v.shopify_order_id = ${hold.shopifyOrderId} AND v.campaign_id = ${hold.campaignId}::uuid AND v.status <> 'CANCELLED'`;
    const projectedTotal = others.totals.consumed + (own?.n ?? 0) + hold.units;
    const globalLimit = hold.campaign.globalLimit;
    const exceededBy = globalLimit === null ? 0 : Math.max(0, projectedTotal - globalLimit);
    const paid = Boolean(order && order.status === 'CONFIRMED' && !order.deletedInShopifyAt && !cancelled);
    return {
      holdId: hold.id,
      campaignId: hold.campaignId,
      campaignName: hold.campaign.name,
      orderId: hold.shopifyOrderId,
      orderName: order?.shopifyOrderName ?? null,
      orderStatus: order ? (order.deletedInShopifyAt ? 'DELETED' : cancelled ? 'CANCELLED' : order.status) : null,
      units: hold.units,
      reason: hold.reason,
      globalLimit,
      soldBefore: full.totals.sold,
      pendingBefore: full.totals.pending,
      consumedBefore: full.totals.consumed,
      soldAfter: full.totals.sold + hold.units,
      pendingAfter: Math.max(0, full.totals.pending - hold.units),
      projectedTotal,
      exceedsLimit: exceededBy > 0,
      exceededBy,
      holdUpdatedAt: hold.updatedAt.toISOString(),
      canIssue: paid,
      blockedReason: paid ? null : 'O pedido não está mais pago/ativo na Shopify: não há o que emitir. Use "Descartar" para encerrar a retenção.',
    };
  }

  /**
   * Emite as unidades retidas acima do limite (excedente aprovado por um ADMIN). Confirmação reforçada, sempre revalidada aqui:
   * perfil ADMIN ativo, retenção aberta, pedido ainda pago, justificativa, números que a pessoa viu (iguais aos de agora) e o total
   * projetado digitado. Qualquer divergência rejeita sem emitir; se a capacidade mudou, é preciso abrir a confirmação de novo.
   */
  async issue(holdId: string, input: IssueHoldInput, actorId: string, actorName: string): Promise<HoldItem> {
    const reason = (input.note ?? '').trim();
    if (reason.length < MIN_ISSUE_NOTE) throw new UnprocessableEntityException(`Informe a justificativa (mínimo ${MIN_ISSUE_NOTE} caracteres).`);
    try {
      await this.prisma.$transaction(async (tx) => {
        const located = await tx.valePassIssuanceHold.findUnique({ where: { id: holdId } });
        if (!located) throw new NotFoundException('Retenção não encontrada.');
        await lockShopifyOrder(tx, located.shopifyOrderId); // mesmo lock do webhook: um cancelamento em andamento é esperado
        await tx.$queryRaw`SELECT id FROM vale_pass_campaigns WHERE id = ${located.campaignId}::uuid FOR UPDATE`; // mesma trava da emissão e do painel

        // Perfil revalidado AQUI (o guard da rota não basta): ADMIN e ativo.
        const actor = await tx.adminUser.findUnique({ where: { id: actorId }, select: { role: true, active: true } });
        if (!actor || !actor.active || actor.role !== 'ADMIN') throw new ForbiddenException('Somente um administrador pode emitir acima do limite.');

        const hold = await tx.valePassIssuanceHold.findUniqueOrThrow({ where: { id: holdId }, include: { campaign: { select: { name: true, globalLimit: true } } } });
        if (hold.status !== 'OPEN') throw new ConflictException('Esta retenção já foi resolvida.');
        const projection = await this.project(tx, hold);
        if (!projection.canIssue) throw new ConflictException(projection.blockedReason ?? 'O pedido não está mais pago.');

        const expected = input.expected;
        if (
          !expected ||
          expected.projectedTotal !== projection.projectedTotal ||
          expected.consumedTotal !== projection.consumedBefore ||
          expected.globalLimit !== projection.globalLimit ||
          expected.holdUpdatedAt !== projection.holdUpdatedAt
        ) {
          throw new ConflictException('A capacidade ou a retenção mudou desde que a confirmação foi aberta. Nada foi emitido: reabra a confirmação, confira os números atuais e confirme de novo.');
        }
        if (!Number.isInteger(input.confirmTotal) || input.confirmTotal !== projection.projectedTotal) {
          throw new UnprocessableEntityException(`Confirmação incorreta: digite o total projetado (${projection.projectedTotal}) para emitir.`);
        }

        const [existing] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(DISTINCT ${PASS_UNIT_KEY})::int AS n FROM vale_passes v WHERE v.shopify_order_id = ${hold.shopifyOrderId} AND v.campaign_id = ${hold.campaignId}::uuid`;
        const order = await tx.valePassOrder.findUniqueOrThrow({ where: { shopifyOrderId: hold.shopifyOrderId } });
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

        // Invariante: a emissão excepcional só TROCA "pago aguardando" por "vendido". O consumo total não pode mudar: se mudasse, o painel
        // passaria a enxergar uma capacidade que não existe (ou esconderia o excesso). Rejeita e desfaz.
        const after = await loadCapacity(tx, hold.campaignId);
        if (after.totals.consumed !== projection.projectedTotal) {
          throw new ConflictException('O consumo da campanha divergiu do total projetado após a emissão. Nada foi emitido: reabra a confirmação.');
        }

        await writeAdminAuditEvent(tx, {
          adminUserId: actorId,
          adminUserName: actorName,
          action: 'VALE_PASS_HOLD_ISSUED',
          entityType: 'ValePassIssuanceHold',
          entityId: hold.id,
          before: { status: 'OPEN', units: hold.units, reason: hold.reason, globalLimit: projection.globalLimit, sold: projection.soldBefore, pending: projection.pendingBefore, consumed: projection.consumedBefore },
          after: {
            status: 'ISSUED',
            issuedUnits: outcome.issuedUnits,
            completedUnits: outcome.completedUnits,
            vouchers: outcome.vouchersCreated,
            sold: after.totals.sold,
            pending: after.totals.pending,
            consumed: after.totals.consumed,
            exceededBy: projection.exceededBy,
          },
          detail: { orderId: hold.shopifyOrderId, note: reason, override: true, exceedsLimit: projection.exceedsLimit, confirmedTotal: input.confirmTotal },
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
