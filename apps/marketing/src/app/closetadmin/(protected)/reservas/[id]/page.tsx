import type { Metadata } from 'next';
import Link from 'next/link';
import { ExternalLink, FileDown } from 'lucide-react';
import { hasAdminRole, requireAdminModule, requireAdminSession } from '@/lib/admin-session';
import { getReservationDetail } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { shopifyOrderAdminUrl } from '@/lib/closetadmin-shopify';
import {
  Card,
  ErrorState,
  PageHeader,
  StatusBadge,
  SourceBadge,
  ArchivedBadge,
  ShopifyDeletedBadge,
  reservationStatusLabel,
} from '@/components/closetadmin/ui';
import { CancelButton } from './CancelButton';
import { OperationalButton } from './OperationalButton';
import { ReturnDialog } from './ReturnDialog';
import { ItemActionButton } from './ItemActionButton';
import {
  CONDITION_INFO,
  canCompleteCleaning,
  canRecordNotReturned,
  canReceiveItem,
  canReleaseHold,
  lateLabel,
} from '@/lib/return-inspection';
import { RestoreButton } from './RestoreButton';
import { MarkReservationViewed } from './MarkReservationViewed';

export const metadata: Metadata = { title: 'Detalhe da reserva' };

const CANCELLABLE_STATUSES = new Set(['confirmed']);

/**
 * Fase 9, item 7 — detalhe completo. Reservas ONLINE nunca mostram botão
 * de cancelar aqui (item explícito: "NÃO criar cancelamento simples" —
 * mostra o aviso e o link pro pedido Shopify em vez disso).
 */
export default async function ClosetAdminReservationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireAdminSession();
  requireAdminModule(session, 'RESERVATIONS');
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
    const isAdmin = hasAdminRole(session, 'ADMIN');
    const isOnline = reservation.source === 'online';
    const canCancel =
      !reservation.archivedAt &&
      reservation.source === 'manual_admin' &&
      CANCELLABLE_STATUSES.has(reservation.status);

    return (
      <div>
        <PageHeader
          title={reservation.customerName ?? 'Reserva'}
          description={`Criada em ${formatDateTimePt(reservation.createdAt)}`}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={`/closetadmin/reservas/${reservation.id}/pdf`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-lg border border-ink/15 dark:border-white/15 px-3.5 py-2 text-sm font-medium text-ink/70 dark:text-dark-text hover:bg-ink/5 dark:hover:bg-white/10"
              >
                <FileDown size={16} /> Exportar PDF
              </a>
              {canCancel ? <CancelButton reservationId={reservation.id} /> : null}
              {reservation.archivedAt && hasAdminRole(session, 'ADMIN') ? (
                <RestoreButton reservationId={reservation.id} />
              ) : null}
            </div>
          }
        />

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={reservation.status} />
              {reservation.needsAttention ? (
                <span
                  data-testid="reservation-new-tag"
                  className="rounded-full bg-marsala px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cream dark:bg-gold dark:text-neutral-950"
                >
                  Nova
                </span>
              ) : null}
              <MarkReservationViewed
                id={reservation.id}
                status={reservation.status}
                needsAttention={reservation.needsAttention}
              />
              <SourceBadge source={reservation.source} />
              {reservation.archivedAt ? <ArchivedBadge /> : null}
              {reservation.shopifyOrderDeletedAt ? <ShopifyDeletedBadge /> : null}
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
              <Field label="Cliente" value={reservation.customerName ?? '—'} />
              <Field label="Telefone" value={reservation.customerPhone ?? '—'} />
              <Field label="E-mail" value={reservation.customerEmail ?? '—'} />
              <Field label="Nota interna" value={reservation.internalNote ?? '—'} />
              <Field
                label="Retirada"
                value={reservation.pickupDate ? formatDatePt(reservation.pickupDate) : '—'}
              />
              <Field
                label="Devolução prevista"
                value={reservation.returnDate ? formatDatePt(reservation.returnDate) : '—'}
              />
              <Field
                label="Confirmada em"
                value={reservation.confirmedAt ? formatDateTimePt(reservation.confirmedAt) : '—'}
              />
              <Field label="Progresso das peças" value={progressLabel(reservation.items)} />
              <Field label="Atualizada em" value={formatDateTimePt(reservation.updatedAt)} />
              {reservation.archivedAt ? (
                <Field label="Arquivada em" value={formatDateTimePt(reservation.archivedAt)} />
              ) : null}
              {reservation.archiveReason ? (
                <Field label="Motivo do arquivamento" value={reservation.archiveReason} />
              ) : null}
            </dl>

            {reservation.overdueDays > 0 && !reservation.archivedAt ? (
              <div
                data-testid="aviso-atraso-reserva"
                className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
              >
                Devolução em atraso: {lateLabel(reservation.overdueDays)}. Há peça(s) prevista(s) para{' '}
                {reservation.returnDate ? formatDatePt(reservation.returnDate) : 'uma data anterior'} ainda não recebida(s).
                O atraso é só informativo: nenhuma multa ou diária é calculada.
              </div>
            ) : null}

            {reservation.shopifyOrderDeletedAt ? (
              <div
                data-testid="shopify-deleted-reason"
                className="mt-4 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-700 dark:text-red-300"
              >
                Pedido excluído na Shopify em {formatDateTimePt(reservation.shopifyOrderDeletedAt)}.{' '}
                {reservation.archivedAt
                  ? 'A reserva saiu da lista ativa; o histórico e o vínculo com o pedido foram mantidos.'
                  : 'A reserva continua na lista para revisão: ela já estava em andamento, então a peça não foi liberada automaticamente.'}
              </div>
            ) : null}

            {isOnline &&
            reservation.status === 'confirmed' &&
            !reservation.shopifyOrderDeletedAt ? (
              <div className="mt-4 rounded-lg bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/40 px-4 py-3 text-sm text-blue-800 dark:text-blue-300">
                Esta reserva está vinculada a um pedido Shopify. Cancelamentos devem considerar
                pedido/pagamento — use o Shopify Admin.
              </div>
            ) : null}

            {orderUrl && !reservation.shopifyOrderDeletedAt ? (
              <a
                href={orderUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-marsala dark:text-gold hover:underline"
              >
                Abrir pedido no Shopify <ExternalLink size={14} />
              </a>
            ) : null}
          </Card>

          <Card>
            <h2 className="font-heading text-base font-semibold text-ink dark:text-dark-text tracking-wide">
              Peças
            </h2>
            <ul className="mt-3 divide-y divide-ink/5 dark:divide-white/5">
              {reservation.items.map((item) => {
                const archived = Boolean(reservation.archivedAt);
                const canReceive = canReceiveItem(item, archived);
                const canNotReturned = canRecordNotReturned(item, archived);
                const canStartCleaning = !archived && item.status === 'returned';
                const canComplete = canCompleteCleaning(item.inspection, item.status, archived);
                const canRelease = canReleaseHold(item.inspection, item.status, isAdmin, archived);
                const canNote = !archived && ['confirmed', 'picked_up', 'returned', 'cleaning', 'completed'].includes(item.status);
                const condition = item.inspection ? CONDITION_INFO[item.inspection.condition] : null;
                return (
                  <li key={item.id} data-testid="peca-item" data-code={item.code} data-status={item.status} className="py-3 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-ink dark:text-dark-text">{item.code}</p>
                          <span data-testid="peca-situacao" className="rounded-full bg-ink/5 px-2 py-0.5 text-xs text-ink/70 dark:bg-white/10 dark:text-dark-muted">
                            {item.status === 'confirmed' || item.status === 'picked_up' ? 'Pendente de devolução' : reservationStatusLabel(item.status)}
                          </span>
                          {item.overdueDays > 0 ? (
                            <span data-testid="peca-atrasada" className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                              {lateLabel(item.overdueDays)}
                            </span>
                          ) : null}
                          {item.inspection?.awaitingRelease ? (
                            <span data-testid="peca-retida" className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950/40 dark:text-red-300">
                              Retida — aguardando liberação
                            </span>
                          ) : null}
                          {item.occurrences.some((o) => o.kind === 'not_returned') && (item.status === 'confirmed' || item.status === 'picked_up') ? (
                            <span data-testid="peca-nao-devolvida" className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950/40 dark:text-red-300">
                              Não devolvida
                            </span>
                          ) : null}
                        </div>
                        <p className="text-ink/50 dark:text-dark-muted text-xs mt-0.5">
                          {formatDatePt(item.blockedFrom)} –{' '}
                          {formatDatePt(item.blockedUntilExclusive)}
                        </p>
                        <p className="text-ink/50 dark:text-dark-muted text-xs mt-1">
                          Recebida: {item.returnedAt ? formatDateTimePt(item.returnedAt) : '—'} ·
                          Higienização:{' '}
                          {item.cleaningStartedAt ? formatDateTimePt(item.cleaningStartedAt) : '—'}{' '}
                          · Concluída:{' '}
                          {item.cleaningCompletedAt
                            ? formatDateTimePt(item.cleaningCompletedAt)
                            : '—'}
                        </p>

                        {item.inspection && condition ? (
                          <div data-testid="peca-conferencia" data-condition={item.inspection.condition} className="mt-2 rounded-lg border border-ink/10 bg-ink/[0.02] px-3 py-2 text-xs dark:border-white/10 dark:bg-white/[0.03]">
                            <p className="font-medium text-ink dark:text-dark-text">
                              Conferência: {condition.label}
                              <span className="ml-2 font-normal text-ink/55 dark:text-dark-subtle">
                                por {item.inspection.receivedByName} em {formatDateTimePt(item.inspection.receivedAt)}
                                {item.inspection.daysLate > 0 ? ` · ${lateLabel(item.inspection.daysLate)}` : ''}
                              </span>
                            </p>
                            {item.inspection.notes ? <p className="mt-1 whitespace-pre-wrap text-ink/70 dark:text-dark-muted">{item.inspection.notes}</p> : null}
                            {item.inspection.releasedAt ? (
                              <p className="mt-1 text-ink/70 dark:text-dark-muted">
                                Liberada por {item.inspection.releasedByName} em {formatDateTimePt(item.inspection.releasedAt)}: {item.inspection.releaseNote}
                              </p>
                            ) : null}
                          </div>
                        ) : null}

                        {item.occurrences.length > 0 ? (
                          <ul data-testid="peca-ocorrencias" className="mt-2 space-y-1 text-xs text-ink/70 dark:text-dark-muted">
                            {item.occurrences.map((o) => (
                              <li key={o.id}>
                                <strong>{o.kind === 'not_returned' ? 'Não devolvida' : 'Observação'}</strong> · {o.recordedByName} · {formatDateTimePt(o.recordedAt)} — {o.notes}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {canReceive ? (
                          <ReturnDialog
                            reservationId={reservation.id}
                            reservationItemId={item.id}
                            code={item.code}
                            overdueDays={item.overdueDays}
                          />
                        ) : null}
                        {canNotReturned ? (
                          <ItemActionButton reservationId={reservation.id} reservationItemId={item.id} action="not-returned" code={item.code} />
                        ) : null}
                        {canStartCleaning ? (
                          <OperationalButton
                            reservationId={reservation.id}
                            reservationItemId={item.id}
                            action="start-cleaning"
                          />
                        ) : null}
                        {canComplete ? (
                          <OperationalButton
                            reservationId={reservation.id}
                            reservationItemId={item.id}
                            action="complete-cleaning"
                          />
                        ) : null}
                        {canRelease ? (
                          <ItemActionButton reservationId={reservation.id} reservationItemId={item.id} action="release-hold" code={item.code} />
                        ) : null}
                        {canNote ? (
                          <ItemActionButton reservationId={reservation.id} reservationItemId={item.id} action="note" code={item.code} />
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>

        <Card className="mt-4">
          <h2 className="font-heading text-base font-semibold text-ink dark:text-dark-text tracking-wide">
            Eventos
          </h2>
          {reservation.events.length === 0 ? (
            <p className="mt-2 text-sm text-ink/65 dark:text-dark-muted">
              Nenhum evento registrado.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-ink/5 dark:divide-white/5">
              {reservation.events.map((event, i) => (
                <li key={i} className="flex items-center justify-between gap-4 py-2.5 text-sm">
                  <span className="font-medium text-ink dark:text-dark-text">{event.type}</span>
                  <span className="text-xs text-ink/65 dark:text-dark-subtle">
                    {formatDateTimePt(event.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Link
          href="/closetadmin/reservas"
          className="mt-4 inline-block text-sm text-ink/50 dark:text-dark-muted hover:text-ink dark:hover:text-cream transition"
        >
          ← Voltar para reservas
        </Link>
      </div>
    );
  }
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink/65 dark:text-dark-muted text-xs">{label}</dt>
      <dd className="mt-0.5 font-medium text-ink dark:text-dark-text">{value}</dd>
    </div>
  );
}

function progressLabel(items: readonly { status: string }[]): string {
  const completed = items.filter((item) => item.status === 'completed').length;
  return `${completed}/${items.length} concluídas`;
}

function formatDatePt(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function formatDateTimePt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { timeZone: 'America/Santiago' });
}
