import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { requireAdminSession } from '@/lib/admin-session';
import { getCalendar, type CalendarItem } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { EmptyState, ErrorState, PageHeader, SourceBadge, StatusBadge } from '@/components/closetadmin/ui';
import { civilDateToISOToday, isoAddDays } from '@/lib/closetadmin-dates';

export const metadata: Metadata = { title: 'Calendário' };

const WINDOW_DAYS = 7;
const PHASE_STYLES: Record<string, string> = {
  Preparação: 'bg-sand text-ink/80 dark:bg-amber-950/70 dark:text-sand dark:border dark:border-amber-700/40',
  Retirada: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300 dark:border dark:border-emerald-700/40',
  Aluguel: 'bg-marsala/10 text-marsala dark:bg-marsala/40 dark:text-gold dark:border dark:border-marsala/50',
  Devolução: 'bg-sky-100 text-sky-800 dark:bg-sky-950/70 dark:text-sky-300 dark:border dark:border-sky-700/40',
  Limpeza: 'bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400 dark:border dark:border-neutral-700/50',
};

function phaseForDay(day: string, item: CalendarItem): string {
  if (item.pickupDate && day === item.pickupDate) return 'Retirada';
  if (item.effectiveReturnDate && day === item.effectiveReturnDate) return 'Devolução';
  if (item.pickupDate && item.effectiveReturnDate && day > item.pickupDate && day < item.effectiveReturnDate) return 'Aluguel';
  if (item.pickupDate && day < item.pickupDate) return 'Preparação';
  return 'Limpeza';
}

/**
 * Fase 9, item 5 — /closetadmin/calendario. Janela de 7 dias navegável
 * (?date=YYYY-MM-DD), consulta SÓ o intervalo visível — nunca "toda
 * reserva do banco" (a mesma regra que `AdminCalendarService.getCalendar`
 * já impõe no backend, ver MAX_RANGE_DAYS). Fases (preparação → retirada
 * → aluguel → devolução → limpeza) são só rótulo visual derivado de
 * `pickupDate`/`effectiveReturnDate` — nenhuma regra nova, o backend já
 * decide os dois.
 */
export default async function ClosetAdminCalendarPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const session = await requireAdminSession();
  const { date } = await searchParams;
  const start = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : civilDateToISOToday();
  const end = isoAddDays(start, WINDOW_DAYS);
  const prevStart = isoAddDays(start, -WINDOW_DAYS);
  const nextStart = end;

  let items: CalendarItem[] | null = null;
  let errorMessage: string | null = null;
  try {
    items = await getCalendar(session.id, start, end);
  } catch (err) {
    errorMessage = err instanceof AdminApiError ? err.message : 'Erro inesperado.';
  }

  if (!items) {
    return <ErrorState message={errorMessage ?? 'Erro inesperado.'} />;
  }

  const days = Array.from({ length: WINDOW_DAYS }, (_, i) => isoAddDays(start, i));

  return (
    <div>
      <PageHeader
        title="Calendário"
        description="Preparação → retirada → aluguel → devolução → limpeza"
        action={
          <div className="flex items-center gap-2">
            <Link href={`?date=${prevStart}`} className="rounded-lg border border-ink/10 dark:border-white/10 bg-white dark:bg-dark-card p-2 text-ink dark:text-dark-text hover:bg-ink/5 dark:hover:bg-white/5 transition">
              <ChevronLeft size={18} />
            </Link>
            <span className="text-sm font-medium text-ink/70 dark:text-dark-muted px-1">
              {formatDatePt(start)} – {formatDatePt(isoAddDays(end, -1))}
            </span>
            <Link href={`?date=${nextStart}`} className="rounded-lg border border-ink/10 dark:border-white/10 bg-white dark:bg-dark-card p-2 text-ink dark:text-dark-text hover:bg-ink/5 dark:hover:bg-white/5 transition">
              <ChevronRight size={18} />
            </Link>
          </div>
        }
      />

      {items.length === 0 ? (
        <EmptyState title="Nenhuma peça ocupada neste período" />
      ) : (
        <div className="flex flex-col gap-4">
          {days.map((day) => {
            const dayItems = items.filter((item) => day >= item.blockedFrom && day < item.blockedUntilExclusive);
            if (dayItems.length === 0) return null;
            return (
              <div key={day} className="rounded-xl border border-ink/10 dark:border-white/10 bg-white dark:bg-dark-card shadow-sm overflow-hidden transition-colors">
                <div className="border-b border-ink/10 dark:border-white/10 bg-neutral-50/50 dark:bg-white/[0.02] px-4 py-2.5 text-sm font-semibold text-ink/80 dark:text-dark-text">
                  {formatDatePt(day)}
                </div>
                <ul className="divide-y divide-ink/5 dark:divide-white/5">
                  {dayItems.map((item) => {
                    const phase = phaseForDay(day, item);
                    return (
                      <li key={`${item.reservationId}-${item.rentalUnitId}`}>
                        <Link
                          href={`/closetadmin/reservas/${item.reservationId}`}
                          className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm hover:bg-ink/5 dark:hover:bg-white/5 transition"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${PHASE_STYLES[phase]}`}>{phase}</span>
                            <span className="font-medium text-ink dark:text-dark-text">{item.customerName ?? 'Cliente'}</span>
                            <span className="text-ink/40 dark:text-dark-subtle">·</span>
                            <span className="text-ink/60 dark:text-dark-muted">{item.rentalUnitCode}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <SourceBadge source={item.source} />
                            <StatusBadge status={item.status} />
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatDatePt(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
