import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ValePass, ValePassStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';

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

/**
 * "Listar, buscar, validar e marcar o Valle Pass como utilizado" —
 * nunca DELETE; "usar"/"cancelar" são transições de status
 * (`ValePassStatus`), sempre com trilha em `ValePassEvent` +
 * `AdminAuditEvent`. Expiração é LAZY (mesmo padrão já usado pra
 * `pending_payment` → `expired` em reservas): `ACTIVE` com `expiresAt`
 * no passado vira `EXPIRED` no próximo `list()`/`findByCode()`, nunca
 * por um cron separado.
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
    const autoCancelledOrderIds = await this.loadAutoCancelledOrderIds();
    return rows.map((row) => toItem(row, row.campaign.name, autoCancelledOrderIds));
  }

  async findByCode(code: string): Promise<ValePassVoucherItem> {
    await this.expireStale();
    const row = await this.requireByCode(code);
    const autoCancelledOrderIds = await this.loadAutoCancelledOrderIds();
    return toItem(row, (await this.prisma.valePassCampaign.findUniqueOrThrow({ where: { id: row.campaignId }, select: { name: true } })).name, autoCancelledOrderIds);
  }

  async markUsed(code: string, actorId: string, actorName: string): Promise<ValePassVoucherItem> {
    await this.expireStale();
    const target = await this.requireByCode(code);

    if (target.status !== 'ACTIVE') {
      throw new BadRequestException(`Este Valle Pass não pode ser utilizado — status atual: ${STATUS_LABELS[target.status]}.`);
    }

    // UPDATE condicional: o status lido entra no WHERE, então a checagem
    // acima e a gravação viram uma coisa só para o banco. Sem isto, dois
    // resgates simultâneos do mesmo código — dois operadores no balcão ou
    // duas chamadas diretas à API — passavam os dois pela checagem e
    // gravavam USED os dois, entregando o mesmo crédito duas vezes. Mesmo
    // padrão já usado em reservas e webhooks (`status` no WHERE + conferir
    // a contagem).
    let changed;
    try {
      changed = await this.prisma.valePass.updateMany({
        where: { id: target.id, status: target.status },
        data: { status: 'USED', usedAt: new Date(), usedBy: actorId },
      });
    } catch (err) {
      this.logger.error(`Falha ao marcar Valle Pass ${target.id} como utilizado: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível marcar o Valle Pass como utilizado no momento.');
    }
    if (changed.count !== 1) {
      throw new ConflictException('O status deste Valle Pass mudou durante a operação — recarregue a tela e confira antes de tentar de novo.');
    }
    const updated = await this.prisma.valePass.findUniqueOrThrow({ where: { id: target.id } });

    await this.prisma.valePassEvent.create({ data: { valePassId: target.id, type: 'USED', detail: { actorId } } });
    await writeAdminAuditEvent(this.prisma, {
      adminUserId: actorId,
      adminUserName: actorName,
      action: 'VALE_PASS_MARKED_USED',
      entityType: 'ValePass',
      entityId: target.id,
      before: { status: target.status },
      after: { status: 'USED' },
      detail: { code: target.code },
    });

    return this.toItemFresh(updated);
  }

  async cancel(code: string, reason: string, actorId: string, actorName: string): Promise<ValePassVoucherItem> {
    await this.expireStale();
    const target = await this.requireByCode(code);

    if (target.status === 'USED') throw new ConflictException('Este Valle Pass já foi utilizado — não pode ser cancelado.');
    if (target.status === 'CANCELLED') throw new BadRequestException('Este Valle Pass já está cancelado.');

    // Mesmo UPDATE condicional do markUsed: sem o status no WHERE, um
    // cancelamento e um resgate simultâneos gravavam os dois, e o vale
    // terminava cancelado depois de já ter sido entregue como crédito.
    let changed;
    try {
      changed = await this.prisma.valePass.updateMany({
        where: { id: target.id, status: target.status },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: actorId, cancelReason: reason },
      });
    } catch (err) {
      this.logger.error(`Falha ao cancelar Valle Pass ${target.id}: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível cancelar o Valle Pass no momento.');
    }
    if (changed.count !== 1) {
      throw new ConflictException('O status deste Valle Pass mudou durante a operação — recarregue a tela e confira antes de tentar de novo.');
    }
    const updated = await this.prisma.valePass.findUniqueOrThrow({ where: { id: target.id } });

    await this.prisma.valePassEvent.create({ data: { valePassId: target.id, type: 'CANCELLED', detail: { actorId, reason } } });
    await writeAdminAuditEvent(this.prisma, {
      adminUserId: actorId,
      adminUserName: actorName,
      action: 'VALE_PASS_CANCELLED_BY_ADMIN',
      entityType: 'ValePass',
      entityId: target.id,
      before: { status: target.status },
      after: { status: 'CANCELLED' },
      detail: { code: target.code, reason },
    });

    return this.toItemFresh(updated);
  }

  /**
   * Restaura um Valle Pass CANCELADO pra ACTIVE — item novo do pedido:
   * "permitir restauração segura quando for permitido pelas regras do
   * sistema". Nenhum status novo: ACTIVE já existe, é literalmente o
   * status de antes do cancelamento, só reaberto pela mesma máquina.
   *
   * Elegível SOMENTE se, simultaneamente:
   *  - status atual é CANCELLED;
   *  - nunca foi utilizado (`usedAt` nulo — CANCELLED só é alcançado a
   *    partir de ACTIVE hoje, então isto é defesa em profundidade, não
   *    um caminho que hoje existe);
   *  - ainda não expirou (`expiresAt` no futuro) — se já expirou,
   *    restaurar reabriria um crédito que a próxima leitura reverteria
   *    pra EXPIRED sozinha; a regra exige recusar aqui, não reabrir e
   *    deixar expirar nesse mesmo instante;
   *  - foi cancelado por um ADMIN (`cancelledBy` preenchido) — cancelado
   *    pelo webhook (`orders/cancelled`/`refunds/create`, `cancelledBy`
   *    nulo) é uma operação irreversível: o pedido foi cancelado/
   *    reembolsado de verdade na Shopify, a fonte de verdade comercial,
   *    e não pode ser desfeita por aqui;
   *  - nenhum OUTRO vale do MESMO pedido Shopify foi cancelado pelo
   *    webhook — sinal de que o pedido inteiro foi cancelado/reembolsado
   *    mesmo que ESTE vale específico já estivesse cancelado por um
   *    admin antes disso acontecer (conflito com o pedido).
   */
  async restore(code: string, reason: string, actorId: string, actorName: string): Promise<ValePassVoucherItem> {
    await this.expireStale();
    const target = await this.requireByCode(code);
    await this.assertRestorable(target);

    // UPDATE condicional (mesmo padrão de markUsed/cancel): status no
    // WHERE, então duplo clique ou duas abas restaurando ao mesmo tempo
    // só uma grava — a outra recebe count!==1 e vira 409, nunca dois
    // eventos/duas auditorias pro mesmo vale.
    let changed;
    try {
      changed = await this.prisma.valePass.updateMany({
        where: { id: target.id, status: 'CANCELLED' },
        // Nunca apaga histórico: cancelledAt/cancelledBy/cancelReason
        // são limpos da linha ATUAL (ela volta a representar um vale
        // ativo, sem residual de cancelamento), mas o valor anterior vai
        // pro detail do evento/auditoria abaixo, pra sempre — mesmo
        // padrão de ReservationArchiveService.restore (archivedAt/
        // archivedBy/archiveReason limpos, motivo anterior no evento).
        data: { status: 'ACTIVE', cancelledAt: null, cancelledBy: null, cancelReason: null },
      });
    } catch (err) {
      this.logger.error(`Falha ao restaurar Valle Pass ${target.id}: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível restaurar o Valle Pass no momento.');
    }
    if (changed.count !== 1) {
      throw new ConflictException('O status deste Valle Pass mudou durante a operação — recarregue a tela e confira antes de tentar de novo.');
    }
    const updated = await this.prisma.valePass.findUniqueOrThrow({ where: { id: target.id } });

    await this.prisma.valePassEvent.create({
      data: {
        valePassId: target.id,
        type: 'RESTORED',
        detail: { actorId, reason, previousCancelledAt: target.cancelledAt?.toISOString() ?? null, previousCancelledBy: target.cancelledBy, previousCancelReason: target.cancelReason },
      },
    });
    await writeAdminAuditEvent(this.prisma, {
      adminUserId: actorId,
      adminUserName: actorName,
      action: 'VALE_PASS_RESTORED',
      entityType: 'ValePass',
      entityId: target.id,
      before: { status: target.status, cancelledAt: target.cancelledAt, cancelledBy: target.cancelledBy, cancelReason: target.cancelReason },
      after: { status: 'ACTIVE' },
      detail: { code: target.code, reason },
    });

    return this.toItemFresh(updated);
  }

  /** Mesmas checagens que `list()`/`findByCode()` já reportam como
   *  `canBeRestored`/`restoreBlockedReason` — repetidas aqui porque a
   *  decisão que TRAVA a operação nunca pode depender só do que a tela
   *  mostrou antes do clique (pode estar desatualizado). */
  private async assertRestorable(target: ValePass): Promise<void> {
    if (target.status !== 'CANCELLED') {
      throw new BadRequestException(`Este Valle Pass não pode ser restaurado — status atual: ${STATUS_LABELS[target.status]}.`);
    }
    if (target.usedAt) {
      throw new ConflictException('Este Valle Pass já foi utilizado e não pode ser restaurado.');
    }
    if (target.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Este Valle Pass já expirou. Restaurar um vale cancelado não reabre a validade — isso exige uma ação separada e explícita.');
    }
    if (!target.cancelledBy) {
      throw new ConflictException('Este Valle Pass foi cancelado automaticamente por um cancelamento ou reembolso do pedido na Shopify — não pode ser restaurado por aqui.');
    }
    if (target.shopifyOrderId) {
      const conflictingSibling = await this.prisma.valePass.findFirst({
        where: { shopifyOrderId: target.shopifyOrderId, status: 'CANCELLED', cancelledBy: null, id: { not: target.id } },
        select: { id: true },
      });
      if (conflictingSibling) {
        throw new ConflictException('O pedido Shopify deste Valle Pass foi cancelado ou reembolsado — não é possível restaurar.');
      }
    }
  }

  /** Pedidos com ao menos um vale cancelado pelo WEBHOOK (`cancelledBy`
   *  nulo) — usado só pra reportar `restoreBlockedReason` em lote em
   *  `list()`/`findByCode()`. Uma consulta só, nunca N+1. */
  private async loadAutoCancelledOrderIds(): Promise<ReadonlySet<string>> {
    const rows = await this.prisma.valePass.findMany({
      where: { status: 'CANCELLED', cancelledBy: null, shopifyOrderId: { not: null } },
      select: { shopifyOrderId: true },
      distinct: ['shopifyOrderId'],
    });
    return new Set(rows.map((r) => r.shopifyOrderId as string));
  }

  private async toItemFresh(row: ValePass): Promise<ValePassVoucherItem> {
    const [campaign, autoCancelledOrderIds] = await Promise.all([
      this.prisma.valePassCampaign.findUniqueOrThrow({ where: { id: row.campaignId }, select: { name: true } }),
      this.loadAutoCancelledOrderIds(),
    ]);
    return toItem(row, campaign.name, autoCancelledOrderIds);
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

/** Mesmas regras de `ValePassVouchersService.assertRestorable`, versão
 *  só-leitura (sem consulta extra por linha — `autoCancelledOrderIds` já
 *  vem carregado em lote) pra reportar o motivo antes de qualquer clique. */
function restoreEligibility(row: ValePass, autoCancelledOrderIds: ReadonlySet<string>): { canBeRestored: boolean; restoreBlockedReason: string | null } {
  if (row.status !== 'CANCELLED') return { canBeRestored: false, restoreBlockedReason: null };
  if (row.usedAt) return { canBeRestored: false, restoreBlockedReason: 'Já foi utilizado.' };
  if (row.expiresAt.getTime() <= Date.now()) return { canBeRestored: false, restoreBlockedReason: 'A validade já expirou.' };
  if (!row.cancelledBy) return { canBeRestored: false, restoreBlockedReason: 'Cancelado automaticamente por um cancelamento/reembolso do pedido na Shopify.' };
  if (row.shopifyOrderId && autoCancelledOrderIds.has(row.shopifyOrderId)) {
    return { canBeRestored: false, restoreBlockedReason: 'O pedido Shopify deste vale foi cancelado ou reembolsado.' };
  }
  return { canBeRestored: true, restoreBlockedReason: null };
}

function toItem(row: ValePass, campaignName: string, autoCancelledOrderIds: ReadonlySet<string>): ValePassVoucherItem {
  const { canBeRestored, restoreBlockedReason } = restoreEligibility(row, autoCancelledOrderIds);
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
