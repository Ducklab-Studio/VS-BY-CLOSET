import { ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ValePassLot } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import {
  countPaidOrdersAwaitingProcessing,
  formatIsoDate,
  globalRemaining,
  loadLotSold,
  loadPaidOrderShortfalls,
  loadStatusCounts,
  recommendedShopifyStock,
  toLotView,
  type CapacityTotals,
  type LotView,
  type PaidOrderShortfall,
} from './vale-pass-capacity';

export type CapacityAlertCode =
  | 'LEGACY_LIMIT_BLOCKS_ISSUANCE'
  | 'PAID_ORDERS_WITHOUT_VOUCHER'
  | 'PAID_ORDERS_AWAITING_PROCESSING'
  | 'GLOBAL_LIMIT_REACHED'
  | 'GLOBAL_LIMIT_NOT_SET'
  | 'OPEN_LOT_SOLD_OUT';

export interface CapacityAlert {
  readonly code: CapacityAlertCode;
  /** `critical` = há (ou haverá) cliente pagante sem passe; `warning` = precisa de atenção; `info` = informativo. */
  readonly severity: 'critical' | 'warning' | 'info';
  readonly message: string;
}

export interface CampaignCapacity {
  readonly campaign: {
    readonly id: string;
    readonly name: string;
    readonly active: boolean;
    readonly globalLimit: number | null;
    /** Limite LEGADO que bloqueia a emissão — não confundir com o global. */
    readonly legacyQuantityLimit: number | null;
    readonly salesEndDate: string | null;
    readonly updatedAt: string;
  };
  readonly totals: CapacityTotals;
  /** Saldo do limite global (`null` = sem limite). */
  readonly globalRemaining: number | null;
  readonly openLot: LotView | null;
  readonly lots: readonly LotView[];
  /** Estoque que a Shopify deveria ter para refletir o controle do painel. Só informativo: o painel não altera a Shopify. */
  readonly recommendedShopifyStock: number;
  readonly paidOrdersWithoutVoucher: readonly PaidOrderShortfall[];
  readonly alerts: readonly CapacityAlert[];
}

interface LotWithUpdatedAt {
  readonly row: ValePassLot;
}

/**
 * Lotes comerciais e capacidade do Valle Pass. Registro de CONTROLE: abrir/encerrar um lote não altera a Shopify nem a
 * emissão de vales nesta etapa. Toda mudança é uma transação com a campanha travada (`FOR UPDATE`), auditada, e recusa
 * (409) quem agiu sobre uma versão antiga (`expectedUpdatedAt`).
 */
@Injectable()
export class ValePassLotsService {
  private readonly logger = new Logger(ValePassLotsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getCapacity(campaignId: string): Promise<CampaignCapacity> {
    const campaign = await this.prisma.valePassCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new NotFoundException('Campanha não encontrada.');

    const [totals, lotRows, soldByLot, shortfalls, awaiting] = await Promise.all([
      loadStatusCounts(this.prisma, campaignId),
      this.prisma.valePassLot.findMany({ where: { campaignId }, orderBy: [{ createdAt: 'desc' }] }),
      loadLotSold(this.prisma, campaignId),
      loadPaidOrderShortfalls(this.prisma),
      countPaidOrdersAwaitingProcessing(this.prisma),
    ]);

    const lots = lotRows.map((lot) => toLotView(lot, soldByLot.get(lot.id) ?? 0));
    const openLot = lots.find((lot) => lot.status === 'OPEN') ?? null;
    const remaining = globalRemaining(campaign.globalLimit, totals.sold);

    const alerts: CapacityAlert[] = [];
    if (shortfalls.length > 0) {
      const missing = shortfalls.reduce((sum, order) => sum + order.missing, 0);
      alerts.push({
        code: 'PAID_ORDERS_WITHOUT_VOUCHER',
        severity: 'critical',
        message: `${shortfalls.length} pedido(s) pago(s) ficaram com menos passes do que o comprado (${missing} passe(s) faltando). Resolva antes de vender mais.`,
      });
    }
    if (awaiting > 0) {
      alerts.push({ code: 'PAID_ORDERS_AWAITING_PROCESSING', severity: 'warning', message: `${awaiting} pedido(s) pago(s) ainda sem emissão de passe há mais de 15 minutos.` });
    }
    if (campaign.quantityLimit !== null) {
      const legacyRemaining = Math.max(0, campaign.quantityLimit - totals.issued);
      alerts.push({
        code: 'LEGACY_LIMIT_BLOCKS_ISSUANCE',
        severity: legacyRemaining === 0 ? 'critical' : 'warning',
        message: `O limite de emissão (${campaign.quantityLimit}) é o limite LEGADO: depois dele, um pedido pago fica SEM passe. Restam ${legacyRemaining}. Deixe-o vazio e use o limite global.`,
      });
    }
    if (campaign.globalLimit === null) {
      alerts.push({ code: 'GLOBAL_LIMIT_NOT_SET', severity: 'warning', message: 'Nenhum limite global configurado (ex.: 1.000). Sem ele, não é possível abrir lotes.' });
    } else if (remaining === 0) {
      alerts.push({ code: 'GLOBAL_LIMIT_REACHED', severity: 'info', message: `Limite global de ${campaign.globalLimit} passes atingido.` });
    }
    if (openLot?.soldOut) {
      alerts.push({ code: 'OPEN_LOT_SOLD_OUT', severity: 'info', message: `O lote "${openLot.name}" esgotou (${openLot.sold}/${openLot.quantity}). Encerre-o e abra o próximo.` });
    }

    return {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        active: campaign.active,
        globalLimit: campaign.globalLimit,
        legacyQuantityLimit: campaign.quantityLimit,
        salesEndDate: formatIsoDate(campaign.salesEndDate),
        updatedAt: campaign.updatedAt.toISOString(),
      },
      totals,
      globalRemaining: remaining,
      openLot,
      lots,
      recommendedShopifyStock: recommendedShopifyStock(openLot, remaining),
      paidOrdersWithoutVoucher: shortfalls,
      alerts,
    };
  }

  async create(campaignId: string, input: { name: string; quantity: number }, actorId: string, actorName: string): Promise<LotView> {
    const name = input.name.trim();
    if (!name) throw new UnprocessableEntityException('O nome do lote não pode ficar vazio.');
    const row = await this.inLockedCampaign(campaignId, 'criar o lote', async (tx, campaign) => {
      const totals = await loadStatusCounts(tx, campaignId);
      const remaining = globalRemaining(campaign.globalLimit, totals.sold);
      if (remaining !== null && input.quantity > remaining) {
        throw new UnprocessableEntityException(`O lote (${input.quantity}) não cabe no saldo do limite global (${remaining} restantes de ${campaign.globalLimit}). O limite de um lote nunca é o limite global.`);
      }
      const created = await tx.valePassLot.create({ data: { campaignId, name, quantity: input.quantity, createdBy: actorId } });
      await this.audit(tx, actorId, actorName, 'VALE_PASS_LOT_CREATED', created.id, undefined, { name, quantity: input.quantity, campaignId });
      return created;
    });
    return toLotView(row, 0);
  }

  /** Planejado: nome e quantidade. Aberto: só a quantidade (nunca abaixo do vendido, sempre dentro do saldo global). */
  async update(campaignId: string, lotId: string, input: { expectedUpdatedAt: string; name?: string; quantity?: number }, actorId: string, actorName: string): Promise<LotView> {
    const result = await this.inLockedCampaign(campaignId, 'editar o lote', async (tx, campaign) => {
      const { row: lot } = await this.requireFreshLot(tx, campaignId, lotId, input.expectedUpdatedAt);
      if (lot.status === 'CLOSED' || lot.status === 'CANCELLED') throw new ConflictException('Lote encerrado ou cancelado não pode ser editado.');
      const data: Prisma.ValePassLotUpdateInput = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};

      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) throw new UnprocessableEntityException('O nome do lote não pode ficar vazio.');
        if (lot.status === 'OPEN') throw new ConflictException('Num lote aberto só a quantidade pode ser alterada.');
        if (name !== lot.name) {
          data.name = name;
          before.name = lot.name;
          after.name = name;
        }
      }
      const sold = (await loadLotSold(tx, campaignId)).get(lot.id) ?? 0;
      if (input.quantity !== undefined && input.quantity !== lot.quantity) {
        if (input.quantity < sold) throw new UnprocessableEntityException(`A quantidade (${input.quantity}) é menor que os ${sold} passes já vendidos neste lote.`);
        const totals = await loadStatusCounts(tx, campaignId);
        const remaining = globalRemaining(campaign.globalLimit, totals.sold);
        // Saldo que o lote ainda reivindica = quantity − sold; o novo tamanho precisa caber no saldo global + o que já foi vendido nele.
        if (remaining !== null && input.quantity - sold > remaining) {
          throw new UnprocessableEntityException(`O lote (${input.quantity}) não cabe no limite global: restam ${remaining} passe(s) fora o que este lote já vendeu (${sold}).`);
        }
        data.quantity = input.quantity;
        before.quantity = lot.quantity;
        after.quantity = input.quantity;
      }
      if (Object.keys(data).length === 0) return { row: lot, sold };
      const updated = await tx.valePassLot.update({ where: { id: lot.id }, data });
      await this.audit(tx, actorId, actorName, 'VALE_PASS_LOT_UPDATED', lot.id, before, after);
      return { row: updated, sold };
    });
    return toLotView(result.row, result.sold);
  }

  async open(campaignId: string, lotId: string, expectedUpdatedAt: string, actorId: string, actorName: string): Promise<LotView> {
    const result = await this.inLockedCampaign(campaignId, 'abrir o lote', async (tx, campaign) => {
      const { row: lot } = await this.requireFreshLot(tx, campaignId, lotId, expectedUpdatedAt);
      if (lot.status !== 'PLANNED') throw new ConflictException('Só um lote planejado pode ser aberto. Um lote encerrado nunca é reaberto: crie um novo.');
      if (!campaign.active) throw new ConflictException('A campanha está encerrada. Reative-a antes de abrir um lote.');
      if (campaign.globalLimit === null) {
        throw new UnprocessableEntityException('Defina o limite global de passes (ex.: 1.000) antes de abrir um lote.');
      }
      const alreadyOpen = await tx.valePassLot.findFirst({ where: { campaignId, status: 'OPEN' }, select: { name: true } });
      if (alreadyOpen) throw new ConflictException(`O lote "${alreadyOpen.name}" já está aberto. Encerre-o antes de abrir outro.`);

      const totals = await loadStatusCounts(tx, campaignId);
      const remaining = globalRemaining(campaign.globalLimit, totals.sold) as number;
      if (lot.quantity > remaining) {
        throw new UnprocessableEntityException(`O lote (${lot.quantity}) não cabe no saldo do limite global (${remaining} restantes de ${campaign.globalLimit}).`);
      }
      const openedAt = new Date();
      const updated = await tx.valePassLot.update({ where: { id: lot.id }, data: { status: 'OPEN', openFlag: true, openedAt } });
      await this.audit(tx, actorId, actorName, 'VALE_PASS_LOT_OPENED', lot.id, { status: 'PLANNED' }, { status: 'OPEN', openedAt: openedAt.toISOString(), quantity: lot.quantity, globalRemainingBefore: remaining });
      return { row: updated, sold: 0 };
    });
    return toLotView(result.row, result.sold);
  }

  async close(campaignId: string, lotId: string, expectedUpdatedAt: string, actorId: string, actorName: string): Promise<LotView> {
    const result = await this.inLockedCampaign(campaignId, 'encerrar o lote', async (tx) => {
      const { row: lot } = await this.requireFreshLot(tx, campaignId, lotId, expectedUpdatedAt);
      if (lot.status !== 'OPEN') throw new ConflictException('Só um lote aberto pode ser encerrado.');
      const closedAt = new Date();
      const updated = await tx.valePassLot.update({ where: { id: lot.id }, data: { status: 'CLOSED', openFlag: null, closedAt } });
      const sold = (await loadLotSold(tx, campaignId)).get(lot.id) ?? 0;
      await this.audit(tx, actorId, actorName, 'VALE_PASS_LOT_CLOSED', lot.id, { status: 'OPEN' }, { status: 'CLOSED', closedAt: closedAt.toISOString(), sold, quantity: lot.quantity });
      return { row: updated, sold };
    });
    return toLotView(result.row, result.sold);
  }

  /** Cancela um lote que nunca foi aberto (o histórico fica; nada é apagado). */
  async cancel(campaignId: string, lotId: string, expectedUpdatedAt: string, actorId: string, actorName: string): Promise<LotView> {
    const result = await this.inLockedCampaign(campaignId, 'cancelar o lote', async (tx) => {
      const { row: lot } = await this.requireFreshLot(tx, campaignId, lotId, expectedUpdatedAt);
      if (lot.status !== 'PLANNED') throw new ConflictException('Só um lote planejado pode ser cancelado; para um lote aberto, use "Encerrar".');
      const updated = await tx.valePassLot.update({ where: { id: lot.id }, data: { status: 'CANCELLED' } });
      await this.audit(tx, actorId, actorName, 'VALE_PASS_LOT_CANCELLED', lot.id, { status: 'PLANNED' }, { status: 'CANCELLED' });
      return { row: updated, sold: 0 };
    });
    return toLotView(result.row, result.sold);
  }

  // ── internos ────────────────────────────────────────────────────────

  private async inLockedCampaign<T>(
    campaignId: string,
    what: string,
    work: (tx: Prisma.TransactionClient, campaign: Prisma.ValePassCampaignGetPayload<object>) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM vale_pass_campaigns WHERE id = ${campaignId}::uuid FOR UPDATE`;
          const campaign = await tx.valePassCampaign.findUnique({ where: { id: campaignId } });
          if (!campaign) throw new NotFoundException('Campanha não encontrada.');
          return work(tx, campaign);
        },
        { timeout: 15_000, maxWait: 5_000 },
      );
    } catch (err) {
      if (err instanceof NotFoundException || err instanceof ConflictException || err instanceof UnprocessableEntityException) throw err;
      // Rede de proteção do banco: dois lotes abertos ao mesmo tempo (o `FOR UPDATE` já impede; o índice único é a última linha).
      if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002') throw new ConflictException('Já existe um lote aberto para esta campanha.');
      this.logger.error(`Falha ao ${what} (campanha ${campaignId}): ${errorCode(err)}`);
      throw new ServiceUnavailableException(`Não foi possível ${what} no momento.`);
    }
  }

  private async requireFreshLot(tx: Prisma.TransactionClient, campaignId: string, lotId: string, expectedUpdatedAt: string): Promise<LotWithUpdatedAt> {
    const lot = await tx.valePassLot.findFirst({ where: { id: lotId, campaignId } });
    if (!lot) throw new NotFoundException('Lote não encontrado.');
    const expected = new Date(expectedUpdatedAt).getTime();
    if (Number.isNaN(expected) || lot.updatedAt.getTime() !== expected) {
      throw new ConflictException('O lote foi alterado por outra pessoa. Recarregue a tela e tente de novo.');
    }
    return { row: lot };
  }

  private audit(tx: Prisma.TransactionClient, actorId: string, actorName: string, action: string, lotId: string, before: unknown, after: unknown) {
    return writeAdminAuditEvent(tx, { adminUserId: actorId, adminUserName: actorName, action, entityType: 'ValePassLot', entityId: lotId, before, after });
  }
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
