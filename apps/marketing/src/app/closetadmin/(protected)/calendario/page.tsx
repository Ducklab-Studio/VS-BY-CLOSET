import type { Metadata } from 'next';
import Link from 'next/link';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  PackageCheck,
  Plus,
  RotateCcw,
  ShoppingBag,
} from 'lucide-react';
import { requireAdminSession } from '@/lib/admin-session';
import { getCalendar, type CalendarItem } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { ErrorState, PageHeader, SourceBadge, StatusBadge } from '@/components/closetadmin/ui';
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

const PHASES = ['Preparação', 'Retirada', 'Aluguel', 'Devolução', 'Limpeza'] as const;

function phaseForDay(day: string, item: CalendarItem): string {
  if (item.pickupDate && day === item.pickupDate) return 'Retirada';
  if (item.effectiveReturnDate && day === item.effectiveReturnDate) return 'Devolução';
  if (item.pickupDate && item.effectiveReturnDate && day > item.pickupDate && day < item.effectiveReturnDate) return 'Aluguel';
  if (item.pickupDate && day < item.pickupDate) return 'Preparação';
  return 'Limpeza';
}

/**
 * Calendário operacional em janela de 7 dias. O backend continua sendo a
 * fonte da verdade para bloqueios e datas; esta página só organiza a janela
 * visível em uma grade operacional com fases e atalhos de navegação.
 */
export default async function ClosetAdminCalendarPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const session = await requireAdminSession();
  const { date } = await searchParams;
  const today = civilDateToISOToday();
  const start = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;
  const end = isoAddDays(start, WINDOW_DAYS);
  const prevStart = isoAddDays(start, -WINDOW_DAYS);
  const nextStart = end;
  const endInclusive = isoAddDays(end, -1);

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
  const reservationCount = new Set(items.map((item) => item.reservationId)).size;
  const occupiedUnitCount = new Set(items.map((item) => item.rentalUnitId)).size;
  const pickupCount = uniqueReservationCount(items.filter((item) => item.pickupDate && item.pickupDate >= start && item.pickupDate < end));
  const returnCount = uniqueReservationCount(
    items.filter((item) => item.effectiveReturnDate && item.effectiveReturnDate >= start && item.effectiveReturnDate < end),
  );

  return (
    <div>
      <PageHeader
        title="Calendário"
        description="Visão operacional da preparação, retirada, aluguel, devolução e limpeza."
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Link
              href="/closetadmin/reservas/nova"
              className="inline-flex items-center gap-2 rounded-lg bg-marsala px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110 dark:bg-gold dark:text-neutral-950"
            >
              <Plus size={16} />
              Nova reserva
            </Link>
            <Link
              href={`?date=${today}`}
              className="inline-flex items-center gap-2 rounded-lg border border-ink/10 bg-white px-3 py-2 text-sm font-medium text-ink/70 transition hover:bg-ink/5 dark:border-white/10 dark:bg-dark-card dark:text-dark-muted dark:hover:bg-white/5"
            >
              <RotateCcw size={15} />
              Hoje
            </Link>
            <div className="flex items-center overflow-hidden rounded-lg border border-ink/10 bg-white dark:border-white/10 dark:bg-dark-card">
              <Link
                href={`?date=${prevStart}`}
                aria-label="Semana anterior"
                className="p-2 text-ink transition hover:bg-ink/5 dark:text-dark-text dark:hover:bg-white/5"
              >
                <ChevronLeft size={18} />
              </Link>
              <span className="min-w-[150px] border-x border-ink/10 px-3 py-2 text-center text-xs font-medium text-ink/70 dark:border-white/10 dark:text-dark-muted">
                {formatDatePt(start)} – {formatDatePt(endInclusive)}
              </span>
              <Link
                href={`?date=${nextStart}`}
                aria-label="Próxima semana"
                className="p-2 text-ink transition hover:bg-ink/5 dark:text-dark-text dark:hover:bg-white/5"
              >
                <ChevronRight size={18} />
              </Link>
            </div>
          </div>
        }
      />

      <section className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={<CalendarDays size={18} />} label="Reservas no período" value={reservationCount} />
        <SummaryCard icon={<PackageCheck size={18} />} label="Peças ocupadas" value={occupiedUnitCount} />
        <SummaryCard icon={<ShoppingBag size={18} />} label="Retiradas" value={pickupCount} />
        <SummaryCard icon={<RotateCcw size={18} />} label="Devoluções" value={returnCount} />
      </section>

      <section className="mb-5 rounded-xl border border-ink/10 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-dark-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink dark:text-dark-text">Legenda operacional</h2>
            <p className="mt-0.5 text-xs text-ink/50 dark:text-dark-subtle">
              O bloqueio da peça inclui preparação e limpeza para evitar conflito entre reservas.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {PHASES.map((phase) => (
              <span key={phase} className={`rounded-full px-2.5 py-1 text-xs font-medium ${PHASE_STYLES[phase]}`}>
                {phase}
              </span>
            ))}
          </div>
        </div>
      </section>

      {items.length === 0 ? (
        <div className="mb-4 rounded-xl border border-emerald-900/20 bg-emerald-950/20 px-4 py-3 text-sm text-emerald-200">
          Nenhuma peça está bloqueada nesta semana. Todos os dias abaixo estão livres no calendário operacional.
        </div>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
        {days.map((day) => {
          const dayItems = items.filter((item) => day >= item.blockedFrom && day < item.blockedUntilExclusive);
          const isToday = day === today;

          return (
            <article
              key={day}
              className={`min-h-[240px] overflow-hidden rounded-xl border bg-white shadow-sm transition-colors dark:bg-dark-card ${
                isToday ? 'border-gold/60 dark:border-gold/60' : 'border-ink/10 dark:border-white/10'
              }`}
            >
              <header className="border-b border-ink/10 bg-neutral-50/60 px-3.5 py-3 dark:border-white/10 dark:bg-white/[0.025]">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink/45 dark:text-dark-subtle">
                      {weekdayPt(day)}
                    </p>
                    <p className="mt-1 text-sm font-semibold text-ink dark:text-dark-text">{formatDatePtShort(day)}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {isToday ? (
                      <span className="rounded-full bg-gold/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gold">
                        Hoje
                      </span>
                    ) : null}
                    <span className="text-[10px] text-ink/40 dark:text-dark-subtle">
                      {dayItems.length} {dayItems.length === 1 ? 'peça' : 'peças'}
                    </span>
                  </div>
                </div>
              </header>

              {dayItems.length === 0 ? (
                <div className="flex min-h-[175px] flex-col items-center justify-center px-4 text-center">
                  <div className="mb-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 p-2 text-emerald-400">
                    <PackageCheck size={17} />
                  </div>
                  <p className="text-sm font-medium text-ink/65 dark:text-dark-muted">Dia livre</p>
                  <p className="mt-1 text-xs text-ink/40 dark:text-dark-subtle">Nenhuma peça bloqueada.</p>
                </div>
              ) : (
                <ul className="divide-y divide-ink/5 dark:divide-white/5">
                  {dayItems.map((item) => {
                    const phase = phaseForDay(day, item);
                    return (
                      <li key={`${day}-${item.reservationId}-${item.rentalUnitId}`}>
                        <Link
                          href={`/closetadmin/reservas/${item.reservationId}`}
                          className="block px-3.5 py-3 transition hover:bg-ink/5 dark:hover:bg-white/5"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${PHASE_STYLES[phase]}`}>{phase}</span>
                            <StatusBadge status={item.status} />
                          </div>
                          <p className="mt-2 truncate text-sm font-semibold text-ink dark:text-dark-text">{item.rentalUnitCode}</p>
                          <p className="mt-0.5 truncate text-xs text-ink/55 dark:text-dark-muted">{item.customerName ?? 'Cliente não informado'}</p>
                          <div className="mt-2">
                            <SourceBadge source={item.source} />
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}

function SummaryCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-xl border border-ink/10 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-dark-card">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs text-ink/50 dark:text-dark-subtle">{label}</p>
          <p className="mt-1 text-2xl font-semibold text-ink dark:text-dark-text">{value}</p>
        </div>
        <div className="rounded-lg bg-marsala/10 p-2.5 text-marsala dark:bg-gold/10 dark:text-gold">{icon}</div>
      </div>
    </div>
  );
}

function uniqueReservationCount(items: readonly CalendarItem[]): number {
  return new Set(items.map((item) => item.reservationId)).size;
}

function formatDatePt(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function formatDatePtShort(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

function weekdayPt(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat('pt-BR', { weekday: 'short', timeZone: 'UTC' }).format(date).replace('.', '');
}
