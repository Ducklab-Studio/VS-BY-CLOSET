import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { requireAdminSession } from '@/lib/admin-session';
import { listReservations } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { EmptyState, ErrorState, PageHeader, SourceBadge, StatusBadge } from '@/components/closetadmin/ui';
import { ReservationFiltersForm } from './ReservationFiltersForm';
import { ExportPeriodPdfButton } from './ExportPeriodPdfButton';

export const metadata: Metadata = { title: 'Reservas' };

type SearchParams = { status?: string; source?: string; from?: string; to?: string; customer?: string; phone?: string; unitCode?: string };

/** Fase 9, item 6 — /closetadmin/reservas. Filtros vão direto pro
 *  `listReservations` do reservations-api (URL params) — nenhuma
 *  filtragem client-side de uma lista completa. */
export default async function ClosetAdminReservationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await requireAdminSession();
  const filters = await searchParams;

  let reservations: Awaited<ReturnType<typeof listReservations>> | null = null;
  let errorMessage: string | null = null;
  try {
    reservations = await listReservations(session.id, filters);
  } catch (err) {
    errorMessage = err instanceof AdminApiError ? err.message : 'Erro inesperado.';
  }

  if (!reservations) {
    return <ErrorState message={errorMessage ?? 'Erro inesperado.'} />;
  }

  {
    return (
      <div>
        <PageHeader
          title="Reservas"
          description={`${reservations.length} encontrada${reservations.length === 1 ? '' : 's'}`}
          action={
            <div className="flex items-center gap-2">
              <ExportPeriodPdfButton />
              <Link href="/closetadmin/reservas/nova" className="flex items-center gap-1.5 rounded-lg bg-marsala dark:bg-marsala-light px-3.5 py-2 text-sm font-medium text-cream dark:text-sand hover:bg-marsala/90 dark:hover:bg-marsala-glow transition shadow-sm">
                <Plus size={16} /> Nova reserva
              </Link>
            </div>
          }
        />

        <ReservationFiltersForm initial={filters} />

        {reservations.length === 0 ? (
          <EmptyState title="Nenhuma reserva encontrada" description="Ajuste os filtros ou crie uma nova reserva manual." />
        ) : (
          <div className="mt-4 overflow-x-auto rounded-xl border border-ink/10 dark:border-white/10 bg-white dark:bg-dark-card shadow-sm transition-colors">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink/10 dark:border-white/10 text-left text-xs uppercase tracking-wide text-ink/65 dark:text-dark-subtle bg-neutral-50/50 dark:bg-white/[0.02]">
                  <th className="px-4 py-3 font-medium">Cliente</th>
                  <th className="px-4 py-3 font-medium">Origem</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Retirada</th>
                  <th className="px-4 py-3 font-medium">Devolução</th>
                  <th className="px-4 py-3 font-medium">Peças</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink/5 dark:divide-white/5">
                {reservations.map((r) => (
                  <tr key={r.id} className="cursor-pointer hover:bg-ink/5 dark:hover:bg-white/5 transition">
                    <td className="px-4 py-3">
                      <Link href={`/closetadmin/reservas/${r.id}`} className="block">
                        <span className="font-medium text-ink dark:text-dark-text">{r.customerName ?? '—'}</span>
                        <span className="block text-xs text-ink/65 dark:text-dark-subtle mt-0.5">{r.customerPhone ?? ''}</span>
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/closetadmin/reservas/${r.id}`} className="block">
                        <SourceBadge source={r.source} />
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/closetadmin/reservas/${r.id}`} className="block">
                        <StatusBadge status={r.status} />
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/closetadmin/reservas/${r.id}`} className="block text-ink/70 dark:text-dark-muted font-mono text-xs">
                        {r.pickupDate ? formatDatePt(r.pickupDate) : '—'}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/closetadmin/reservas/${r.id}`} className="block text-ink/70 dark:text-dark-muted font-mono text-xs">
                        {r.returnDate ? formatDatePt(r.returnDate) : '—'}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/closetadmin/reservas/${r.id}`} className="block text-ink/70 dark:text-dark-muted">
                        {r.itemCount}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }
}

function formatDatePt(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
