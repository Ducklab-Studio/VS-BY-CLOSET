import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { AdminRole, Prisma, ValePass, ValePassStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import { ledgerRefusal } from './ledger/ledger-errors';
import { maskCode } from './vale-pass-code-mask';
import { lockShopifyOrder } from '../webhooks/shopify-order-lock';
import { authorizeCompany } from './ledger/operator-scope.service';
import { configuredCapacityLimit, loadCapacity } from './vale-pass-capacity';
import { assertNotTestCampaignVoucher } from './vale-pass-test-campaign';

export interface ValePassVoucherItem {
  readonly id: string;
  readonly code: string;
  readonly campaignId: string;
  readonly campaignName: string;
  readonly amountCents: number;
  readonly status: ValePassStatus;
  /** Empresa onde ESTE voucher vale (crédito exclusivo; nunca se usa na outra). `null` = voucher legado, sem empresa. */
  readonly company: 'VALLE_SHOWROOM' | 'VS_BY_CLOSET' | null;
  /** Liga os vouchers da mesma unidade comercial (um Valle Pass = 2 vouchers). `null` = legado. */
  readonly groupId: string | null;
  /** Nome do benefício que originou o voucher (ex.: "Voucher Valle Showroom"). */
  readonly benefitLabel: string | null;
  readonly purchasedAt: string;
  /** Primeiro instante de uso. `null` = vale desde a emissão (legado). */
  readonly validFrom: string | null;
  readonly expiresAt: string;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly customerEmail: string | null;
  readonly shopifyOrderId: string | null;
  readonly shopifyOrderName: string | null;
  readonly usedAt: string | null;
  /** Saldo disponível (centavos). Voucher legado (sem empresa) não tem controle de saldo: vale o valor inteiro enquanto ACTIVE. */
  readonly balanceCents: number;
  /** Quanto já foi utilizado (valor − saldo). Sempre derivável do livro-razão. */
  readonly usedCents: number;
  readonly blockedAt: string | null;
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
      include: { campaign: { select: { name: true } }, benefit: { select: { label: true } } },
      orderBy: { purchasedAt: 'desc' },
      take: 200,
    });
    const cancelledOrderIds = await loadCancelledOrderIds(this.prisma, rows);
    return rows.map((row) => toItem(row, row.campaign.name, cancelledOrderIds, row.benefit?.label ?? null));
  }

  async findByCode(code: string): Promise<ValePassVoucherItem> {
    await this.expireStale();
    return this.toItemFresh(await this.requireByCode(code));
  }

  async markUsed(code: string, actorId: string, actorName: string, options: { role?: AdminRole } = {}): Promise<ValePassVoucherItem> {
    const updated = await this.inVoucherTransaction(code, 'Não foi possível marcar o Valle Pass como utilizado no momento.', async (tx, target) => {
      // Campanha de TESTE: sem valor comercial; o uso (por qualquer papel) é recusado. Cancelar continua permitido.
      await assertNotTestCampaignVoucher(tx, target);
      if (target.blockedAt) throw new ConflictException('Este Valle Pass está bloqueado administrativamente — o resgate está indisponível.');
      if (target.status !== 'ACTIVE') {
        throw new BadRequestException(`Este Valle Pass não pode ser utilizado — status atual: ${STATUS_LABELS[target.status]}.`);
      }
      // Voucher com início de uso (ex.: 01/01/2027): antes disso não pode ser usado. Legado (sem início) vale desde a emissão.
      if (target.validFrom && target.validFrom.getTime() > Date.now()) {
        throw new BadRequestException(`Este Valle Pass só pode ser utilizado a partir de ${target.validFrom.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`);
      }
      // ACTIVE com pedido cancelado/reembolsado não nasce mais (o webhook
      // cancela os ativos na mesma transação em que registra o pedido); só
      // pode vir de dado legado restaurado antes desta regra existir.
      if (target.shopifyOrderId && (await isOrderCancelled(tx, target.shopifyOrderId))) {
        throw new ConflictException('O pedido Shopify deste Valle Pass foi cancelado ou reembolsado — o vale não pode ser utilizado.');
      }

      // Unidade em revisão de reembolso (NEEDS_REVIEW) — ou revisão SEM unidade identificada, que vale para o pedido todo: o resgate fica bloqueado até um ADMIN decidir. Lido sob o MESMO lock do pedido que o reembolso toma,
      // então uso e reembolso nunca se cruzam. Sem linhas na trilha de reembolsos, nunca bloqueia.
      if (target.shopifyOrderId && target.groupId) {
        const blocking = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM vale_pass_refund_applications
          WHERE shopify_order_id = ${target.shopifyOrderId} AND status = 'NEEDS_REVIEW'
            AND (detail->'reviewGroupIds' @> to_jsonb(${target.groupId}::text) OR jsonb_array_length(coalesce(detail->'reviewGroupIds', '[]'::jsonb)) = 0)
          LIMIT 1`;
        if (blocking.length > 0) {
          throw new ConflictException('Este Valle Pass pertence a um pedido com reembolso aguardando decisão de um administrador — o resgate está bloqueado até a decisão.');
        }
      }

      if (target.company !== null) {
        // Mesmo isolamento por estabelecimento do resgate por saldo (este endpoint antigo NÃO é um atalho entre lojas): o caminho HTTP sempre informa o papel;
        // quem não está autorizado na empresa DESTE voucher não o consome por aqui. Chamadas internas sem papel não passam por esta checagem.
        // Funcionário (STAFF) resgata só pelo fluxo com prévia e valor redigitado (`/redeem`); o "usado" por inteiro, sem essa confirmação, segue exclusivo de administrador.
        if (options.role === 'STAFF') throw new ForbiddenException('Funcionários registram o resgate pelo saldo (informando o valor). A marcação "usado" por inteiro exige um administrador.');
        if (options.role !== undefined) await authorizeCompany(tx, { id: actorId, role: options.role }, target.company);
        // Voucher do modelo novo (com empresa) controla SALDO: "marcar como usado" é o resgate INTEGRAL do que resta, e só vale para voucher ainda NÃO tocado
        // (utilização parcial se registra pelo valor). Passa pelo livro-razão — o banco recusa qualquer outro caminho para USED.
        if (target.balanceCents !== target.amountCents || target.balanceCents <= 0) {
          throw new ConflictException('Este voucher já teve utilização parcial: registre o resgate pelo valor utilizado. A marcação "usado" por inteiro só vale para voucher ainda não utilizado.');
        }
        try {
          await tx.valePassLedgerEntry.create({
            data: {
              valePassId: target.id, seq: 1, balanceAfterCents: 0, // seq e saldo resultante são calculados pelo gatilho do banco
              kind: 'REDEEM', deltaCents: -target.balanceCents, actorAdminId: actorId, actorName,
              reason: 'Uso integral (marcação de utilizado)', reference: 'LEGACY_USE_ENDPOINT', idempotencyKey: `use-all:${target.id}`,
            },
          });
        } catch (err) {
          throw ledgerRefusal(err) ?? err;
        }
      } else {
        // Legado (sem empresa): tudo ou nada, como sempre. Status no WHERE + contagem: dois resgates simultâneos do mesmo código nunca gravam USED os dois.
        const changed = await tx.valePass.updateMany({
          where: { id: target.id, status: 'ACTIVE' },
          data: { status: 'USED', usedAt: new Date(), usedBy: actorId },
        });
        if (changed.count !== 1) throw new ConflictException(STATUS_CHANGED_MESSAGE);
      }

      await tx.valePassEvent.create({ data: { valePassId: target.id, type: 'USED', detail: { actorId } } });
      await writeAdminAuditEvent(tx, {
        adminUserId: actorId,
        adminUserName: actorName,
        action: 'VALE_PASS_MARKED_USED',
        entityType: 'ValePass',
        entityId: target.id,
        before: { status: target.status },
        after: { status: 'USED' },
        detail: { code: maskCode(target.code) },
      });
      return tx.valePass.findUniqueOrThrow({ where: { id: target.id } });
    });
    return this.toItemFresh(updated);
  }

  async cancel(code: string, reason: string, actorId: string, actorName: string): Promise<ValePassVoucherItem> {
    const updated = await this.inVoucherTransaction(code, 'Não foi possível cancelar o Valle Pass no momento.', async (tx, target) => {
      if (target.status === 'USED') throw new ConflictException('Este Valle Pass já foi utilizado — não pode ser cancelado.');
      // Utilização parcial = voucher "tocado": cancelar apagaria o saldo restante do cliente sem a decisão (reembolso/exceção) que ainda não existe.
      if (target.company !== null && target.balanceCents < target.amountCents) {
        throw new ConflictException('Este voucher já teve utilização parcial — não pode ser cancelado por aqui. Trate pela revisão de reembolso ou pela decisão de um administrador.');
      }
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
        detail: { code: maskCode(target.code), reason },
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
          detail: { code: maskCode(target.code), reason, blockedBy: 'shopify_order_cancelled' },
        });
        return { blocked: new ConflictException(block.message) };
      }
      if (block) throw block.error;

      // inVoucherTransaction já trava campanha antes dos vouchers, como a prorrogação coletiva.
      // Reativar uma unidade cancelada volta a ocupar capacidade.
      const campaign = await tx.valePassCampaign.findUniqueOrThrow({ where: { id: target.campaignId }, select: { globalLimit: true, quantityLimit: true, benefits: { select: { id: true }, take: 1 } } });
      const capacityLimit = configuredCapacityLimit(campaign.globalLimit, campaign.quantityLimit);
      const siblings = target.groupId
        ? await tx.valePass.count({ where: { campaignId: target.campaignId, groupId: target.groupId, id: { not: target.id }, status: { not: 'CANCELLED' } } })
        : 0;
      if (campaign.benefits.length > 0 && capacityLimit === null) {
        const message = 'A restauração está bloqueada: a campanha com benefícios não tem limite de capacidade configurado.';
        await tx.valePassEvent.create({ data: { valePassId: target.id, type: 'RESTORE_BLOCKED', detail: { actorId, reason, blockedBy: 'capacity_limit_unconfigured' } } });
        await writeAdminAuditEvent(tx, {
          adminUserId: actorId,
          adminUserName: actorName,
          action: 'VALE_PASS_RESTORE_BLOCKED',
          entityType: 'ValePass',
          entityId: target.id,
          before: { status: target.status },
          detail: { code: maskCode(target.code), reason, blockedBy: 'capacity_limit_unconfigured' },
        });
        return { blocked: new ConflictException(message) };
      }
      if (siblings === 0 && capacityLimit !== null) {
        const { totals } = await loadCapacity(tx, target.campaignId);
        if (totals.consumed >= capacityLimit) {
          const message = `A restauração ultrapassaria o teto configurado da campanha (${capacityLimit}). O voucher continua cancelado.`;
          await tx.valePassEvent.create({ data: { valePassId: target.id, type: 'RESTORE_BLOCKED', detail: { actorId, reason, blockedBy: 'capacity_limit', capacityLimit, consumed: totals.consumed } } });
          await writeAdminAuditEvent(tx, {
            adminUserId: actorId,
            adminUserName: actorName,
            action: 'VALE_PASS_RESTORE_BLOCKED',
            entityType: 'ValePass',
            entityId: target.id,
            before: { status: target.status },
            detail: { code: maskCode(target.code), reason, blockedBy: 'capacity_limit', capacityLimit, consumed: totals.consumed },
          });
          return { blocked: new ConflictException(message) };
        }
      }

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
        detail: { code: maskCode(target.code), reason },
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
        // Ordem comum: pedido Shopify → campanha → voucher. A prorrogação coletiva usa campanha → vouchers;
        // travar a campanha antes da linha evita ciclo entre restauração e prorrogação.
        if (located.shopifyOrderId) await lockShopifyOrder(tx, located.shopifyOrderId);
        await tx.$queryRaw`SELECT id FROM vale_pass_campaigns WHERE id = ${located.campaignId}::uuid FOR UPDATE`;
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
    const [campaign, cancelledOrderIds, benefit] = await Promise.all([
      this.prisma.valePassCampaign.findUniqueOrThrow({ where: { id: row.campaignId }, select: { name: true } }),
      loadCancelledOrderIds(this.prisma, [row]),
      row.benefitId ? this.prisma.valePassCampaignBenefit.findUnique({ where: { id: row.benefitId }, select: { label: true } }) : Promise.resolve(null),
    ]);
    return toItem(row, campaign.name, cancelledOrderIds, benefit?.label ?? null);
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

function toItem(row: ValePass, campaignName: string, cancelledOrderIds: ReadonlySet<string>, benefitLabel: string | null = null): ValePassVoucherItem {
  const { canBeRestored, restoreBlockedReason } = restoreEligibility(row, cancelledOrderIds);
  return {
    id: row.id,
    code: row.code,
    campaignId: row.campaignId,
    campaignName,
    amountCents: row.amountCents,
    status: row.status,
    company: row.company,
    groupId: row.groupId,
    benefitLabel,
    purchasedAt: row.purchasedAt.toISOString(),
    validFrom: row.validFrom?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    customerEmail: row.customerEmail,
    shopifyOrderId: row.shopifyOrderId,
    shopifyOrderName: row.shopifyOrderName,
    usedAt: row.usedAt?.toISOString() ?? null,
    balanceCents: row.balanceCents,
    usedCents: row.amountCents - row.balanceCents,
    blockedAt: row.blockedAt?.toISOString() ?? null,
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
