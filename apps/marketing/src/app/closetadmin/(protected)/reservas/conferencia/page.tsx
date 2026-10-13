import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminApiError } from '@/lib/admin-api';
import { requireAdminModule, requireAdminRole, requireAdminSession } from '@/lib/admin-session';
import { kindInfo, reportDays, sortDivergences, urgentCount, type Divergence, type ReconciliationReport } from '@/lib/reconciliation-report';
import { getShopifyReconciliation } from '@/lib/shopify-reconciliation-data';
import { EmptyState, ErrorState, PageHeader, StatusBadge } from '@/components/closetadmin/ui';

export const metadata: Metadata = { title: 'Conferência com a Shopify' };

const WINDOWS = [10, 30, 60] as const;

/**
 * Conferência Shopify × reservas — SOMENTE LEITURA. Mostra o que o relatório da
 * API encontrou (pedidos pagos sem reserva confirmada, pedidos sem reserva
 * vinculada, cancelamentos e exclusões não refletidos). Não há botão de
 * aplicar, corrigir, reenviar ou criar: toda divergência é para análise humana.
 * Só ADMIN com o módulo Reservas (a API exige o mesmo). Sem dados de cliente.
 */
export default async function ShopifyConferencePage({ searchParams }: { searchParams: Promise<{ dias?: string | string[] }> }) {
  const session = await requireAdminSession();
  requireAdminModule(session, 'RESERVATIONS');
  requireAdminRole(session, 'ADMIN');
  const days = reportDays((await searchParams).dias);

  let report: ReconciliationReport | null = null;
  let error: string | null = null;
  try {
    report = await getShopifyReconciliation(days);
  } catch (err) {
    error =
      err instanceof AdminApiError && err.status === 429
        ? 'Muitas consultas seguidas. Aguarde um minuto e tente de novo.'
        : err instanceof AdminApiError
          ? err.message
          : 'Não foi possível conferir agora.';
  }

  return (
    <div>
      <PageHeader
        title="Conferência com a Shopify"
        description="Compara os pedidos da Shopify com as reservas. Somente leitura: nada é criado, confirmado, cancelado ou alterado por esta tela."
        action={
          <Link href="/closetadmin/reservas" className="text-sm font-medium text-marsala underline-offset-4 hover:underline dark:text-gold">
            Voltar para Reservas
          </Link>
        }
      />

      <nav aria-label="Janela de conferência" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink/60 dark:text-dark-muted">Últimos</span>
        {WINDOWS.map((w) => (
          <Link
            key={w}
            href={`/closetadmin/reservas/conferencia?dias=${w}`}
            aria-current={w === days ? 'page' : undefined}
            data-testid={`janela-${w}`}
            className={`rounded-full border px-3 py-1 ${w === days ? 'border-marsala bg-marsala text-white dark:border-gold dark:bg-gold dark:text-neutral-950' : 'border-ink/15 text-ink/70 hover:border-marsala dark:border-white/15 dark:text-dark-muted'}`}
          >
            {w} dias
          </Link>
        ))}
      </nav>

      {error ? (
        <ErrorState message={error} />
      ) : report ? (
        <Report report={report} />
      ) : null}
    </div>
  );
}

function Report({ report }: { report: ReconciliationReport }) {
  const rows = sortDivergences(report.divergences);
  const urgent = urgentCount(report);
  return (
    <div data-testid="conferencia">
      <p className="mb-3 text-sm text-ink/70 dark:text-dark-muted" data-testid="conferencia-resumo">
        {report.checkedReservations} reserva(s) e {report.checkedShopifyOrders} pedido(s) conferidos em {report.windowDays} dias ·{' '}
        <strong className={urgent > 0 ? 'text-red-700 dark:text-red-300' : ''}>{urgent} requer(em) análise urgente</strong> · {rows.length} divergência(s) no total
      </p>

      {report.truncated ? (
        <p role="status" className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          O relatório atingiu o limite de itens consultados: pode haver mais pedidos ou reservas além dos listados. Use uma janela menor.
        </p>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          title="Nenhuma divergência na janela escolhida"
          description="Isto vale só para os pedidos que o app consegue ler (cerca de 60 dias) e para reservas já vinculadas a um pedido ou a pedidos com código de reserva."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-ink/10 bg-white shadow-sm dark:border-white/10 dark:bg-dark-card">
          <table className="w-full text-left text-sm" data-testid="conferencia-tabela">
            <thead className="border-b border-ink/10 text-xs uppercase tracking-wide text-ink/60 dark:border-white/10 dark:text-dark-subtle">
              <tr>
                <th scope="col" className="px-3 py-2">Situação</th>
                <th scope="col" className="px-3 py-2">Pedido</th>
                <th scope="col" className="px-3 py-2">Pagamento (Shopify)</th>
                <th scope="col" className="px-3 py-2">Reserva</th>
                <th scope="col" className="px-3 py-2">O que fazer</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5 dark:divide-white/5">
              {rows.map((d) => (
                <Row key={`${d.kind}-${d.orderId}-${d.reservationId ?? ''}`} d={d} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-xs text-ink/55 dark:text-dark-subtle">
        Gerado em {new Date(report.generatedAt).toLocaleString('pt-BR')}. O app lê pedidos dos últimos ~60 dias; pedidos mais antigos não podem ser conferidos aqui.
      </p>
    </div>
  );
}

function Row({ d }: { d: Divergence }) {
  const info = kindInfo(d.kind);
  const tone = info.severity === 'alta' ? 'text-red-700 dark:text-red-300' : info.severity === 'media' ? 'text-amber-700 dark:text-amber-300' : 'text-ink/65 dark:text-dark-muted';
  return (
    <tr data-testid="divergencia" data-kind={d.kind} data-severity={info.severity} className="align-top">
      <td className="px-3 py-2">
        <span className={`font-medium ${tone}`}>{info.label}</span>
      </td>
      <td className="px-3 py-2 font-mono text-xs">{d.orderName ?? `#${d.orderId}`}</td>
      <td className="px-3 py-2 text-xs">
        {d.shopify ? (
          <>
            {d.shopify.financialStatus ?? '—'}
            {d.shopify.cancelled ? ' · cancelado' : ''}
            {d.shopify.closed ? ' · arquivado' : ''}
          </>
        ) : (
          '—'
        )}
      </td>
      <td className="px-3 py-2 text-xs">
        {d.reservationId ? (
          <>
            <Link href={`/closetadmin/reservas/${d.reservationId}`} className="font-mono underline-offset-2 hover:underline">
              {d.reservationId.slice(0, 8)}
            </Link>
            {d.reservationStatus ? (
              <span className="ml-1.5 inline-block align-middle">
                <StatusBadge status={d.reservationStatus} />
              </span>
            ) : null}
          </>
        ) : (
          'sem reserva'
        )}
      </td>
      <td className="px-3 py-2 text-xs text-ink/70 dark:text-dark-muted">{info.guidance}</td>
    </tr>
  );
}
