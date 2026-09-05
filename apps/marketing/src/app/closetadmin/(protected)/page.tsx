import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertTriangle, FileDown, PackageCheck, PackageX, ShoppingBag } from 'lucide-react';
import { requireAdminSession } from '@/lib/admin-session';
import { getCalendar, listPieces, listReservations } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { Card, ErrorState, PageHeader, StatusBadge } from '@/components/closetadmin/ui';
import { civilDateToISOToday, isoAddDays } from '@/lib/closetadmin-dates';

export const metadata: Metadata = { title: 'Dashboard' };

/**
 * Fase 9, item 4 — dashboard OPERACIONAL, nunca financeiro (item
 * explícito: "Explicitamente forbidden: dashboard financeiro,
 * faturamento paralelo, gráficos de venda"). Tudo aqui é derivado de
 * dados reais (calendário/peças/reservas) — zero mocks, zero número
 * inventado.
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
  {
    const { calendar, pieces, problems } = data;
    const pickupsToday = calendar.filter((c) => c.pickupDate === today);
    const returnsToday = calendar.filter((c) => c.effectiveReturnDate === today);
    const upcomingPickups = calendar.filter((c) => c.pickupDate && c.pickupDate > today).slice(0, 8);
    const upcomingReturns = calendar.filter((c) => c.effectiveReturnDate && c.effectiveReturnDate > today).slice(0, 8);
    const activeReservationIds = new Set(calendar.map((c) => c.reservationId));
    const occupiedPieces = pieces.filter((p) => p.currentlyOccupied).length;
    const inactivePieces = pieces.filter((p) => !p.active).length;

    return (
      <div>
        <PageHeader
          title="Dashboard"
          description={`Hoje: ${formatDatePt(today)}`}
          action={
            <a
              href="/closetadmin/relatorio-operacional"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-lg border border-ink/15 dark:border-white/15 px-3.5 py-2 text-sm font-medium text-ink/70 dark:text-dark-text hover:bg-ink/5 dark:hover:bg-white/10"
            >
              <FileDown size={16} /> Relatório do dia (PDF)
            </a>
          }
        />

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard icon={ShoppingBag} label="Retiradas hoje" value={pickupsToday.length} />
          <StatCard icon={PackageCheck} label="Devoluções hoje" value={returnsToday.length} />
          <StatCard icon={PackageX} label="Peças ocupadas" value={occupiedPieces} />
          <StatCard icon={AlertTriangle} label="Alertas" value={problems.length} tone={problems.length > 0 ? 'warning' : 'default'} />
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Card>
            <h2 className="font-heading text-base font-semibold text-ink dark:text-dark-text tracking-wide">Próximas retiradas</h2>
            {upcomingPickups.length === 0 ? (
              <p className="mt-3 text-sm text-ink/45 dark:text-dark-muted">Nenhuma retirada nos próximos 7 dias.</p>
            ) : (
              <ul className="mt-3 divide-y divide-ink/5 dark:divide-white/5">
                {upcomingPickups.map((item) => (
                  <li key={`${item.reservationId}-${item.rentalUnitId}`} className="flex items-center justify-between py-2 text-sm">
                    <span className="text-ink dark:text-dark-text font-medium">
                      {item.customerName ?? 'Cliente'} <span className="text-ink/40 dark:text-dark-subtle font-normal">· {item.rentalUnitCode}</span>
                    </span>
                    <span className="text-ink/60 dark:text-dark-muted">{formatDatePt(item.pickupDate!)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="font-heading text-base font-semibold text-ink dark:text-dark-text tracking-wide">Próximas devoluções</h2>
            {upcomingReturns.length === 0 ? (
              <p className="mt-3 text-sm text-ink/45 dark:text-dark-muted">Nenhuma devolução nos próximos 7 dias.</p>
            ) : (
              <ul className="mt-3 divide-y divide-ink/5 dark:divide-white/5">
                {upcomingReturns.map((item) => (
                  <li key={`${item.reservationId}-${item.rentalUnitId}-r`} className="flex items-center justify-between py-2 text-sm">
                    <span className="text-ink dark:text-dark-text font-medium">
                      {item.customerName ?? 'Cliente'} <span className="text-ink/40 dark:text-dark-subtle font-normal">· {item.rentalUnitCode}</span>
                    </span>
                    <span className="text-ink/60 dark:text-dark-muted">{formatDatePt(item.effectiveReturnDate!)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Card>
            <h2 className="font-heading text-base font-semibold text-ink dark:text-dark-text tracking-wide">Resumo operacional</h2>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <Row label="Reservas ativas (7 dias)" value={activeReservationIds.size} />
              <Row label="Peças cadastradas" value={pieces.length} />
              <Row label="Peças inativas" value={inactivePieces} />
            </dl>
          </Card>

          <Card>
            <h2 className="font-heading text-base font-semibold text-ink dark:text-dark-text tracking-wide">Alertas</h2>
            {problems.length === 0 ? (
              <p className="mt-3 text-sm text-ink/45 dark:text-dark-muted">Nenhuma reserva requer atenção.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {problems.slice(0, 6).map((r) => (
                  <li key={r.id}>
                    <Link href={`/closetadmin/reservas/${r.id}`} className="flex items-center justify-between rounded-lg px-2.5 py-2 text-sm text-ink dark:text-dark-text hover:bg-ink/5 dark:hover:bg-white/5 transition">
                      <span className="font-medium">{r.customerName ?? 'Cliente'}</span>
                      <StatusBadge status={r.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    );
  }
}

async function loadDashboardData(adminUserId: string, today: string, in7Days: string) {
  const [calendar, pieces, problems] = await Promise.all([
    getCalendar(adminUserId, today, in7Days),
    listPieces(adminUserId),
    listReservations(adminUserId, { status: 'problem' }),
  ]);
  return { calendar, pieces, problems };
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone = 'default',
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: number;
  tone?: 'default' | 'warning';
}) {
  return (
    <Card className="flex items-center gap-3.5">
      <div className={`rounded-xl p-3 transition-colors ${
        tone === 'warning' && value > 0 
          ? 'bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400 dark:border dark:border-amber-800/40' 
          : 'bg-marsala/10 dark:bg-marsala/30 text-marsala dark:text-gold dark:border dark:border-marsala/40'
      }`}>
        <Icon size={22} />
      </div>
      <div>
        <p className="text-2xl font-bold text-ink dark:text-dark-text tracking-tight">{value}</p>
        <p className="text-xs text-ink/50 dark:text-dark-muted mt-0.5">{label}</p>
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-ink/50 dark:text-dark-muted text-xs">{label}</dt>
      <dd className="text-lg font-semibold text-ink dark:text-dark-text mt-0.5">{value}</dd>
    </div>
  );
}

function formatDatePt(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

