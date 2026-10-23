import { ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger, Optional, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma, ValePassHoldReason, ValePassHoldStatus, ValePassIssuanceHold } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import { lockShopifyOrder } from '../webhooks/shopify-order-lock';
import { ValePassIssuanceService } from './vale-pass-issuance.service';
import { ValePassEmailOutboxService } from './email/email-outbox.service';
import { configuredCapacityLimit, PASS_UNIT_KEY, loadCapacity } from './vale-pass-capacity';
import { absorbedUnissuedUnits } from './refunds/refund.service';
import { financialIssueCodes } from './vale-pass-lots.service';

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
  readonly capacityLimit: number | null;
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
  readonly capacityLimit: number | null;
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
 *  - EMITIR: só cria vouchers quando a emissão cabe no teto configurado da campanha; retenções acima dele permanecem abertas;
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
    // Emissão excepcional também registra a mensagem inicial de e-mail (só enfileira — quem envia é o worker, desligado por padrão).
    @Optional() @Inject(ValePassEmailOutboxService) private readonly outbox: ValePassEmailOutboxService | null = null,
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
    const hold = await this.prisma.valePassIssuanceHold.findUnique({ where: { id: holdId }, include: { campaign: { select: { name: true, globalLimit: true, quantityLimit: true } } } });
    if (!hold) throw new NotFoundException('Retenção não encontrada.');
    if (hold.status !== 'OPEN') throw new ConflictException('Esta retenção já foi resolvida.');
    return this.project(this.prisma, hold);
  }

  private async project(
    client: Pick<Prisma.TransactionClient, '$queryRaw' | 'valePassOrder' | 'valePassOrderCancellation'>,
    hold: ValePassIssuanceHold & { campaign: { name: string; globalLimit: number | null; quantityLimit: number | null } },
  ): Promise<HoldProjection> {
    const order = await client.valePassOrder.findUnique({ where: { shopifyOrderId: hold.shopifyOrderId } });
    const cancelled = await client.valePassOrderCancellation.findUnique({ where: { shopifyOrderId: hold.shopifyOrderId } });
    const others = await loadCapacity(client, hold.campaignId, hold.shopifyOrderId); // consumo SEM este pedido
    const full = await loadCapacity(client, hold.campaignId);
    const [own] = await client.$queryRaw<{ n: number }[]>`
      SELECT count(DISTINCT ${PASS_UNIT_KEY})::int AS n FROM vale_passes v
      WHERE v.shopify_order_id = ${hold.shopifyOrderId} AND v.campaign_id = ${hold.campaignId}::uuid AND v.status <> 'CANCELLED'`;
    // O que este pedido já ocupa na capacidade (vendido + pago aguardando) pode ser MAIOR que a retenção (ex.: o pedido cresceu e o acréscimo ainda não foi
    // comprovado): emitir a retenção só troca "pago aguardando" por "vendido", então o total depois da emissão não cai abaixo do que o pedido já ocupa.
    const ownOccupied = Math.max(0, full.totals.consumed - others.totals.consumed - (own?.n ?? 0));
    const projectedTotal = others.totals.consumed + (own?.n ?? 0) + Math.max(hold.units, ownOccupied);
    const globalLimit = hold.campaign.globalLimit;
    const capacityLimit = configuredCapacityLimit(globalLimit, hold.campaign.quantityLimit);
    const exceededBy = capacityLimit === null ? 0 : Math.max(0, projectedTotal - capacityLimit);
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
      capacityLimit,
      soldBefore: full.totals.sold,
      pendingBefore: full.totals.pending,
      consumedBefore: full.totals.consumed,
      soldAfter: full.totals.sold + hold.units,
      pendingAfter: Math.max(0, full.totals.pending - hold.units),
      projectedTotal,
      exceedsLimit: exceededBy > 0,
      exceededBy,
      holdUpdatedAt: hold.updatedAt.toISOString(),
      canIssue: paid && !exceededBy,
      blockedReason: !paid
        ? 'O pedido não está mais pago/ativo na Shopify: não há o que emitir. Use "Descartar" para encerrar a retenção.'
        : exceededBy > 0
          ? `O pedido permanece retido: a emissão ultrapassaria o teto configurado da campanha (${capacityLimit}).`
          : null,
    };
  }

  /**
   * Emite unidades retidas somente dentro do teto configurado. Confirmação reforçada, sempre revalidada aqui:
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

        const hold = await tx.valePassIssuanceHold.findUniqueOrThrow({ where: { id: holdId }, include: { campaign: { select: { name: true, globalLimit: true, quantityLimit: true } } } });
        if (hold.status !== 'OPEN') throw new ConflictException('Esta retenção já foi resolvida.');
        // A retenção nunca pode emitir MAIS do que o pedido ainda deve (ex.: a quantidade diminuiu e ninguém sincronizou a retenção).
        const registryOrder = await tx.valePassOrder.findUnique({ where: { shopifyOrderId: hold.shopifyOrderId }, select: { quantity: true } });
        const [issuedBefore] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(DISTINCT ${PASS_UNIT_KEY})::int AS n FROM vale_passes v WHERE v.shopify_order_id = ${hold.shopifyOrderId} AND v.campaign_id = ${hold.campaignId}::uuid`;
        const stillOwed = (registryOrder?.quantity ?? 0) - (issuedBefore?.n ?? 0) - (await absorbedUnissuedUnits(tx, hold.shopifyOrderId));
        if (registryOrder && hold.units > stillOwed) {
          throw new ConflictException(`A quantidade do pedido diminuiu (restam ${Math.max(0, stillOwed)} unidade(s) a emitir; a retenção mostra ${hold.units}). Nada foi emitido: a retenção é atualizada pelo próximo evento do pedido; reabra a confirmação.`);
        }
        // Pedido de TESTE da Shopify nunca recebe voucher comercial, nem por emissão excepcional (descarte a retenção). Pagamento MANUAL pode ser aprovado aqui, com justificativa.
        if (financialIssueCodes(hold.detail).includes('TEST_ORDER')) throw new ConflictException('Este pedido é um pedido de TESTE da Shopify (test: true): não recebe vouchers comerciais. Descarte a retenção.');
        const projection = await this.project(tx, hold);
        if (projection.orderStatus !== 'CONFIRMED' || (!projection.canIssue && !projection.exceedsLimit)) {
          throw new ConflictException(projection.blockedReason ?? 'O pedido não está mais pago.');
        }

        const expected = input.expected;
        if (
          !expected ||
          expected.projectedTotal !== projection.projectedTotal ||
          expected.consumedTotal !== projection.consumedBefore ||
          expected.globalLimit !== projection.globalLimit ||
          expected.capacityLimit !== projection.capacityLimit ||
          expected.holdUpdatedAt !== projection.holdUpdatedAt
        ) {
          throw new ConflictException('A capacidade ou a retenção mudou desde que a confirmação foi aberta. Nada foi emitido: reabra a confirmação, confira os números atuais e confirme de novo.');
        }
        if (!Number.isInteger(input.confirmTotal) || input.confirmTotal !== projection.projectedTotal) {
          throw new UnprocessableEntityException(`Confirmação incorreta: digite o total projetado (${projection.projectedTotal}) para emitir.`);
        }
        if (projection.exceedsLimit) {
          throw new ConflictException(`A emissão excederia o teto configurado da campanha (${projection.capacityLimit}). A retenção permanece aberta para decisão humana; nenhum voucher foi emitido.`);
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

        // Uma mensagem INICIAL por unidade COMPLETA emitida, na MESMA transação (idempotente: `dedupe_key` por unidade; unidade incompleta, cancelada ou de
        // pedido não pago não entra). Não envia nada. Prazo: o pagamento real; sem ele, o instante em que o sistema abriu a retenção (base registrada).
        const queued = this.outbox ? await this.outbox.enqueueForOrder(tx, hold.shopifyOrderId, new Date(), { fallbackConfirmedAt: hold.createdAt }) : null;

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
          detail: { orderId: hold.shopifyOrderId, note: reason, override: true, exceedsLimit: projection.exceedsLimit, confirmedTotal: input.confirmTotal, emailsQueued: queued?.enqueued ?? 0, emailsAlreadyQueued: queued?.alreadyQueued ?? 0 },
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
        // Pedido de TESTE da Shopify nunca recebe voucher: a retenção pode ser descartada mesmo com o pedido "pago".
        if (stillPaid && !financialIssueCodes(hold.detail).includes('TEST_ORDER')) {
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
