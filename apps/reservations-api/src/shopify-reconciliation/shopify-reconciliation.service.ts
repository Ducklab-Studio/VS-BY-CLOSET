import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { lockOperationalBlocks } from '../admin/operational-blocks';
import { ShopifyAdminClient, type ShopifyOrderState } from '../admin-panel/shopify-admin.client';
import { ShopifyOrderSyncService, type OrderSnapshot } from '../webhooks/shopify-order-sync.service';
import { ARCHIVABLE_TERMINAL_STATUSES, OCCUPYING_RESERVATION_STATUSES } from '../reservation-status';

export type DivergenceKind =
  | 'missing_in_shopify'
  | 'unverifiable_missing'
  | 'cancelled_in_shopify'
  | 'closed_in_shopify'
  | 'payment_failed_in_shopify'
  | 'paid_in_shopify_not_confirmed'
  | 'shopify_order_without_reservation';

export interface Divergence {
  readonly kind: DivergenceKind;
  readonly orderId: string;
  readonly orderName: string | null;
  readonly reservationId: string | null;
  readonly reservationStatus: string | null;
  readonly shopify: { readonly cancelled: boolean; readonly closed: boolean; readonly financialStatus: string | null } | null;
  /** Ação que o modo `apply` executa. `none` = só relatório. */
  readonly action: 'cancel' | 'archive' | 'expire' | 'none';
  readonly applied: boolean;
  readonly note: string;
}

export interface ReconciliationReport {
  readonly generatedAt: string;
  readonly windowDays: number;
  readonly mode: 'report' | 'apply';
  readonly checkedReservations: number;
  readonly checkedShopifyOrders: number;
  readonly truncated: boolean;
  readonly summary: Partial<Record<DivergenceKind, number>>;
  readonly divergences: readonly Divergence[];
}

const MAX_RESERVATIONS = 500;
const MAX_ORDERS = 500;
/** Sem `read_all_orders`, o app só enxerga ~60 dias; abaixo disso a ausência de um
 *  pedido significa "excluído", acima significa "fora do alcance da leitura". */
const VERIFIABLE_AGE_DAYS = 55;
/** Se TODOS os pedidos consultados voltarem vazios, é falha de acesso, não exclusão em massa. */
const MASS_MISSING_GUARD_MIN = 3;

const isOccupying = (status: string) => (OCCUPYING_RESERVATION_STATUSES as readonly string[]).includes(status);
const isArchivable = (status: string) => (ARCHIVABLE_TERMINAL_STATUSES as readonly string[]).includes(status);

/**
 * Reconciliação por Admin API (somente leitura na Shopify). É a rede de
 * segurança para o que os webhooks não cobrem com confiança — principalmente
 * arquivamento e exclusão: a Shopify não tem tópico de "pedido arquivado", e
 * `orders/delete` pode se perder. Compara reservas online vinculadas a pedidos
 * com o estado real do pedido e, em modo `apply`, aplica só o subconjunto seguro
 * pelas MESMAS regras dos webhooks (ShopifyOrderSyncService).
 */
@Injectable()
export class ShopifyReconciliationService {
  private readonly logger = new Logger(ShopifyReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopify: ShopifyAdminClient,
    private readonly sync: ShopifyOrderSyncService,
  ) {}

  async reconcile(options: { days: number; apply: boolean; actor?: { id: string; name: string }; orderIds?: readonly string[] }): Promise<ReconciliationReport> {
    const now = new Date();
    const since = new Date(now.getTime() - options.days * 86_400_000);

    const reservations = await this.prisma.reservation.findMany({
      where: { source: 'online', shopifyOrderId: options.orderIds ? { in: [...options.orderIds] } : { not: null }, archivedAt: null },
      orderBy: { createdAt: 'desc' },
      take: MAX_RESERVATIONS + 1,
      select: { id: true, status: true, shopifyOrderId: true, shopifyOrderGid: true, createdAt: true },
    });
    const truncatedReservations = reservations.length > MAX_RESERVATIONS;
    const checked = reservations.slice(0, MAX_RESERVATIONS);

    const gidOf = (r: { shopifyOrderId: string | null; shopifyOrderGid: string | null }) => r.shopifyOrderGid ?? `gid://shopify/Order/${r.shopifyOrderId}`;
    const states = await this.shopify.getOrdersByGid(checked.map(gidOf));
    const missingCount = checked.filter((r) => (states.get(gidOf(r)) ?? null) === null).length;
    const massMissing = checked.length >= MASS_MISSING_GUARD_MIN && missingCount === checked.length;

    const divergences: Divergence[] = [];
    const applicable: { index: number; snapshot: OrderSnapshot }[] = [];

    for (const reservation of checked) {
      const orderId = reservation.shopifyOrderId as string;
      const state = states.get(gidOf(reservation)) ?? null;
      const ageDays = (now.getTime() - reservation.createdAt.getTime()) / 86_400_000;

      if (!state) {
        const verifiable = ageDays <= VERIFIABLE_AGE_DAYS && !massMissing;
        divergences.push({
          kind: verifiable ? 'missing_in_shopify' : 'unverifiable_missing',
          orderId,
          orderName: null,
          reservationId: reservation.id,
          reservationStatus: reservation.status,
          shopify: null,
          action: verifiable ? 'archive' : 'none',
          applied: false,
          note: verifiable
            ? 'pedido não existe mais na Shopify; a reserva é cancelada (se possível) e arquivada, sem apagar dados'
            : 'pedido não retornado, mas fora da janela de leitura ou todos vieram vazios — não tratado como exclusão',
        });
        if (verifiable) applicable.push({ index: divergences.length - 1, snapshot: { orderId, updatedAt: null, cancelledAt: null, closedAt: null, financialStatus: null, deleted: true } });
        continue;
      }

      const divergence = this.classify(reservation, state);
      if (!divergence) continue;
      divergences.push({ ...divergence, applied: false });
      if (divergence.action !== 'none') {
        applicable.push({
          index: divergences.length - 1,
          snapshot: { orderId, updatedAt: new Date(state.updatedAt), cancelledAt: state.cancelledAt, closedAt: state.closedAt, financialStatus: state.financialStatus },
        });
      }
    }

    // Escopo por pedido (uso interno/testes): não procura pedidos sem reserva.
    const recent = options.orderIds ? { orders: [] as ShopifyOrderState[], truncated: false } : await this.shopify.listOrdersCreatedSince(since.toISOString(), MAX_ORDERS);
    const candidates = recent.orders.filter((order) => order.reservationId && !order.cancelledAt);
    const linked = candidates.length
      ? new Set((await this.prisma.reservation.findMany({ where: { shopifyOrderId: { in: candidates.map((o) => o.orderId) } }, select: { shopifyOrderId: true } })).map((r) => r.shopifyOrderId))
      : new Set<string | null>();
    for (const order of candidates) {
      if (linked.has(order.orderId)) continue;
      divergences.push({
        kind: 'shopify_order_without_reservation',
        orderId: order.orderId,
        orderName: order.name,
        reservationId: order.reservationId,
        reservationStatus: null,
        shopify: { cancelled: false, closed: !!order.closedAt, financialStatus: order.financialStatus },
        action: 'none',
        applied: false,
        note: 'pedido com reservation_id sem reserva vinculada; requer análise manual (nada é criado automaticamente)',
      });
    }

    const result: Divergence[] = [...divergences];
    if (options.apply) {
      for (const item of applicable) {
        const applied = await this.applyOne(item.snapshot, options.actor);
        result[item.index] = { ...result[item.index], applied };
      }
    }

    const summary: Partial<Record<DivergenceKind, number>> = {};
    for (const d of result) summary[d.kind] = (summary[d.kind] ?? 0) + 1;
    return {
      generatedAt: now.toISOString(),
      windowDays: options.days,
      mode: options.apply ? 'apply' : 'report',
      checkedReservations: checked.length,
      checkedShopifyOrders: recent.orders.length,
      truncated: truncatedReservations || recent.truncated,
      summary,
      divergences: result,
    };
  }

  private classify(reservation: { id: string; status: string; shopifyOrderId: string | null }, state: ShopifyOrderState): Omit<Divergence, 'applied'> | null {
    const shopify = { cancelled: !!state.cancelledAt, closed: !!state.closedAt, financialStatus: state.financialStatus };
    const base = { orderId: reservation.shopifyOrderId as string, orderName: state.name, reservationId: reservation.id, reservationStatus: reservation.status, shopify };
    const status = reservation.status;

    if (state.cancelledAt && isOccupying(status)) {
      return { ...base, kind: 'cancelled_in_shopify', action: 'cancel', note: 'pedido cancelado na Shopify com reserva ainda ativa; peça já no ciclo físico vai para revisão' };
    }
    if ((state.financialStatus === 'voided' || state.financialStatus === 'expired') && (status === 'pending_payment' || status === 'confirmed')) {
      return {
        ...base,
        kind: 'payment_failed_in_shopify',
        action: 'expire',
        note: status === 'pending_payment' ? 'pagamento falho/expirado; a reserva expira e libera a peça' : 'pagamento anulado com reserva confirmada; vai para revisão',
      };
    }
    if (state.financialStatus === 'paid' && !state.cancelledAt && (status === 'pending_payment' || status === 'expired')) {
      return { ...base, kind: 'paid_in_shopify_not_confirmed', action: 'none', note: 'pedido pago na Shopify sem reserva confirmada; a confirmação segue o fluxo de webhook/pagamento tardio' };
    }
    if (state.closedAt && isArchivable(status)) {
      return { ...base, kind: 'closed_in_shopify', action: 'archive', note: 'pedido arquivado na Shopify; a reserva terminal é arquivada no ClosetAdmin' };
    }
    return null;
  }

  /** Uma transação por reserva, com o MESMO lock de pedido dos webhooks. */
  private async applyOne(snapshot: OrderSnapshot, actor?: { id: string; name: string }): Promise<boolean> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await lockOperationalBlocks(tx);
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'shopify-order:' + snapshot.orderId}))`;
          const reservation = await this.sync.findOnlineReservation(tx, snapshot.orderId);
          if (!reservation) return false;
          const events = await this.sync.applySnapshot(tx, reservation, snapshot, { origin: 'shopify_reconciliation', ...(actor ? { actor } : {}) });
          for (const event of events) {
            await tx.reservationEvent.create({
              data: { reservationId: event.reservationId ?? null, type: event.type, detail: (event.detail as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull },
            });
          }
          return events.some((event) => event.type === 'SHOPIFY_ORDER_SYNC');
        },
        { timeout: 15_000, maxWait: 5_000 },
      );
    } catch (err) {
      this.logger.error(`Falha ao aplicar reconciliação do pedido ${snapshot.orderId}: ${err instanceof Error ? err.name : 'unknown'}`);
      return false;
    }
  }
}
