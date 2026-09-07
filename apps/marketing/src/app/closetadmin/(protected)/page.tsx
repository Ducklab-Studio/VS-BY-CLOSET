import type { Metadata } from 'next';
import Link from 'next/link';
import {
  AlertTriangle,
  CalendarDays,
  ChevronRight,
  CircleCheckBig,
  FileDown,
  PackageCheck,
  PackageOpen,
  PackageX,
  Plus,
  ShoppingBag,
} from 'lucide-react';
import { requireAdminSession } from '@/lib/admin-session';
import { getCalendar, listPieces, listReservations, type CalendarItem } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { Card, ErrorState, PageHeader, SourceBadge, StatusBadge } from '@/components/closetadmin/ui';
import { civilDateToISOToday, isoAddDays } from '@/lib/closetadmin-dates';

export const metadata: Metadata = { title: 'Dashboard' };

/**
 * Centro operacional do ClosetAdmin. Nada financeiro é calculado aqui:
 * Shopify continua sendo a fonte de verdade comercial. O dashboard resume
 * apenas reservas, agenda e peças físicas que precisam de atenção na operação.
 */
export default async function ClosetAdminDashboardPage() {
  const session = await requireAdminSession();
  const today = civilDateToISOToday();
  const in7Days = isoAddDays(today, 7);

  let data: Awaited<ReturnType<typeof loadDashboardData>> | null = null;
  let errorMessage: string | null = null;

  try {
    data = await loadDashboardData(session.id, today, in7Days);
  } catch (err) {
    errorMessage = err instanceof AdminApiError ? err.message : 'Erro inesperado.';
  }

  if (!data) {
    return <ErrorState message={errorMessage ?? 'Erro inesperado.'} />;
  }

  const { calendar, pieces, problems } = data;
  const pickupsToday = uniqueReservationCount(calendar.filter((item) => item.pickupDate === today));
  const returnsToday = uniqueReservationCount(calendar.filter((item) => item.effectiveReturnDate === today));
  const upcomingPickups = groupEvents(calendar, 'pickup', today).slice(0, 6);
  const upcomingReturns = groupEvents(calendar, 'return', today).slice(0, 6);

  const activeReservationIds = new Set(calendar.map((item) => item.reservationId));
  const occupiedPieces = pieces.filter((piece) => piece.currentlyOccupied).length;
  const activePieces = pieces.filter((piece) => piece.active).length;
  const inactivePieces = pieces.length - activePieces;
  const reservablePieces = pieces.filter((piece) => piece.active && piece.reservableOnline).length;
  const availablePieces = pieces.filter((piece) => piece.active && !piece.currentlyOccupied).length;
  const occupancyRate = activePieces > 0 ? Math.round((occupiedPieces / activePieces) * 100) : 0;

  return (
    <div>
      <PageHeader
        title="Dashboard operacional"
        description={`${weekdayLongPt(today)}, ${formatDateLongPt(today)} · visão dos próximos 7 dias`}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Link
              href="/closetadmin/reservas/nova"
              className="inline-flex items-center gap-2 rounded-lg bg-marsala px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110 dark:bg-gold dark:text-neutral-950"
            >
              <Plus size={16} />
              Nova reserva
            </Link>
            <a
              href="/closetadmin/relatorio-operacional"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-ink/15 px-3.5 py-2 text-sm font-medium text-ink/70 transition hover:bg-ink/5 dark:border-white/15 dark:text-dark-text dark:hover:bg-white/10"
            >
              <FileDown size={16} />
              Relatório PDF
            </a>
          </div>
        }
      />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={ShoppingBag} label="Retiradas hoje" value={pickupsToday} href="/closetadmin/calendario" />
        <StatCard icon={PackageCheck} label="Devoluções hoje" value={returnsToday} href="/closetadmin/calendario" />
        <StatCard icon={PackageX} label="Peças ocupadas" value={occupiedPieces} href="/closetadmin/pecas" />
        <StatCard
          icon={AlertTriangle}
          label="Alertas"
          value={problems.length}
          href="/closetadmin/reservas"
          tone={problems.length > 0 ? 'warning' : 'default'}
        />
      </section>

      <section className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MiniMetric label="Reservas no período" value={activeReservationIds.size} detail="próximos 7 dias" />
        <MiniMetric label="Peças cadastradas" value={pieces.length} detail={`${activePieces} ativas`} />
        <MiniMetric label="Reserváveis online" value={reservablePieces} detail={`${availablePieces} livres agora`} />
        <MiniMetric label="Ocupação atual" value={`${occupancyRate}%`} detail={`${occupiedPieces} de ${activePieces || 0} peças ativas`} />
      </section>

      <section className="mt-5 grid gap-4 xl:grid-cols-[1.35fr_0.65fr]">
        <Card className="overflow-hidden p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/10 px-5 py-4 dark:border-white/10">
            <div>
              <h2 className="font-heading text-base font-semibold tracking-wide text-ink dark:text-dark-text">Operação da semana</h2>
              <p className="mt-0.5 text-xs text-ink/50 dark:text-dark-subtle">Retiradas e devoluções que já exigem preparação da equipe.</p>
            </div>
            <Link href="/closetadmin/calendario" className="inline-flex items-center gap-1 text-xs font-medium text-marsala hover:underline dark:text-gold">
              Abrir calendário <ChevronRight size={14} />
            </Link>
          </div>

          <div className="grid lg:grid-cols-2">
            <UpcomingList title="Próximas retiradas" kind="pickup" events={upcomingPickups} />
            <div className="border-t border-ink/10 lg:border-l lg:border-t-0 dark:border-white/10">
              <UpcomingList title="Próximas devoluções" kind="return" events={upcomingReturns} />
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-heading text-base font-semibold tracking-wide text-ink dark:text-dark-text">Status das peças</h2>
              <p className="mt-0.5 text-xs text-ink/50 dark:text-dark-subtle">Visão rápida do inventário físico operacional.</p>
            </div>
            <div className="rounded-lg bg-marsala/10 p-2 text-marsala dark:bg-gold/10 dark:text-gold">
              <PackageOpen size={18} />
            </div>
          </div>

          <div className="mt-5 space-y-4">
            <ProgressRow label="Ocupadas" value={occupiedPieces} total={activePieces} />
            <ProgressRow label="Livres" value={availablePieces} total={activePieces} />
            <ProgressRow label="Reserváveis online" value={reservablePieces} total={activePieces} />
          </div>

          <div className="mt-5 grid grid-cols-2 gap-2 border-t border-ink/10 pt-4 dark:border-white/10">
            <SmallState label="Ativas" value={activePieces} />
            <SmallState label="Inativas" value={inactivePieces} />
          </div>

          <Link
            href="/closetadmin/pecas"
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-ink/10 px-3 py-2 text-sm font-medium text-ink/70 transition hover:bg-ink/5 dark:border-white/10 dark:text-dark-muted dark:hover:bg-white/5"
          >
            Gerenciar peças <ChevronRight size={15} />
          </Link>
        </Card>
      </section>

      <section className="mt-5 grid gap-4 xl:grid-cols-2">
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-heading text-base font-semibold tracking-wide text-ink dark:text-dark-text">Alertas operacionais</h2>
              <p className="mt-0.5 text-xs text-ink/50 dark:text-dark-subtle">Reservas em estado que requer conferência manual.</p>
            </div>
            <AlertTriangle size={18} className={problems.length > 0 ? 'text-amber-400' : 'text-emerald-400'} />
          </div>

          {problems.length === 0 ? (
            <div className="mt-5 flex items-center gap-3 rounded-xl border border-emerald-500/15 bg-emerald-500/[0.06] px-4 py-3">
              <CircleCheckBig size={19} className="shrink-0 text-emerald-400" />
              <div>
                <p className="text-sm font-medium text-ink dark:text-dark-text">Operação sem alertas</p>
                <p className="mt-0.5 text-xs text-ink/50 dark:text-dark-subtle">Nenhuma reserva precisa de intervenção agora.</p>
              </div>
            </div>
          ) : (
            <ul className="mt-4 divide-y divide-ink/5 dark:divide-white/5">
              {problems.slice(0, 6).map((reservation) => (
                <li key={reservation.id}>
                  <Link
                    href={`/closetadmin/reservas/${reservation.id}`}
                    className="flex items-center justify-between gap-3 py-3 text-sm transition hover:opacity-80"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink dark:text-dark-text">{reservation.customerName ?? 'Cliente não informado'}</p>
                      <p className="mt-0.5 text-xs text-ink/45 dark:text-dark-subtle">{reservation.itemCount} peça(s) · {reservation.source}</p>
                    </div>
                    <StatusBadge status={reservation.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-heading text-base font-semibold tracking-wide text-ink dark:text-dark-text">Atalhos da operação</h2>
              <p className="mt-0.5 text-xs text-ink/50 dark:text-dark-subtle">Acesse os fluxos usados no dia a dia sem procurar no menu.</p>
            </div>
            <CalendarDays size={18} className="text-gold" />
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <QuickAction href="/closetadmin/reservas/nova" title="Criar reserva" description="Reserva manual de balcão" />
            <QuickAction href="/closetadmin/calendario" title="Ver calendário" description="Agenda operacional semanal" />
            <QuickAction href="/closetadmin/pecas" title="Peças físicas" description="Disponibilidade e Shopify" />
            <QuickAction href="/closetadmin/regras" title="Regras e bloqueios" description="Datas e regras do aluguel" />
          </div>
        </Card>
      </section>
    </div>
  );
}

async function loadDashboardData(adminUserId: string, today: string, in7Days: string) {
  const [calendar, pieces, problems] = await Promise.all([
    getCalendar(adminUserId, today, in7Days),
    listPieces(adminUserId),
    listReservations(adminUserId, { status: 'problem' }),
  ]);
  return { calendar, pieces, problems };
}

type DashboardEvent = {
  reservationId: string;
  customerName: string | null;
  date: string;
  unitCodes: string[];
  source: string;
  status: string;
};

function groupEvents(items: readonly CalendarItem[], kind: 'pickup' | 'return', today: string): DashboardEvent[] {
  const grouped = new Map<string, DashboardEvent>();

  for (const item of items) {
    const date = kind === 'pickup' ? item.pickupDate : item.effectiveReturnDate;
    if (!date || date <= today) continue;

    const key = `${item.reservationId}-${date}`;
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.unitCodes.includes(item.rentalUnitCode)) existing.unitCodes.push(item.rentalUnitCode);
      continue;
    }

    grouped.set(key, {
      reservationId: item.reservationId,
      customerName: item.customerName,
      date,
      unitCodes: [item.rentalUnitCode],
      source: item.source,
      status: item.status,
    });
  }

  return [...grouped.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function StatCard({
  icon: Icon,
  label,
  value,
  href,
  tone = 'default',
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: number;
  href: string;
  tone?: 'default' | 'warning';
}) {
  return (
    <Link href={href} className="group block">
      <Card className="flex items-center justify-between gap-3 transition group-hover:-translate-y-0.5 group-hover:border-gold/30">
        <div className="flex items-center gap-3.5">
          <div
            className={`rounded-xl p-3 transition-colors ${
              tone === 'warning' && value > 0
                ? 'border border-amber-800/40 bg-amber-950/60 text-amber-400'
                : 'border border-marsala/40 bg-marsala/30 text-gold'
            }`}
          >
            <Icon size={22} />
          </div>
          <div>
            <p className="text-2xl font-bold tracking-tight text-ink dark:text-dark-text">{value}</p>
            <p className="mt-0.5 text-xs text-ink/50 dark:text-dark-muted">{label}</p>
          </div>
        </div>
        <ChevronRight size={16} className="text-ink/25 transition group-hover:translate-x-0.5 group-hover:text-gold dark:text-dark-subtle" />
      </Card>
    </Link>
  );
}

function MiniMetric({ label, value, detail }: { label: string; value: number | string; detail: string }) {
  return (
    <div className="rounded-xl border border-ink/10 bg-white px-4 py-3 shadow-sm dark:border-white/10 dark:bg-dark-card">
      <p className="text-[11px] uppercase tracking-[0.12em] text-ink/45 dark:text-dark-subtle">{label}</p>
      <div className="mt-1 flex items-end justify-between gap-2">
        <p className="text-xl font-semibold text-ink dark:text-dark-text">{value}</p>
        <p className="pb-0.5 text-[11px] text-ink/45 dark:text-dark-subtle">{detail}</p>
      </div>
    </div>
  );
}

function UpcomingList({ title, kind, events }: { title: string; kind: 'pickup' | 'return'; events: readonly DashboardEvent[] }) {
  return (
    <div className="p-5">
      <div className="flex items-center gap-2">
        {kind === 'pickup' ? <ShoppingBag size={16} className="text-gold" /> : <PackageCheck size={16} className="text-gold" />}
        <h3 className="text-sm font-semibold text-ink dark:text-dark-text">{title}</h3>
      </div>

      {events.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-ink/10 px-3 py-4 text-center dark:border-white/10">
          <p className="text-sm text-ink/55 dark:text-dark-muted">Nada agendado nos próximos 7 dias.</p>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-ink/5 dark:divide-white/5">
          {events.map((event) => (
            <li key={`${kind}-${event.reservationId}-${event.date}`}>
              <Link href={`/closetadmin/reservas/${event.reservationId}`} className="block py-3 transition hover:opacity-80">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink dark:text-dark-text">{event.customerName ?? 'Cliente não informado'}</p>
                    <p className="mt-0.5 truncate text-xs text-ink/50 dark:text-dark-subtle">{event.unitCodes.join(', ')}</p>
                  </div>
                  <span className="shrink-0 text-xs font-medium text-ink/60 dark:text-dark-muted">{formatDatePt(event.date)}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <SourceBadge source={event.source} />
                  <StatusBadge status={event.status} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProgressRow({ label, value, total }: { label: string; value: number; total: number }) {
  const percentage = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
        <span className="text-ink/60 dark:text-dark-muted">{label}</span>
        <span className="font-medium text-ink dark:text-dark-text">{value}/{total}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-ink/5 dark:bg-white/[0.06]">
        <div className="h-full rounded-full bg-gold transition-all" style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}

function SmallState({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-ink/[0.025] px-3 py-2.5 dark:bg-white/[0.025]">
      <p className="text-[10px] uppercase tracking-wide text-ink/45 dark:text-dark-subtle">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-ink dark:text-dark-text">{value}</p>
    </div>
  );
}

function QuickAction({ href, title, description }: { href: string; title: string; description: string }) {
  return (
    <Link
      href={href}
      className="group rounded-xl border border-ink/10 px-3.5 py-3 transition hover:border-gold/30 hover:bg-ink/[0.02] dark:border-white/10 dark:hover:bg-white/[0.025]"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-ink dark:text-dark-text">{title}</p>
          <p className="mt-0.5 text-xs text-ink/45 dark:text-dark-subtle">{description}</p>
        </div>
        <ChevronRight size={15} className="mt-0.5 text-ink/25 transition group-hover:translate-x-0.5 group-hover:text-gold dark:text-dark-subtle" />
      </div>
    </Link>
  );
}

function uniqueReservationCount(items: readonly CalendarItem[]): number {
  return new Set(items.map((item) => item.reservationId)).size;
}

function formatDatePt(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function formatDateLongPt(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

function weekdayLongPt(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const text = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
  return text.charAt(0).toUpperCase() + text.slice(1);
}
