/**
 * Relatório de conferência Shopify × reservas (GET /admin/reconciliation/shopify-orders,
 * modo relatório: só lê o banco e a Admin API da Shopify — nada é alterado).
 * Arquivo puro (sem imports) para test/reconciliation-report.test.mjs.
 *
 * Este módulo só descreve e valida o que a API devolve; nenhuma ação de correção
 * existe aqui. Cada divergência é para análise humana.
 */

export type DivergenceKind =
  | 'paid_in_shopify_not_confirmed'
  | 'payment_received_availability_conflict'
  | 'shopify_order_without_reservation'
  | 'cancelled_in_shopify'
  | 'payment_failed_in_shopify'
  | 'missing_in_shopify'
  | 'closed_in_shopify'
  | 'unverifiable_missing';

export interface Divergence {
  readonly kind: DivergenceKind;
  readonly orderId: string;
  readonly orderName: string | null;
  readonly reservationId: string | null;
  readonly reservationStatus: string | null;
  readonly shopify: { readonly cancelled: boolean; readonly closed: boolean; readonly financialStatus: string | null } | null;
  readonly action: string;
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

export type Severity = 'alta' | 'media' | 'info';

export interface KindInfo {
  readonly label: string;
  readonly severity: Severity;
  /** O que a equipe deve fazer — sempre manual. */
  readonly guidance: string;
}

export const KIND_INFO: Record<DivergenceKind, KindInfo> = {
  paid_in_shopify_not_confirmed: {
    label: 'Pago na Shopify, reserva não confirmada',
    severity: 'alta',
    guidance: 'O pedido consta como pago, mas a reserva está aguardando pagamento ou expirada. Confira a peça e as datas e trate manualmente.',
  },
  payment_received_availability_conflict: {
    label: 'Pagamento recebido — conflito de disponibilidade',
    severity: 'alta',
    guidance: 'A cliente pagou, mas a peça já estava ocupada e a reserva não pôde ser confirmada. Exige ação humana: confira o pagamento na Shopify e decida entre atendimento alternativo ou reembolso.',
  },
  shopify_order_without_reservation: {
    label: 'Pedido na Shopify sem reserva vinculada',
    severity: 'alta',
    guidance: 'O pedido tem código de reserva, mas nenhuma reserva ficou ligada a ele (pode ser webhook perdido). Nada é criado automaticamente.',
  },
  cancelled_in_shopify: {
    label: 'Cancelado na Shopify, reserva ainda ativa',
    severity: 'media',
    guidance: 'O pedido foi cancelado na Shopify. Confira a reserva e a peça antes de liberar.',
  },
  payment_failed_in_shopify: {
    label: 'Pagamento falho ou anulado na Shopify',
    severity: 'media',
    guidance: 'O pagamento não se concretizou. Confira se a reserva deve expirar ou ir para revisão.',
  },
  missing_in_shopify: {
    label: 'Pedido excluído na Shopify',
    severity: 'media',
    guidance: 'O pedido não existe mais na Shopify. Reservas confirmadas vão para revisão (a peça não é liberada).',
  },
  closed_in_shopify: {
    label: 'Pedido arquivado na Shopify',
    severity: 'info',
    guidance: 'Pedido arquivado; reservas encerradas podem ser arquivadas no ClosetAdmin.',
  },
  unverifiable_missing: {
    label: 'Pedido fora da janela de leitura da Shopify',
    severity: 'info',
    guidance: 'O app só enxerga cerca de 60 dias de pedidos. Não é tratado como exclusão.',
  },
};

const SEVERITY_ORDER: Record<Severity, number> = { alta: 0, media: 1, info: 2 };

/** Janela pedida pela tela: padrão 10 dias, sempre entre 1 e 60 (limite da API). */
export function reportDays(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  if (!value || !Number.isInteger(n)) return 10;
  return Math.min(60, Math.max(1, n));
}

export function kindInfo(kind: string): KindInfo {
  return (KIND_INFO as Record<string, KindInfo | undefined>)[kind] ?? { label: kind, severity: 'media', guidance: 'Tipo de divergência desconhecido: confira manualmente.' };
}

/** Divergências mais graves primeiro; dentro da mesma gravidade, por tipo e nome do pedido. */
export function sortDivergences(list: readonly Divergence[]): Divergence[] {
  return [...list].sort(
    (a, b) =>
      SEVERITY_ORDER[kindInfo(a.kind).severity] - SEVERITY_ORDER[kindInfo(b.kind).severity] ||
      a.kind.localeCompare(b.kind) ||
      String(a.orderName ?? a.orderId).localeCompare(String(b.orderName ?? b.orderId), 'pt-BR', { numeric: true }),
  );
}

/** Quantas divergências exigem análise humana agora (gravidade alta). */
export function urgentCount(report: Pick<ReconciliationReport, 'divergences'>): number {
  return report.divergences.filter((d) => kindInfo(d.kind).severity === 'alta').length;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Valida o formato devolvido pela API. `null` = formato inesperado (versão
 * diferente da API, HTML de erro): a tela mostra erro em vez de um relatório
 * "vazio" que pareceria dizer que está tudo certo.
 */
export function parseReport(value: unknown): ReconciliationReport | null {
  if (!isRecord(value)) return null;
  if (value.mode !== 'report') return null; // esta tela nunca exibe nem dispara aplicação
  if (typeof value.generatedAt !== 'string' || typeof value.windowDays !== 'number') return null;
  if (typeof value.checkedReservations !== 'number' || typeof value.checkedShopifyOrders !== 'number') return null;
  if (!Array.isArray(value.divergences) || !isRecord(value.summary)) return null;
  const divergences: Divergence[] = [];
  for (const raw of value.divergences) {
    if (!isRecord(raw) || typeof raw.kind !== 'string' || typeof raw.orderId !== 'string') return null;
    const shopify = isRecord(raw.shopify)
      ? { cancelled: raw.shopify.cancelled === true, closed: raw.shopify.closed === true, financialStatus: typeof raw.shopify.financialStatus === 'string' ? raw.shopify.financialStatus : null }
      : null;
    divergences.push({
      kind: raw.kind as DivergenceKind,
      orderId: raw.orderId,
      orderName: typeof raw.orderName === 'string' ? raw.orderName : null,
      reservationId: typeof raw.reservationId === 'string' ? raw.reservationId : null,
      reservationStatus: typeof raw.reservationStatus === 'string' ? raw.reservationStatus : null,
      shopify,
      action: typeof raw.action === 'string' ? raw.action : 'none',
      applied: raw.applied === true,
      note: typeof raw.note === 'string' ? raw.note : '',
    });
  }
  const summary: Partial<Record<DivergenceKind, number>> = {};
  for (const [kind, count] of Object.entries(value.summary)) if (typeof count === 'number') summary[kind as DivergenceKind] = count;
  return {
    generatedAt: value.generatedAt,
    windowDays: value.windowDays,
    mode: 'report',
    checkedReservations: value.checkedReservations,
    checkedShopifyOrders: value.checkedShopifyOrders,
    truncated: value.truncated === true,
    summary,
    divergences,
  };
}
