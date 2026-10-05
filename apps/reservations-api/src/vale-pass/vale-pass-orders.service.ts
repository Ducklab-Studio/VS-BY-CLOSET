import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, ValePassOrderStatus, ValePassStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ShopifyAdminClient, type ShopifyOrderWithLines } from '../admin-panel/shopify-admin.client';
import { lockShopifyOrder } from '../webhooks/shopify-order-lock';
import type { ShopifyOrderPayload } from '../webhooks/shopify-order-payload';
import { ATTENTION_STATUSES, needsAttention, valePassUnits } from './vale-pass-order-status';
import type { ValePassOrderSnapshot } from './vale-pass-order-registry';
import { ValePassWebhookService } from './vale-pass-webhook.service';

export const DEFAULT_RECONCILE_WINDOW_DAYS = 30;
const MAX_RECONCILE_WINDOW_DAYS = 60;
/** 50 páginas × 10 pedidos: bem acima do volume da loja; passou disso, `truncated`. */
const MAX_PAGES = 50;
const MAX_OPEN_ORDERS = 500;
/** Sem `read_all_orders`, o app só enxerga ~60 dias: mais antigo que isso, a
 *  ausência do pedido não significa exclusão (mesma regra das reservas). */
const VERIFIABLE_AGE_DAYS = 55;
/** Se TODOS os pedidos consultados voltarem vazios, é falha de acesso, não exclusão em massa. */
const MASS_MISSING_GUARD_MIN = 3;

export interface ValePassOrderItem {
  readonly id: string;
  readonly shopifyOrderId: string;
  readonly shopifyOrderName: string | null;
  readonly status: ValePassOrderStatus;
  readonly financialStatus: string | null;
  readonly cancelReason: string | null;
  readonly quantity: number;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly customerEmail: string | null;
  readonly orderCreatedAt: string | null;
  readonly statusChangedAt: string;
  readonly deletedInShopifyAt: string | null;
  /** Conta no contador do menu (ver `needsAttention`). */
  readonly needsAttention: boolean;
  readonly vouchers: readonly { readonly code: string; readonly status: ValePassStatus }[];
}

export interface ValePassOrderReconciliationReport {
  readonly generatedAt: string;
  readonly windowDays: number;
  readonly checkedShopifyOrders: number;
  readonly valePassOrders: number;
  readonly created: number;
  readonly statusChanged: number;
  readonly unchanged: number;
  readonly stale: number;
  readonly vouchersRecovered: number;
  /** Pedido do registro que a Shopify não devolveu. */
  readonly notFound: number;
  /** Desses, os registrados agora como excluídos na Shopify (pedido recente,
   *  dentro do alcance da leitura, e consulta que não voltou toda vazia). O
   *  resto (fora do alcance ou falha de acesso) fica como está. */
  readonly deleted: number;
  readonly failed: number;
  readonly truncated: boolean;
}

/**
 * Pedidos de Valle Pass no ClosetAdmin: listagem e reconciliação com a
 * Shopify (Admin API, somente leitura). A reconciliação é a rede de segurança
 * dos webhooks: pedido criado, pago, expirado ou cancelado cujo webhook se
 * perdeu aparece mesmo assim. Aplica as MESMAS regras do webhook
 * (ValePassOrderRegistry), com o MESMO lock por pedido — nunca duplica, nunca
 * apaga, nunca volta um status por causa de dado mais antigo.
 */
@Injectable()
export class ValePassOrdersService {
  private readonly logger = new Logger(ValePassOrdersService.name);
  private inFlight: Promise<ValePassOrderReconciliationReport> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopify: ShopifyAdminClient,
    private readonly valePass: ValePassWebhookService,
  ) {}

  /** Pedido excluído na Shopify sai da lista padrão; `includeDeleted` o traz de
   *  volta (filtro "Mostrar excluídos da Shopify"), com o histórico intacto. */
  async list(filters: { status?: ValePassOrderStatus; limit?: number; includeDeleted?: boolean } = {}): Promise<ValePassOrderItem[]> {
    const rows = await this.prisma.valePassOrder.findMany({
      where: { ...(filters.status ? { status: filters.status } : {}), ...(filters.includeDeleted ? {} : { deletedInShopifyAt: null }) },
      orderBy: [{ orderCreatedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: Math.min(Math.max(filters.limit ?? 100, 1), 300),
    });
    const vouchers = rows.length
      ? await this.prisma.valePass.findMany({
          where: { shopifyOrderId: { in: rows.map((row) => row.shopifyOrderId) } },
          orderBy: { createdAt: 'asc' },
          select: { shopifyOrderId: true, code: true, status: true },
        })
      : [];
    return rows.map((row) => ({
      id: row.id,
      shopifyOrderId: row.shopifyOrderId,
      shopifyOrderName: row.shopifyOrderName,
      status: row.status,
      financialStatus: row.financialStatus,
      cancelReason: row.cancelReason,
      quantity: row.quantity,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      customerEmail: row.customerEmail,
      orderCreatedAt: row.orderCreatedAt?.toISOString() ?? null,
      statusChangedAt: row.statusChangedAt.toISOString(),
      deletedInShopifyAt: row.deletedInShopifyAt?.toISOString() ?? null,
      needsAttention: !row.deletedInShopifyAt && needsAttention(row),
      vouchers: vouchers.filter((v) => v.shopifyOrderId === row.shopifyOrderId).map((v) => ({ code: v.code, status: v.status })),
    }));
  }

  /** Mesma regra de `needsAttention`, no banco (a listagem mostra só os 100 mais recentes). */
  private attentionWhere(): Prisma.ValePassOrderWhereInput {
    return {
      status: { in: [...ATTENTION_STATUSES] },
      // Fora da lista padrão, fora do contador.
      deletedInShopifyAt: null,
      OR: [{ viewedAt: null }, { viewedAt: { lt: this.prisma.valePassOrder.fields.statusChangedAt } }],
    };
  }

  /** Contador do menu: global para a equipe, só leitura. */
  async attentionCount(): Promise<{ count: number }> {
    return { count: await this.prisma.valePassOrder.count({ where: this.attentionWhere() }) };
  }

  /**
   * Marca como vistos os pedidos que a tela do Valle Pass EXIBIU. Só grava
   * `viewed_at`/`viewed_by` (nunca status, pagamento ou vale) e só se o
   * pedido ainda estiver no status que foi exibido: se mudou depois (ex.:
   * pagou enquanto a tela estava aberta), continua contando. Condicional no
   * próprio UPDATE — duas abas marcando juntas gravam uma vez só.
   */
  async markViewed(orders: readonly { id: string; statusChangedAt: string }[], actor: { id: string; name: string }): Promise<{ marked: number }> {
    const unique = [...new Map(orders.map((o) => [o.id, o])).values()];
    return this.prisma.$transaction(async (tx) => {
      let marked = 0;
      for (const order of unique) {
        const shown = new Date(order.statusChangedAt).getTime();
        if (!Number.isFinite(shown)) continue;
        const updated = await tx.valePassOrder.updateMany({
          // O ISO exibido tem milissegundos; o banco guarda microssegundos.
          where: { id: order.id, statusChangedAt: { lt: new Date(shown + 1) }, ...this.attentionWhere() },
          data: { viewedAt: new Date(), viewedBy: actor.id },
        });
        if (updated.count !== 1) continue;
        marked++;
        await tx.valePassOrderEvent.create({ data: { valePassOrderId: order.id, type: 'VIEWED', detail: { adminUserId: actor.id, adminUserName: actor.name } } });
      }
      return { marked };
    });
  }

  /** Uma rodada por processo: chamadas simultâneas recebem o mesmo resultado.
   *  Entre processos, o lock por pedido e o `shopify_order_id` único garantem
   *  que duas rodadas juntas nunca dupliquem nada. */
  reconcile(options: { days?: number; manual?: boolean } = {}): Promise<ValePassOrderReconciliationReport> {
    if (!this.inFlight) {
      this.inFlight = this.run(options).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async run(options: { days?: number; manual?: boolean }): Promise<ValePassOrderReconciliationReport> {
    const now = new Date();
    const windowDays = Math.min(Math.max(Math.floor(options.days ?? DEFAULT_RECONCILE_WINDOW_DAYS), 1), MAX_RECONCILE_WINDOW_DAYS);
    const since = new Date(now.getTime() - windowDays * 86_400_000);
    const source = options.manual ? 'reconciliation:manual' : 'reconciliation';

    const recent = await this.shopify.listOrdersWithLinesUpdatedSince(since.toISOString(), MAX_PAGES);
    const campaignVariantIds = (await this.prisma.valePassCampaign.findMany({ select: { shopifyVariantId: true } })).map((c) => c.shopifyVariantId);
    const units = (order: ShopifyOrderWithLines) => valePassUnits(order.lines, campaignVariantIds);

    // Só pedidos de Valle Pass — pedido de aluguel ou de outro produto nunca é importado.
    const candidates = new Map<string, ShopifyOrderWithLines>();
    for (const order of recent.orders) if (units(order) > 0) candidates.set(order.orderId, order);

    // Fora da janela de pedidos alterados, consulta direta de:
    //  - pedido ainda em aberto (pendente, ou pago sem vale processado), para
    //    não ficar pendente para sempre no painel;
    //  - pedido recente (dentro do alcance de leitura da Shopify), para achar o
    //    que foi EXCLUÍDO na Shopify com o `orders/delete` perdido.
    const verifiableSince = new Date(now.getTime() - VERIFIABLE_AGE_DAYS * 86_400_000);
    const lookups = await this.prisma.valePassOrder.findMany({
      where: {
        deletedInShopifyAt: null,
        OR: [
          { status: 'PENDING' },
          { status: 'CONFIRMED', vouchersProcessedAt: null },
          { orderCreatedAt: { gte: verifiableSince } },
          { orderCreatedAt: null, createdAt: { gte: verifiableSince } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_OPEN_ORDERS,
      select: { shopifyOrderId: true, shopifyOrderGid: true, orderCreatedAt: true, createdAt: true },
    });
    const outside = lookups.filter((row) => !candidates.has(row.shopifyOrderId));
    let notFound = 0;
    let deleted = 0;
    let failed = 0;
    if (outside.length > 0) {
      const gidOf = (row: { shopifyOrderId: string; shopifyOrderGid: string | null }) => row.shopifyOrderGid ?? `gid://shopify/Order/${row.shopifyOrderId}`;
      const states = await this.shopify.getOrdersWithLinesByGid(outside.map(gidOf));
      const missing = outside.filter((row) => !states.get(gidOf(row)));
      // Todos vazios = falha de acesso, nunca exclusão em massa (mesma trava da
      // reconciliação das reservas); fora do alcance de leitura também não é exclusão.
      const massMissing = outside.length >= MASS_MISSING_GUARD_MIN && missing.length === outside.length;
      for (const row of outside) {
        const state = states.get(gidOf(row));
        if (state && units(state) > 0) {
          candidates.set(state.orderId, state);
          continue;
        }
        notFound++;
        const createdAt = row.orderCreatedAt ?? row.createdAt;
        if (state || massMissing || createdAt < verifiableSince) continue;
        try {
          if (await this.markDeleted(row.shopifyOrderId, source)) deleted++;
        } catch (err) {
          failed++;
          this.logger.error(`Falha ao registrar a exclusão do pedido de Valle Pass ${row.shopifyOrderId}: ${err instanceof Error ? err.name : 'unknown'}`);
        }
      }
    }

    let created = 0;
    let statusChanged = 0;
    let unchanged = 0;
    let stale = 0;
    let vouchersRecovered = 0;
    for (const order of candidates.values()) {
      try {
        const outcome = await this.applyOne(order, units(order), source);
        if (outcome.created) created++;
        else if (outcome.statusChanged) statusChanged++;
        else if (outcome.stale) stale++;
        else unchanged++;
        if (outcome.vouchersRecovered) vouchersRecovered++;
      } catch (err) {
        failed++;
        this.logger.error(`Falha ao reconciliar o pedido de Valle Pass ${order.orderId}: ${err instanceof Error ? err.name : 'unknown'}`);
      }
    }
    if (recent.truncated) this.logger.warn(`Reconciliação do Valle Pass limitada a ${MAX_PAGES} páginas; pedidos mais antigos da janela ficam para a próxima rodada.`);

    return {
      generatedAt: now.toISOString(),
      windowDays,
      checkedShopifyOrders: recent.orders.length,
      valePassOrders: candidates.size,
      created,
      statusChanged,
      unchanged,
      stale,
      vouchersRecovered,
      notFound,
      deleted,
      failed,
      truncated: recent.truncated,
    };
  }

  /** Mesma regra e mesmo lock do `orders/delete` (ValePassOrderRegistry.markDeleted). */
  private markDeleted(orderId: string, source: string): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        await lockShopifyOrder(tx, orderId);
        return (await this.valePass.orders.markDeleted(tx, orderId, source)).length > 0;
      },
      { timeout: 15_000, maxWait: 5_000 },
    );
  }

  /** Uma transação por pedido, com o MESMO lock dos webhooks. */
  private applyOne(order: ShopifyOrderWithLines, quantity: number, source: string) {
    return this.prisma.$transaction(
      async (tx) => {
        await lockShopifyOrder(tx, order.orderId);
        const result = await this.valePass.orders.apply(tx, snapshotFromShopify(order, quantity), source);
        const recovered = await this.valePass.issueForConfirmedOrder(tx, result.order, payloadFromShopify(order), source);
        return { created: result.created, statusChanged: result.statusChanged, stale: result.stale, vouchersRecovered: recovered.length > 0 };
      },
      { timeout: 15_000, maxWait: 5_000 },
    );
  }
}

function parseDate(raw: string | null): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function snapshotFromShopify(order: ShopifyOrderWithLines, quantity: number): ValePassOrderSnapshot {
  return {
    orderId: order.orderId,
    orderGid: order.gid,
    orderName: order.name,
    financialStatus: order.financialStatus,
    cancelledAt: order.cancelledAt,
    cancelReason: order.cancelReason,
    createdAt: parseDate(order.createdAt),
    updatedAt: parseDate(order.updatedAt),
    quantity,
    // A Admin API não é consultada por dados de cliente; o webhook os traz.
    customerName: null,
    customerPhone: null,
    customerEmail: null,
  };
}

/** Mesmo formato do webhook REST, para a emissão de vales usar a regra de sempre. */
function payloadFromShopify(order: ShopifyOrderWithLines): ShopifyOrderPayload {
  return {
    id: order.orderId,
    admin_graphql_api_id: order.gid,
    name: order.name,
    financial_status: order.financialStatus ?? undefined,
    cancelled_at: order.cancelledAt,
    updated_at: order.updatedAt,
    line_items: order.lines.map((line) => ({ variant_id: line.variantId, product_id: line.productId, quantity: line.quantity })),
  };
}
