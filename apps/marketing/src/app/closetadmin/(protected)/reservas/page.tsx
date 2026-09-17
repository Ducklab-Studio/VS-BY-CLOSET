import type { Metadata } from 'next';
import Link from 'next/link';
import {
  AlertTriangle,
  CalendarDays,
  ChevronRight,
  CircleCheckBig,
  Clock3,
  FileDown,
  PackageCheck,
  Plus,
} from 'lucide-react';
import { hasAdminRole, requireAdminModule, requireAdminSession } from '@/lib/admin-session';
import { listReservations, type ReservationListItem } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { ErrorState, PageHeader, SourceBadge, StatusBadge, ArchivedBadge } from '@/components/closetadmin/ui';
import { ReservationFiltersForm } from './ReservationFiltersForm';
import { ExportPeriodPdfButton } from './ExportPeriodPdfButton';

export const metadata: Metadata = { title: 'Reservas' };

type SearchParams = {
  status?: string;
  source?: string;
  from?: string;
  to?: string;
  customer?: string;
  phone?: string;
  unitCode?: string;
  code?: string;
  includeArchived?: string;
  archivedOnly?: string;
};

/**
 * Central operacional de reservas. Os filtros continuam sendo processados
 * no reservations-api; o frontend não recalcula regra de aluguel nem mantém
 * uma cópia paralela dos dados da Shopify.
 */
export default async function ClosetAdminReservationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await requireAdminSession();
  requireAdminModule(session, 'RESERVATIONS');
  const rawFilters = await searchParams;
  const includeArchived = rawFilters.includeArchived === 'true';
  const archivedOnly = rawFilters.archivedOnly === 'true';
  const filters = { ...rawFilters, includeArchived, archivedOnly };

  let reservations: ReservationListItem[] | null = null;
  let allReservations: ReservationListItem[] | null = null;
  let errorMessage: string | null = null;

  try {
    [reservations, allReservations] = await Promise.all([
      listReservations(session.id, filters),
      listReservations(session.id, {}),
    ]);
  } catch (err) {
    errorMessage = err instanceof AdminApiError ? err.message : 'Erro inesperado.';
  }

  if (!reservations || !allReservations) {
    return <ErrorState message={errorMessage ?? 'Erro inesperado.'} />;
  }

  const confirmedCount = allReservations.filter((reservation) => reservation.status === 'confirmed').length;
  const pendingCount = allReservations.filter((reservation) =>
    ['hold', 'pending_payment'].includes(reservation.status),
  ).length;
  const attentionCount = allReservations.filter((reservation) => reservation.status === 'problem').length;
  const activeFilterCount = Object.entries(rawFilters).filter(([key, value]) => key !== 'includeArchived' && key !== 'archivedOnly' && Boolean(value)).length;
  // Estimativa pro texto de confirmação do "Limpar lista" — `allReservations`
  // já exclui arquivadas por padrão (ver ReservationListFilters), então isto
  // é o teto de candidatas ANTES do período mínimo de segurança do
  // ReservationArchiveService (a contagem exata vem do resultado da execução).
  const archivableEstimate = allReservations.filter((reservation) => reservation.status === 'expired' || reservation.status === 'cancelled').length;

  return (
    <div>
      <PageHeader
        title="Reservas"
        description="Acompanhe reservas online e manuais, retiradas, devoluções e ocorrências operacionais."
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <ExportPeriodPdfButton />
            <Link
              href="/closetadmin/reservas/nova"
              className="inline-flex items-center gap-2 rounded-lg bg-marsala px-3.5 py-2 text-sm font-medium text-white shadow-sm transition hover:brightness-110 dark:bg-gold dark:text-neutral-950"
            >
              <Plus size={16} />
              Nova reserva
            </Link>
          </div>
        }
      />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          icon={CalendarDays}
          label="Reservas cadastradas"
          value={allReservations.length}
          detail="total operacional"
        />
        <SummaryCard
          icon={CircleCheckBig}
          label="Confirmadas"
          value={confirmedCount}
          detail="prontas para operação"
          tone="success"
        />
        <SummaryCard
          icon={Clock3}
          label="Pendentes"
          value={pendingCount}
          detail="hold ou pagamento"
        />
        <SummaryCard
          icon={AlertTriangle}
          label="Requer atenção"
          value={attentionCount}
          detail="conferência manual"
          tone={attentionCount > 0 ? 'warning' : 'default'}
        />
      </section>

      <ReservationFiltersForm initial={rawFilters} showClearList={hasAdminRole(session, 'ADMIN')} estimatedArchivableCount={archivableEstimate} />

      <section className="mt-5 overflow-hidden rounded-xl border border-ink/10 bg-white shadow-sm dark:border-white/10 dark:bg-dark-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/10 px-4 py-3.5 dark:border-white/10">
          <div>
            <h2 className="text-sm font-semibold text-ink dark:text-dark-text">Resultado da busca</h2>
            <p className="mt-0.5 text-xs text-ink/45 dark:text-dark-subtle">
              {reservations.length} reserva{reservations.length === 1 ? '' : 's'} encontrada{reservations.length === 1 ? '' : 's'}
              {activeFilterCount > 0 ? ` · ${activeFilterCount} filtro${activeFilterCount === 1 ? '' : 's'} aplicado${activeFilterCount === 1 ? '' : 's'}` : ''}
            </p>
          </div>
          <Link
            href="/closetadmin/calendario"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-marsala transition hover:underline dark:text-gold"
          >
            Ver no calendário <ChevronRight size={14} />
          </Link>
        </div>

        {reservations.length === 0 ? (
          <div className="flex min-h-[260px] flex-col items-center justify-center px-6 py-10 text-center">
            <div className="rounded-full border border-emerald-500/15 bg-emerald-500/[0.07] p-3 text-emerald-400">
              <PackageCheck size={23} />
            </div>
            <h3 className="mt-4 text-base font-semibold text-ink dark:text-dark-text">Nenhuma reserva encontrada</h3>
            <p className="mt-1 max-w-md text-sm text-ink/50 dark:text-dark-muted">
              {activeFilterCount > 0
                ? 'Não há reservas que correspondam aos filtros atuais. Limpe ou ajuste os filtros para ampliar a busca.'
                : 'Quando uma reserva online ou manual for criada, ela aparecerá aqui com status, datas, origem e quantidade de peças.'}
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {activeFilterCount > 0 ? (
                <Link
                  href="/closetadmin/reservas"
                  className="rounded-lg border border-ink/10 px-3.5 py-2 text-sm font-medium text-ink/65 transition hover:bg-ink/5 dark:border-white/10 dark:text-dark-muted dark:hover:bg-white/5"
                >
                  Limpar filtros
                </Link>
              ) : null}
              <Link
                href="/closetadmin/reservas/nova"
                className="inline-flex items-center gap-2 rounded-lg bg-marsala px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110 dark:bg-gold dark:text-neutral-950"
              >
                <Plus size={15} /> Nova reserva
              </Link>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-ink/10 bg-neutral-50/50 text-left text-[11px] uppercase tracking-[0.12em] text-ink/50 dark:border-white/10 dark:bg-white/[0.02] dark:text-dark-subtle">
                  <th className="px-4 py-3 font-medium">Reserva</th>
                  <th className="px-4 py-3 font-medium">Cliente</th>
                  <th className="px-4 py-3 font-medium">Origem</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Retirada</th>
                  <th className="px-4 py-3 font-medium">Devolução</th>
                  <th className="px-4 py-3 text-center font-medium">Peças</th>
                  <th className="px-4 py-3 text-right font-medium">Abrir</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink/5 dark:divide-white/5">
                {reservations.map((reservation) => (
                  <tr key={reservation.id} className="transition hover:bg-ink/[0.035] dark:hover:bg-white/[0.035]">
                    <td className="px-4 py-3.5">
                      <Link href={`/closetadmin/reservas/${reservation.id}`} className="block">
                        <span className="font-mono text-xs font-medium text-ink/65 dark:text-dark-muted">#{shortId(reservation.id)}</span>
                        {reservation.shopifyOrderId ? (
                          <span className="mt-1 block text-[10px] uppercase tracking-wide text-emerald-500/80">pedido Shopify</span>
                        ) : null}
                      </Link>
                    </td>
                    <td className="px-4 py-3.5">
                      <Link href={`/closetadmin/reservas/${reservation.id}`} className="block min-w-[170px]">
                        <span className="block truncate font-medium text-ink dark:text-dark-text">{reservation.customerName ?? 'Cliente não informado'}</span>
                        <span className="mt-0.5 block text-xs text-ink/45 dark:text-dark-subtle">{reservation.customerPhone ?? reservation.customerEmail ?? 'Sem contato'}</span>
                      </Link>
                    </td>
                    <td className="px-4 py-3.5">
                      <Link href={`/closetadmin/reservas/${reservation.id}`} className="block">
                        <SourceBadge source={reservation.source} />
                      </Link>
                    </td>
                    <td className="px-4 py-3.5">
                      <Link href={`/closetadmin/reservas/${reservation.id}`} className="flex flex-wrap items-center gap-1.5">
                        <StatusBadge status={reservation.status} />
                        {reservation.archivedAt ? <ArchivedBadge /> : null}
                      </Link>
                    </td>
                    <td className="px-4 py-3.5">
                      <Link href={`/closetadmin/reservas/${reservation.id}`} className="block font-mono text-xs text-ink/65 dark:text-dark-muted">
                        {reservation.pickupDate ? formatDatePt(reservation.pickupDate) : '—'}
                      </Link>
                    </td>
                    <td className="px-4 py-3.5">
                      <Link href={`/closetadmin/reservas/${reservation.id}`} className="block font-mono text-xs text-ink/65 dark:text-dark-muted">
                        {reservation.returnDate ? formatDatePt(reservation.returnDate) : '—'}
                      </Link>
                    </td>
                    <td className="px-4 py-3.5 text-center">
                      <Link href={`/closetadmin/reservas/${reservation.id}`} className="inline-flex min-w-8 items-center justify-center rounded-full bg-ink/5 px-2 py-1 text-xs font-semibold text-ink/65 dark:bg-white/5 dark:text-dark-muted">
                        {reservation.itemCount}
                      </Link>
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <Link
                        href={`/closetadmin/reservas/${reservation.id}`}
                        aria-label="Abrir reserva"
                        className="inline-flex rounded-lg border border-ink/10 p-2 text-ink/50 transition hover:bg-ink/5 hover:text-marsala dark:border-white/10 dark:text-dark-subtle dark:hover:bg-white/5 dark:hover:text-gold"
                      >
                        <ChevronRight size={15} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="mt-3 flex items-center gap-2 text-[11px] text-ink/40 dark:text-dark-subtle">
        <FileDown size={12} />
        O PDF e os filtros usam apenas dados operacionais; pagamentos e faturamento continuam exclusivamente na Shopify.
      </div>
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  detail,
  tone = 'default',
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: number;
  detail: string;
  tone?: 'default' | 'success' | 'warning';
}) {
  const iconTone =
    tone === 'warning'
      ? 'bg-amber-500/10 text-amber-400'
      : tone === 'success'
        ? 'bg-emerald-500/10 text-emerald-400'
        : 'bg-marsala/10 text-marsala dark:bg-gold/10 dark:text-gold';

  return (
    <div className="rounded-xl border border-ink/10 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-dark-card">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs text-ink/50 dark:text-dark-subtle">{label}</p>
          <p className="mt-1 text-2xl font-semibold text-ink dark:text-dark-text">{value}</p>
          <p className="mt-0.5 text-[11px] text-ink/40 dark:text-dark-subtle">{detail}</p>
        </div>
        <div className={`rounded-lg p-2.5 ${iconTone}`}>
          <Icon size={18} />
        </div>
      </div>
    </div>
  );
}

function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8).toUpperCase();
}

function formatDatePt(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}
