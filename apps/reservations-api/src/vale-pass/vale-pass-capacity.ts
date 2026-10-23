import { Prisma } from '@prisma/client';
import type { ValePassLotStatus } from '@prisma/client';

/**
 * Capacidade do Valle Pass: limite GLOBAL, lotes comerciais e totais. Funções puras + as consultas SQL num só lugar,
 * para que a tela, as validações e (na etapa seguinte) a emissão usem exatamente a mesma conta.
 *
 * DEFINIÇÕES (documentadas em docs/VALLE-PASS-2027-DESENHO.md):
 *  - UNIDADE de capacidade = um Valle Pass comercial. No modelo de vários vouchers cada unidade tem DOIS vouchers (duas linhas com o
 *    mesmo `group_id`) e consome UMA unidade; no legado 1 unidade = 1 linha (`group_id` nulo). Por isso toda contagem passa por
 *    `PASS_UNIT_KEY` = `coalesce(group_id, id)` e por `count(DISTINCT chave)`, nunca por `count(*)`.
 *  - VENDIDO (`sold`) = unidades emitidas com pelo menos um voucher não cancelado. Cancelar (ex.: pedido reembolsado) libera a
 *    capacidade; usado ou expirado continua contando.
 *  - PENDENTE (`pending`) = unidades de pedidos PAGOS (CONFIRMED, não excluídos na Shopify) que ainda não receberam todos os
 *    passes (`quantidade − unidades emitidas`, incluindo as canceladas, que já foram emitidas). Enquanto aguardam emissão, JÁ
 *    consomem capacidade; ao serem emitidas viram `sold` e saem de `pending` — nunca contam duas vezes.
 *  - CONSUMIDO (`consumed`) = `sold + pending`. É o que o limite global compara. A capacidade nunca é liberada só porque um
 *    pedido pago ainda espera emissão.
 *  - O limite de um lote NUNCA é o limite global: o lote só abre se couber no saldo global.
 *  - Pertencimento a um lote é derivado do horário (`purchased_at` dentro de `[opened_at, closed_at)`); as unidades pendentes
 *    são cobradas do lote ABERTO (é nele que serão emitidas), e só dele.
 */

/** Teto técnico (não comercial) para quantidades configuráveis. */
export const MAX_CONFIGURABLE_QUANTITY = 1_000_000;
/** Regra comercial do Valle Pass 2027: cada lote contém exatamente 100 unidades. */
export const VALE_PASS_LOT_UNITS = 100;
/** O teto global confirmado para a campanha oficial. */
export const VALE_PASS_GLOBAL_LIMIT = 1_000;

/**
 * Resolve o teto configurado sem inventar um limite para campanhas antigas:
 * `globalLimit` é a configuração explícita do modelo atual; `quantityLimit`
 * continua sendo o teto próprio das campanhas legadas. `null` em ambos
 * preserva o comportamento existente (sem teto configurado).
 */
export function configuredCapacityLimit(globalLimit: number | null, quantityLimit: number | null): number | null {
  return globalLimit ?? quantityLimit;
}

/** Chave que identifica UMA unidade vendida em `vale_passes` (alias `v`): o grupo (2 vouchers = 1 unidade) ou, no legado, o próprio voucher. */
export const PASS_UNIT_KEY = Prisma.sql`coalesce(v.group_id, v.id)`;

/**
 * Lista de agregados por unidade. `key` é a chave da unidade (`PASS_UNIT_KEY`); a fonte precisa expor `v.status`.
 * Uma unidade com dois vouchers conta UMA vez; só deixa de ser vendida quando TODAS as suas linhas estão canceladas.
 */
export function unitAggregates(key: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    count(DISTINCT ${key})::int AS issued,
    count(DISTINCT ${key}) FILTER (WHERE v.status <> 'CANCELLED')::int AS sold,
    count(DISTINCT ${key}) FILTER (WHERE v.status = 'ACTIVE')::int AS active,
    count(DISTINCT ${key}) FILTER (WHERE v.status = 'USED')::int AS used,
    count(DISTINCT ${key}) FILTER (WHERE v.status = 'EXPIRED')::int AS expired`;
}

export interface CapacityTotals {
  /** Unidades emitidas (inclui as canceladas). */
  readonly issued: number;
  /** Emitidas e todas canceladas: já não consomem capacidade. */
  readonly cancelled: number;
  /** Emitidas e não canceladas. */
  readonly sold: number;
  /** Unidades de pedidos pagos ainda sem emissão completa (já consomem capacidade). */
  readonly pending: number;
  /** `sold + pending`: o que o limite global compara. */
  readonly consumed: number;
  readonly active: number;
  readonly used: number;
  readonly expired: number;
}

export interface UnitAggregateRow {
  readonly issued: number;
  readonly sold: number;
  readonly active: number;
  readonly used: number;
  readonly expired: number;
}

export function totalsFrom(rows: UnitAggregateRow, pending: number): CapacityTotals {
  return {
    issued: rows.issued,
    cancelled: rows.issued - rows.sold,
    sold: rows.sold,
    pending,
    consumed: rows.sold + pending,
    active: rows.active,
    used: rows.used,
    expired: rows.expired,
  };
}

/** Saldo do limite global; `null` = sem limite. Nunca negativo (consumo acima do limite aparece como 0 + alerta). */
export function globalRemaining(globalLimit: number | null, consumed: number): number | null {
  return globalLimit === null ? null : Math.max(0, globalLimit - consumed);
}

export interface LotView {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  readonly status: ValePassLotStatus;
  readonly openedAt: string | null;
  readonly closedAt: string | null;
  /** Versão do lote (concorrência otimista): a ação seguinte precisa devolvê-la. */
  readonly updatedAt: string;
  /** Unidades emitidas e não canceladas dentro da janela do lote. */
  readonly sold: number;
  /** Unidades pagas aguardando emissão cobradas deste lote (só o lote ABERTO as carrega). */
  readonly pending: number;
  /** Quanto ainda cabe no lote (`quantity − sold − pending`, nunca negativo). */
  readonly remaining: number;
  readonly soldOut: boolean;
}

export function toLotView(
  lot: { id: string; name: string; quantity: number; status: ValePassLotStatus; openedAt: Date | null; closedAt: Date | null; updatedAt: Date },
  sold: number,
  pending = 0,
): LotView {
  return {
    id: lot.id,
    name: lot.name,
    quantity: lot.quantity,
    status: lot.status,
    openedAt: lot.openedAt?.toISOString() ?? null,
    closedAt: lot.closedAt?.toISOString() ?? null,
    updatedAt: lot.updatedAt.toISOString(),
    sold,
    pending,
    remaining: Math.max(0, lot.quantity - sold - pending),
    soldOut: sold + pending >= lot.quantity,
  };
}

/**
 * Quanto estoque a Shopify deveria ter agora para refletir o controle do painel: o saldo do lote aberto, limitado ao saldo
 * global. Sem lote aberto = 0 (a venda deveria estar fechada). O painel só MOSTRA este número; o ajuste do estoque na
 * Shopify é manual (o app não tem permissão de escrita e nenhuma alteração automática é feita).
 */
export function recommendedShopifyStock(openLot: LotView | null, remainingGlobal: number | null): number {
  if (!openLot) return 0;
  return remainingGlobal === null ? openLot.remaining : Math.min(openLot.remaining, remainingGlobal);
}

// ── pedidos pagos aguardando emissão ──────────────────────────────────

/** Um pedido PAGO (CONFIRMED, não excluído na Shopify) que tem menos unidades emitidas do que o comprado. */
export interface PaidOrderRow {
  readonly orderId: string;
  readonly orderName: string | null;
  /** Unidades de Valle Pass compradas. */
  readonly quantity: number;
  /** Unidades já emitidas (inclui as canceladas) MAIS as devolvidas por reembolso antes da emissão. */
  readonly issuedUnits: number;
  /** Parte de `issuedUnits` que são unidades reembolsadas ANTES de emitir (nenhum voucher existe para elas). */
  readonly absorbedUnits?: number;
  /** Campanhas que já têm vales deste pedido. */
  readonly campaignIds: readonly string[];
  /** O pedido já passou pela emissão (`vouchers_processed_at`). */
  readonly processed: boolean;
  /** Há quanto tempo o pagamento foi confirmado. */
  readonly statusChangedAt: Date;
}

export interface CampaignVariant {
  readonly campaignId: string;
  /** Parte numérica (ou o próprio texto) da variante da Shopify. */
  readonly variant: string;
}

/** `gid://shopify/ProductVariant/123` → `123`; o que não for GID fica como está. */
export function variantKey(value: string): string {
  return value.replace(/^.*\//, '').trim();
}

/**
 * Quantas unidades pagas e ainda sem emissão a campanha `campaignId` deve carregar. Pura:
 *  - pedido que já tem vales desta campanha → o que falta emitir é dela;
 *  - pedido que só tem vales de OUTRA campanha → não é desta;
 *  - pedido SEM vale algum → vai para a campanha da variante comprada (lida do que a Shopify enviou: `payloadVariants`);
 *  - sem como saber a variante (pedido só da reconciliação, sem payload) → cobrado de TODAS as campanhas. Direção segura:
 *    nunca libera capacidade; só pode segurar a mais até a emissão acontecer.
 */
export function pendingUnitsForCampaign(
  campaignId: string,
  orders: readonly PaidOrderRow[],
  campaigns: readonly CampaignVariant[],
  payloadVariants: ReadonlyMap<string, readonly string[]>,
): number {
  let units = 0;
  for (const order of orders) {
    const missing = order.quantity - order.issuedUnits;
    if (missing <= 0) continue;
    if (order.campaignIds.length > 0) {
      if (order.campaignIds.includes(campaignId)) units += missing;
      continue;
    }
    const bought = (payloadVariants.get(order.orderId) ?? []).map(variantKey);
    const matched = campaigns.filter((campaign) => bought.includes(variantKey(campaign.variant)));
    if (matched.length === 0 || matched.some((campaign) => campaign.campaignId === campaignId)) units += missing;
  }
  return units;
}

export interface PaidOrderShortfall {
  readonly orderId: string;
  readonly orderName: string | null;
  readonly quantity: number;
  /** Unidades emitidas para o pedido (inclui canceladas), sem contar as devolvidas antes da emissão. */
  readonly issued: number;
  /** Unidades pagas devolvidas por reembolso ANTES de emitir: não recebem voucher. */
  readonly absorbed: number;
  /** Unidades ainda elegíveis a emissão (pagas − emitidas − devolvidas). A emissão exige decisão de um ADMIN enquanto a regra comercial não existe. */
  readonly missing: number;
}

/** Pedidos pagos que JÁ passaram pela emissão e ficaram com menos do que o comprado (a falha do limite legado). */
export function shortfallsFrom(orders: readonly PaidOrderRow[], limit = 50): PaidOrderShortfall[] {
  return orders
    .filter((order) => order.processed && order.quantity > order.issuedUnits)
    .slice(0, limit)
    .map((order) => ({
      orderId: order.orderId,
      orderName: order.orderName,
      quantity: order.quantity,
      issued: order.issuedUnits - (order.absorbedUnits ?? 0),
      absorbed: order.absorbedUnits ?? 0,
      missing: order.quantity - order.issuedUnits,
    }));
}

/** Pedidos pagos ainda NÃO processados há mais de `minutes` (webhook/reconciliação atrasados). */
export function awaitingProcessingCount(orders: readonly PaidOrderRow[], now: Date, minutes = 15): number {
  return orders.filter((order) => !order.processed && now.getTime() - order.statusChangedAt.getTime() > minutes * 60_000).length;
}

// ── consultas ─────────────────────────────────────────────────────────

type Reader = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** Unidades pagas e NÃO emitidas já descontadas por reembolso (trilha do PR G; sem linhas = 0). Conta como "emitida" para não virar falsa pendência. */
export const REFUND_ABSORBED_UNITS = Prisma.sql`coalesce((SELECT sum(coalesce((r.detail->>'unissuedAbsorbed')::int, 0)) FROM vale_pass_refund_applications r WHERE r.shopify_order_id = o.shopify_order_id), 0)::int`;

const MAX_PENDING_ROWS = 5_000;

/** Pedidos pagos com menos unidades emitidas do que o comprado (qualquer campanha). `excludeOrderId` tira UM pedido da conta. */
export async function loadPaidOrderRows(client: Reader, excludeOrderId: string | null = null): Promise<PaidOrderRow[]> {
  const rows = await client.$queryRaw<
    { orderId: string; orderName: string | null; quantity: number; issuedUnits: number; absorbedUnits: number; campaignIds: string[]; processed: boolean; statusChangedAt: Date }[]
  >`
    SELECT o.shopify_order_id AS "orderId", o.shopify_order_name AS "orderName", o.quantity,
           (count(DISTINCT ${PASS_UNIT_KEY}) + ${REFUND_ABSORBED_UNITS})::int AS "issuedUnits",
           ${REFUND_ABSORBED_UNITS} AS "absorbedUnits",
           coalesce(array_agg(DISTINCT v.campaign_id::text) FILTER (WHERE v.id IS NOT NULL), ARRAY[]::text[]) AS "campaignIds",
           (o.vouchers_processed_at IS NOT NULL) AS processed, o.status_changed_at AS "statusChangedAt"
    FROM vale_pass_orders o
    LEFT JOIN vale_passes v ON v.shopify_order_id = o.shopify_order_id
    WHERE o.status = 'CONFIRMED' AND o.deleted_in_shopify_at IS NULL AND (${excludeOrderId}::text IS NULL OR o.shopify_order_id <> ${excludeOrderId})
    GROUP BY o.id
    HAVING count(DISTINCT ${PASS_UNIT_KEY}) + ${REFUND_ABSORBED_UNITS} < o.quantity
    ORDER BY o.order_created_at NULLS LAST, o.id
    LIMIT ${MAX_PENDING_ROWS}`;
  return rows;
}

/** Variantes compradas, lidas do que a Shopify enviou nos webhooks do pedido (só leitura). */
export async function loadPayloadVariants(client: Reader, orderIds: readonly string[]): Promise<Map<string, string[]>> {
  if (orderIds.length === 0) return new Map();
  const rows = await client.$queryRaw<{ orderId: string; variants: string[] }[]>`
    SELECT w.order_id AS "orderId", array_agg(DISTINCT li->>'variant_id') AS variants
    FROM webhook_events w
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(w.payload->'line_items') = 'array' THEN w.payload->'line_items' ELSE '[]'::jsonb END) li
    WHERE w.order_id = ANY(${[...orderIds]}::text[]) AND li->>'variant_id' IS NOT NULL
    GROUP BY w.order_id`;
  return new Map(rows.map((row) => [row.orderId, row.variants]));
}

export interface CampaignCapacityInputs {
  readonly totals: CapacityTotals;
  /** Pedidos pagos ainda sem emissão completa (qualquer campanha), para alertas e lista. */
  readonly paidOrders: readonly PaidOrderRow[];
}

/**
 * Totais da campanha + pedidos pagos pendentes, numa leitura só (use dentro da transação com a campanha travada).
 * `excludeOrderId`: calcula o consumo SEM um pedido (vouchers e pendência dele) — é o que a emissão usa para saber se o pedido cabe.
 */
export async function loadCapacity(client: Reader, campaignId: string, excludeOrderId: string | null = null): Promise<CampaignCapacityInputs> {
  // Sequencial de propósito: dentro de transação interativa do Prisma as consultas compartilham uma só conexão.
  const aggregates = await client.$queryRaw<UnitAggregateRow[]>`SELECT ${unitAggregates(PASS_UNIT_KEY)} FROM vale_passes v WHERE v.campaign_id = ${campaignId}::uuid AND (${excludeOrderId}::text IS NULL OR v.shopify_order_id IS DISTINCT FROM ${excludeOrderId})`;
  const paidOrders = await loadPaidOrderRows(client, excludeOrderId);
  const campaigns = await client.$queryRaw<{ id: string; variant: string }[]>`SELECT id::text AS id, shopify_variant_id AS variant FROM vale_pass_campaigns`;
  const unattributed = paidOrders.filter((order) => order.campaignIds.length === 0).map((order) => order.orderId);
  const payloadVariants = await loadPayloadVariants(client, unattributed);
  const pending = pendingUnitsForCampaign(campaignId, paidOrders, campaigns.map((c) => ({ campaignId: c.id, variant: c.variant })), payloadVariants);
  const row = aggregates[0] ?? { issued: 0, sold: 0, active: 0, used: 0, expired: 0 };
  return { totals: totalsFrom(row, pending), paidOrders };
}

/** Vendidos (não cancelados) de cada lote, pela janela de horário. Lotes não abertos têm 0. */
export async function loadLotSold(client: Reader, campaignId: string): Promise<Map<string, number>> {
  const rows = await client.$queryRaw<{ id: string; sold: number }[]>`
    SELECT l.id::text AS id, count(DISTINCT ${PASS_UNIT_KEY}) FILTER (WHERE v.status <> 'CANCELLED')::int AS sold
    FROM vale_pass_lots l
    LEFT JOIN vale_passes v
      ON v.campaign_id = l.campaign_id
     AND l.opened_at IS NOT NULL
     AND v.purchased_at >= l.opened_at
     AND (l.closed_at IS NULL OR v.purchased_at < l.closed_at)
    WHERE l.campaign_id = ${campaignId}::uuid
    GROUP BY l.id`;
  return new Map(rows.map((row) => [row.id, row.sold]));
}

// ── datas e validações puras ──────────────────────────────────────────

/** "YYYY-MM-DD" estrito (calendário real) → `Date` em UTC à meia-noite; `null` se inválido. */
export function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  const year = date.getUTCFullYear();
  return year >= 2000 && year <= 2100 ? date : null;
}

export function formatIsoDate(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}
