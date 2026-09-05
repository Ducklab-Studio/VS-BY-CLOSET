import type { Metadata } from 'next';
import Link from 'next/link';
import { ExternalLink, FileDown } from 'lucide-react';
import { requireAdminSession } from '@/lib/admin-session';
import { getReservationDetail } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { shopifyOrderAdminUrl } from '@/lib/closetadmin-shopify';
import { Card, ErrorState, PageHeader, StatusBadge, SourceBadge } from '@/components/closetadmin/ui';
import { CancelButton } from './CancelButton';

export const metadata: Metadata = { title: 'Detalhe da reserva' };

const CANCELLABLE_STATUSES = new Set(['hold', 'pending_payment', 'confirmed']);

/**
 * Fase 9, item 7 — detalhe completo. Reservas ONLINE nunca mostram botão
 * de cancelar aqui (item explícito: "NÃO criar cancelamento simples" —
 * mostra o aviso e o link pro pedido Shopify em vez disso).
 */
export default async function ClosetAdminReservationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminSession();
  const { id } = await params;

  let reservation: Awaited<ReturnType<typeof getReservationDetail>> | null = null;
  let errorMessage: string | null = null;
  try {
    reservation = await getReservationDetail(session.id, id);
  } catch (err) {
    errorMessage = err instanceof AdminApiError ? err.message : 'Erro inesperado.';
  }

  if (!reservation) {
    return <ErrorState message={errorMessage ?? 'Erro inesperado.'} />;
  }

  {
    const orderUrl = shopifyOrderAdminUrl(reservation.shopifyOrderId);
    const isOnline = reservation.source === 'online';
    const canCancel = reservation.source === 'manual_admin' && CANCELLABLE_STATUSES.has(reservation.status);

    return (
      <div>
        <PageHeader
          title={reservation.customerName ?? 'Reserva'}
          description={`Criada em ${formatDateTimePt(reservation.createdAt)}`}
          action={
            <div className="flex items-center gap-2">
              <a
                href={`/closetadmin/reservas/${reservation.id}/pdf`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-lg border border-ink/15 dark:border-white/15 px-3.5 py-2 text-sm font-medium text-ink/70 dark:text-dark-text hover:bg-ink/5 dark:hover:bg-white/10"
              >
                <FileDown size={16} /> Exportar PDF
              </a>
              {canCancel ? <CancelButton reservationId={reservation.id} /> : null}
            </div>
          }
        />

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={reservation.status} />
              <SourceBadge source={reservation.source} />
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
              <Field label="Cliente" value={reservation.customerName ?? '—'} />
              <Field label="Telefone" value={reservation.customerPhone ?? '—'} />
              <Field label="E-mail" value={reservation.customerEmail ?? '—'} />
              <Field label="Nota interna" value={reservation.internalNote ?? '—'} />
              <Field label="Retirada" value={reservation.pickupDate ? formatDatePt(reservation.pickupDate) : '—'} />
              <Field label="Devolução" value={reservation.returnDate ? formatDatePt(reservation.returnDate) : '—'} />
              <Field label="Confirmada em" value={reservation.confirmedAt ? formatDateTimePt(reservation.confirmedAt) : '—'} />
              <Field label="Atualizada em" value={formatDateTimePt(reservation.updatedAt)} />
            </dl>

            {isOnline ? (
              <div className="mt-4 rounded-lg bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/40 px-4 py-3 text-sm text-blue-800 dark:text-blue-300">
                Esta reserva está vinculada a um pedido Shopify. Cancelamentos devem considerar pedido/pagamento — use o Shopify Admin.
              </div>
            ) : null}

            {orderUrl ? (
              <a href={orderUrl} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-marsala dark:text-gold hover:underline">
                Abrir pedido no Shopify <ExternalLink size={14} />
              </a>
            ) : null}
          </Card>

          <Card>
            <h2 className="font-heading text-base font-semibold text-ink dark:text-dark-text tracking-wide">Peças</h2>
            <ul className="mt-3 divide-y divide-ink/5 dark:divide-white/5">
              {reservation.items.map((item) => (
                <li key={item.rentalUnitId} className="py-2.5 text-sm">
                  <p className="font-medium text-ink dark:text-dark-text">{item.code}</p>
                  <p className="text-ink/50 dark:text-dark-muted text-xs mt-0.5">
                    {formatDatePt(item.blockedFrom)} – {formatDatePt(item.blockedUntilExclusive)} · <span className="uppercase">{item.status}</span>
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <Card className="mt-4">
          <h2 className="font-heading text-base font-semibold text-ink dark:text-dark-text tracking-wide">Eventos</h2>
          {reservation.events.length === 0 ? (
            <p className="mt-2 text-sm text-ink/45 dark:text-dark-muted">Nenhum evento registrado.</p>
          ) : (
            <ul className="mt-3 divide-y divide-ink/5 dark:divide-white/5">
              {reservation.events.map((event, i) => (
                <li key={i} className="py-2.5 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-ink dark:text-dark-text">{event.type}</span>
                    <span className="text-xs text-ink/45 dark:text-dark-subtle">{formatDateTimePt(event.createdAt)}</span>
                  </div>
                  {event.detail ? (
                    <pre className="mt-1 overflow-x-auto rounded-lg bg-ink/5 dark:bg-black/40 border border-ink/5 dark:border-white/5 p-2 text-xs text-ink/60 dark:text-sand/80 font-mono">
                      {JSON.stringify(event.detail, null, 2)}
                    </pre>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Link href="/closetadmin/reservas" className="mt-4 inline-block text-sm text-ink/50 dark:text-dark-muted hover:text-ink dark:hover:text-cream transition">
          ← Voltar para reservas
        </Link>
      </div>
    );
  }
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink/45 dark:text-dark-muted text-xs">{label}</dt>
      <dd className="mt-0.5 font-medium text-ink dark:text-dark-text">{value}</dd>
    </div>
  );
}

function formatDatePt(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function formatDateTimePt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { timeZone: 'America/Santiago' });
}
