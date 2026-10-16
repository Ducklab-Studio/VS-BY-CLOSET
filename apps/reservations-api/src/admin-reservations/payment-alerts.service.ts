import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  FLAGGED_RESERVATION_STATUSES,
  buildPaymentAlerts,
  isCustomerOrderSource,
  latestOrderStates,
  type FlaggedReservation,
  type LinkedReservation,
  type OrderState,
  type PaymentAlertsResult,
} from './payment-alerts';

/** Janela de pedidos considerados (dias). Mais antigo que isto já foi visto por alguém ou perdeu o sentido. */
export const PAYMENT_ALERTS_WINDOW_DAYS = 30;
/** Teto de eventos de pedido lidos por consulta: protege o banco mesmo que a tabela cresça. */
const ORDER_EVENTS_LIMIT = 3000;
/** O menu consulta a cada ~30 s por aba aberta: respostas iguais dentro deste prazo reaproveitam a leitura. */
const DEFAULT_CACHE_TTL_MS = 15_000;

interface OrderEventRow {
  orderId: string;
  name: string | null;
  financialStatus: string | null;
  cancelledAt: string | null;
  test: string | null;
  sourceName: string | null;
  totalPrice: string | null;
  currency: string | null;
  refundsCount: number | bigint | null;
  updatedAt: string | null;
  createdAt: string | null;
  processedAt: Date;
}

/**
 * Alertas financeiros do ClosetAdmin (Fase 2a). SOMENTE LEITURA: não escreve em nenhuma tabela, não confirma,
 * não cancela, não libera peça e não reembolsa. As regras estão em `payment-alerts.ts`.
 *
 * Origem dos dados: os webhooks de pedido já gravados (`webhook_events`, só campos não pessoais extraídos do
 * JSON), as reservas, `vale_pass_orders` (para excluir Valle Pass). Sem migração, sem tabela nova.
 */
@Injectable()
export class PaymentAlertsService {
  private readonly logger = new Logger(PaymentAlertsService.name);
  private cache: { at: number; value: PaymentAlertsResult } | null = null;
  /** Mutável só para os testes (0 = sem reaproveitar leitura). */
  cacheTtlMs = DEFAULT_CACHE_TTL_MS;

  constructor(private readonly prisma: PrismaService) {}

  async list(options: { windowDays?: number; limit?: number; fresh?: boolean } = {}): Promise<PaymentAlertsResult> {
    const useCache = !options.fresh && options.windowDays === undefined && options.limit === undefined && this.cacheTtlMs > 0;
    if (useCache && this.cache && Date.now() - this.cache.at < this.cacheTtlMs) return this.cache.value;
    try {
      const value = await this.compute(options.windowDays ?? PAYMENT_ALERTS_WINDOW_DAYS, options.limit);
      if (useCache) this.cache = { at: Date.now(), value };
      return value;
    } catch (err) {
      this.logger.error(`Falha ao calcular alertas de pagamento: ${err instanceof Error ? err.name : 'unknown'}`);
      throw new ServiceUnavailableException('Não foi possível verificar os pagamentos a tratar no momento.');
    }
  }

  async count(): Promise<{ count: number }> {
    return { count: (await this.list()).count };
  }

  private async compute(windowDays: number, limit?: number): Promise<PaymentAlertsResult> {
    const days = Math.min(Math.max(Math.floor(windowDays), 1), 90);

    // 1) Eventos de pedido recentes — só campos não pessoais, extraídos no banco. Sem índice novo: o filtro por tópico +
    //    janela de tempo + LIMIT mantém a leitura pequena.
    const rows = await this.prisma.$queryRaw<OrderEventRow[]>`
      SELECT order_id AS "orderId",
             payload->>'name' AS "name",
             payload->>'financial_status' AS "financialStatus",
             payload->>'cancelled_at' AS "cancelledAt",
             payload->>'test' AS "test",
             payload->>'source_name' AS "sourceName",
             payload->>'total_price' AS "totalPrice",
             COALESCE(payload->>'presentment_currency', payload->>'currency') AS "currency",
             CASE WHEN jsonb_typeof(payload->'refunds') = 'array' THEN jsonb_array_length(payload->'refunds') ELSE 0 END AS "refundsCount",
             payload->>'updated_at' AS "updatedAt",
             payload->>'created_at' AS "createdAt",
             processed_at AS "processedAt"
      FROM webhook_events
      WHERE topic IN ('orders/create', 'orders/paid', 'orders/updated', 'orders/cancelled')
        AND status <> 'failed'
        AND order_id IS NOT NULL
        AND processed_at > now() - make_interval(days => ${days}::int)
      ORDER BY processed_at DESC
      LIMIT ${ORDER_EVENTS_LIMIT}
    `;
    const orders = latestOrderStates(rows.map(toOrderState));

    // 2) Pedidos tratados por outro caminho: reembolso criado ou pedido excluído na Shopify.
    const settledRows = await this.prisma.$queryRaw<{ orderId: string; topic: string }[]>`
      SELECT DISTINCT order_id AS "orderId", topic
      FROM webhook_events
      WHERE topic IN ('refunds/create', 'orders/delete')
        AND status <> 'failed'
        AND order_id IS NOT NULL
        AND processed_at > now() - make_interval(days => ${days}::int)
    `;
    const settledOrderIds = new Set(settledRows.filter((row) => row.topic === 'refunds/create').map((row) => row.orderId));
    const deletedOrderIds = new Set(settledRows.filter((row) => row.topic === 'orders/delete').map((row) => row.orderId));

    // 3) Só os pedidos pagos de cliente precisam de contexto (Valle Pass e reserva vinculada).
    const candidateIds = [...orders.values()]
      .filter((order) => (order.financialStatus ?? '').toLowerCase() === 'paid' && !order.test && isCustomerOrderSource(order.sourceName))
      .map((order) => order.orderId);

    const [valePass, linked, flagged] = await Promise.all([
      candidateIds.length > 0
        ? this.prisma.valePassOrder.findMany({ where: { shopifyOrderId: { in: candidateIds } }, select: { shopifyOrderId: true } })
        : Promise.resolve([]),
      candidateIds.length > 0
        ? this.prisma.reservation.findMany({
            where: { shopifyOrderId: { in: candidateIds }, source: 'online' },
            select: { id: true, status: true, shopifyOrderId: true },
          })
        : Promise.resolve([]),
      this.prisma.reservation.findMany({
        where: { status: { in: [...FLAGGED_RESERVATION_STATUSES] }, archivedAt: null },
        select: { id: true, status: true, shopifyOrderId: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      }),
    ]);

    const reservationsByOrder = new Map<string, LinkedReservation>();
    for (const reservation of linked) if (reservation.shopifyOrderId) reservationsByOrder.set(reservation.shopifyOrderId, reservation);

    // Reservas sinalizadas cujo pedido está fora da janela: busca o estado do pedido só para elas (poucas linhas).
    const missing = flagged.map((r) => r.shopifyOrderId).filter((id): id is string => !!id && !orders.has(id));
    if (missing.length > 0) {
      const extra = await this.prisma.$queryRaw<OrderEventRow[]>`
        SELECT order_id AS "orderId", payload->>'name' AS "name", payload->>'financial_status' AS "financialStatus",
               payload->>'cancelled_at' AS "cancelledAt", payload->>'test' AS "test", payload->>'source_name' AS "sourceName",
               payload->>'total_price' AS "totalPrice", COALESCE(payload->>'presentment_currency', payload->>'currency') AS "currency",
               CASE WHEN jsonb_typeof(payload->'refunds') = 'array' THEN jsonb_array_length(payload->'refunds') ELSE 0 END AS "refundsCount",
               payload->>'updated_at' AS "updatedAt", payload->>'created_at' AS "createdAt", processed_at AS "processedAt"
        FROM webhook_events
        WHERE topic IN ('orders/create', 'orders/paid', 'orders/updated', 'orders/cancelled') AND status <> 'failed' AND order_id = ANY(${missing}::text[])
        ORDER BY processed_at DESC
        LIMIT 200
      `;
      for (const [id, state] of latestOrderStates(extra.map(toOrderState))) orders.set(id, state);
      const extraSettled = await this.prisma.$queryRaw<{ orderId: string; topic: string }[]>`
        SELECT DISTINCT order_id AS "orderId", topic FROM webhook_events
        WHERE topic IN ('refunds/create', 'orders/delete') AND status <> 'failed' AND order_id = ANY(${missing}::text[])
      `;
      for (const row of extraSettled) (row.topic === 'refunds/create' ? settledOrderIds : deletedOrderIds).add(row.orderId);
    }

    return buildPaymentAlerts({
      orders,
      settledOrderIds,
      deletedOrderIds,
      valePassOrderIds: new Set(valePass.map((v) => v.shopifyOrderId)),
      reservationsByOrder,
      flaggedReservations: flagged as FlaggedReservation[],
      limit,
    });
  }
}

function toOrderState(row: OrderEventRow): OrderState {
  return {
    orderId: row.orderId,
    name: row.name,
    financialStatus: row.financialStatus,
    cancelledAt: row.cancelledAt,
    test: row.test === 'true',
    sourceName: row.sourceName,
    totalPrice: row.totalPrice,
    currency: row.currency,
    refundsCount: Number(row.refundsCount ?? 0),
    updatedAt: parseDate(row.updatedAt),
    createdAt: parseDate(row.createdAt),
    processedAt: row.processedAt,
  };
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
