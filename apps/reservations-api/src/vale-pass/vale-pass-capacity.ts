import { Prisma } from '@prisma/client';
import type { ValePassLotStatus, ValePassStatus } from '@prisma/client';

/**
 * Capacidade do Valle Pass: limite GLOBAL, lotes comerciais e totais. Funções puras + as consultas SQL num só lugar,
 * para que a tela, as validações e (na etapa seguinte) a emissão usem exatamente a mesma conta.
 *
 * DECISÕES (documentadas em docs/VALLE-PASS-2027-DESENHO.md):
 *  - "Vendido" = passe emitido e NÃO cancelado. Passe cancelado (ex.: pedido reembolsado) libera capacidade. Passe usado
 *    ou expirado continua contando: foi vendido.
 *  - O limite de um lote NUNCA é o limite global: o lote só abre se couber no saldo global.
 *  - Pertencimento a um lote é derivado do horário (`purchased_at` dentro de `[opened_at, closed_at)`).
 */

/** Teto técnico (não comercial) para quantidades configuráveis. */
export const MAX_CONFIGURABLE_QUANTITY = 1_000_000;
export const MAX_LOT_QUANTITY = 100_000;

export function consumesCapacity(status: ValePassStatus): boolean {
  return status !== 'CANCELLED';
}

export interface CapacityTotals {
  /** Todos os passes emitidos (inclui cancelados). */
  readonly issued: number;
  readonly cancelled: number;
  /** Emitidos e não cancelados: o que conta contra o limite global. */
  readonly sold: number;
  readonly active: number;
  readonly used: number;
  readonly expired: number;
}

export function totalsFromStatusCounts(counts: Readonly<Partial<Record<ValePassStatus, number>>>): CapacityTotals {
  const get = (status: ValePassStatus) => counts[status] ?? 0;
  const cancelled = get('CANCELLED');
  const issued = get('ACTIVE') + get('USED') + get('EXPIRED') + cancelled;
  return { issued, cancelled, sold: issued - cancelled, active: get('ACTIVE'), used: get('USED'), expired: get('EXPIRED') };
}

/** Saldo do limite global; `null` = sem limite. Nunca negativo (vendas acima do limite aparecem como 0 + alerta). */
export function globalRemaining(globalLimit: number | null, sold: number): number | null {
  return globalLimit === null ? null : Math.max(0, globalLimit - sold);
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
  /** Passes emitidos e não cancelados dentro da janela do lote. */
  readonly sold: number;
  /** Quanto ainda cabe no lote (`quantity − sold`, nunca negativo). */
  readonly remaining: number;
  readonly soldOut: boolean;
}

export function toLotView(
  lot: { id: string; name: string; quantity: number; status: ValePassLotStatus; openedAt: Date | null; closedAt: Date | null; updatedAt: Date },
  sold: number,
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
    remaining: Math.max(0, lot.quantity - sold),
    soldOut: sold >= lot.quantity,
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

// ── consultas ─────────────────────────────────────────────────────────

type Reader = Pick<Prisma.TransactionClient, '$queryRaw'>;

export async function loadStatusCounts(client: Reader, campaignId: string): Promise<CapacityTotals> {
  const rows = await client.$queryRaw<{ status: ValePassStatus; n: number }[]>`
    SELECT status::text AS status, count(*)::int AS n FROM vale_passes WHERE campaign_id = ${campaignId}::uuid GROUP BY status`;
  const counts: Partial<Record<ValePassStatus, number>> = {};
  for (const row of rows) counts[row.status] = row.n;
  return totalsFromStatusCounts(counts);
}

/** Vendidos (não cancelados) de cada lote, pela janela de horário. Lotes não abertos têm 0. */
export async function loadLotSold(client: Reader, campaignId: string): Promise<Map<string, number>> {
  const rows = await client.$queryRaw<{ id: string; sold: number }[]>`
    SELECT l.id::text AS id, count(v.id) FILTER (WHERE v.status <> 'CANCELLED')::int AS sold
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

export interface PaidOrderShortfall {
  readonly orderId: string;
  readonly orderName: string | null;
  /** Unidades de Valle Pass compradas no pedido. */
  readonly quantity: number;
  /** Vales emitidos para o pedido (inclui cancelados). */
  readonly issued: number;
  readonly missing: number;
}

/**
 * Pedidos CONFIRMADOS (pagos) que já passaram pela emissão mas ficaram com MENOS vales do que unidades compradas. É a falha
 * que o limite legado provocava (o 11º pagante ficava sem vale). Só leitura; não identifica o cliente.
 */
export async function loadPaidOrderShortfalls(client: Reader, limit = 50): Promise<PaidOrderShortfall[]> {
  const rows = await client.$queryRaw<{ orderId: string; orderName: string | null; quantity: number; issued: number }[]>`
    SELECT o.shopify_order_id AS "orderId", o.shopify_order_name AS "orderName", o.quantity, count(v.id)::int AS issued
    FROM vale_pass_orders o
    LEFT JOIN vale_passes v ON v.shopify_order_id = o.shopify_order_id
    WHERE o.status = 'CONFIRMED' AND o.deleted_in_shopify_at IS NULL AND o.vouchers_processed_at IS NOT NULL
    GROUP BY o.id
    HAVING count(v.id) < o.quantity
    ORDER BY o.order_created_at NULLS LAST, o.id
    LIMIT ${limit}`;
  return rows.map((row) => ({ ...row, missing: row.quantity - row.issued }));
}

/** Pedidos confirmados que ainda NÃO passaram pela emissão há mais de `minutes` (webhook/reconciliação atrasados). */
export async function countPaidOrdersAwaitingProcessing(client: Reader, minutes = 15): Promise<number> {
  const rows = await client.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM vale_pass_orders
    WHERE status = 'CONFIRMED' AND deleted_in_shopify_at IS NULL AND vouchers_processed_at IS NULL
      AND status_changed_at < now() - ${minutes} * interval '1 minute'`;
  return rows[0]?.n ?? 0;
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
