import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { AdminApiError } from '@/lib/admin-api';
import { getHeldPieceAlerts } from '@/lib/admin-data';
import { StatusBadge } from '@/components/closetadmin/ui';
import {
  headline,
  holdConditionLabel,
  otherReservationsLabel,
  parseHeldAlerts,
  pickupLabel,
  reservationLabel,
  urgencyOf,
  type HeldAlert,
} from '@/lib/held-alerts';

/**
 * Alerta operacional — SOMENTE LEITURA. Mostra peças retidas por manutenção/avaria que têm
 * reserva futura dependendo delas, para a equipe agir (repor a peça, falar com a cliente).
 * Não há botão que cancele, libere ou altere algo: reservas, pagamentos e a peça ficam como
 * estão. Sem telefone nem e-mail. Se não for possível verificar, avisa (nunca some em silêncio),
 * exceto com a API anterior ao recurso (ainda sem esta rota) ou sem permissão.
 */
export async function HeldPieceAlerts({ adminUserId }: { adminUserId: string }) {
  let alerts: HeldAlert[] | null = null;
  let failed = false;
  try {
    alerts = parseHeldAlerts(await getHeldPieceAlerts(adminUserId));
    failed = alerts === null;
  } catch (err) {
    // 404/400: API anterior ao recurso (a rota nova cai em `:id` e o UUID é recusado) — janela de deploy.
    // 403: operador sem o módulo Reservas. Em nenhum dos casos há o que avisar.
    if (err instanceof AdminApiError && [400, 403, 404].includes(err.status)) return null;
    failed = true;
  }

  if (failed) {
    return (
      <p role="status" data-testid="alerta-retidas-erro" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
        Não foi possível verificar agora se há peças retidas com reserva futura. Atualize a página.
      </p>
    );
  }
  if (!alerts || alerts.length === 0) return null;

  return (
    <section aria-label="Peças retidas com reserva futura" data-testid="alerta-retidas" className="mb-5 rounded-xl border border-red-300 bg-red-50 p-4 dark:border-red-900/60 dark:bg-red-950/25">
      <h2 className="flex items-center gap-2 font-heading text-base font-semibold text-red-800 dark:text-red-300">
        <AlertTriangle size={18} aria-hidden="true" />
        <span data-testid="alerta-retidas-titulo">{headline(alerts.length)}</span>
      </h2>
      <p className="mt-1 text-sm text-red-800/80 dark:text-red-300/80">
        A peça está fora do estoque (manutenção ou avaria) e há cliente esperando por ela. Providencie reposição ou fale com a cliente. Nenhuma reserva, pagamento ou peça foi alterado automaticamente.
      </p>
      <ul className="mt-3 divide-y divide-red-200 dark:divide-red-900/50">
        {alerts.map((alert) => {
          const next = alert.nextReservation;
          const urgency = urgencyOf(next.daysUntilPickup);
          const others = otherReservationsLabel(alert.affectedCount);
          return (
            <li key={alert.reservationItemId} data-testid="alerta-retida" data-code={alert.code} data-urgency={urgency} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 py-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium text-ink dark:text-dark-text">
                  <span className="font-mono">{alert.code}</span>
                  <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950/50 dark:text-red-300">{holdConditionLabel(alert.condition)}</span>
                </p>
                <p className="mt-0.5 text-xs text-ink/60 dark:text-dark-muted">
                  Retida desde {formatDatePt(alert.heldSince.slice(0, 10))} ·{' '}
                  <Link href={`/closetadmin/reservas/${alert.heldReservationId}`} className="underline-offset-2 hover:underline">
                    ver a devolução
                  </Link>
                </p>
              </div>
              <div className="min-w-0 sm:text-right">
                <p className="text-ink dark:text-dark-text">
                  <Link href={`/closetadmin/reservas/${next.id}`} data-testid="alerta-reserva-afetada" className="font-medium text-marsala underline-offset-2 hover:underline dark:text-gold">
                    {reservationLabel(next)}
                  </Link>{' '}
                  <span className="ml-1 inline-block align-middle"><StatusBadge status={next.status} /></span>
                </p>
                <p className={`text-xs ${urgency === 'urgent' ? 'font-semibold text-red-700 dark:text-red-300' : 'text-ink/70 dark:text-dark-muted'}`}>
                  Retirada em {formatDatePt(next.pickupDate)} ({pickupLabel(next.daysUntilPickup)})
                </p>
                {others ? <p className="text-xs text-ink/60 dark:text-dark-muted">{others}</p> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function formatDatePt(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
