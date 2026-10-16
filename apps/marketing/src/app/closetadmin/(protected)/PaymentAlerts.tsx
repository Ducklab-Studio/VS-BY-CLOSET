import Link from 'next/link';
import { Banknote } from 'lucide-react';
import { AdminApiError } from '@/lib/admin-api';
import { getPaymentAlerts } from '@/lib/admin-data';
import { shopifyOrderAdminUrl } from '@/lib/closetadmin-shopify';
import {
  PAYMENT_ALERTS_VISIBLE,
  formatAlertAmount,
  hiddenAlertsCount,
  parsePaymentAlerts,
  paymentAlertHint,
  paymentAlertTitle,
  paymentAlertsHeadline,
  sinceLabel,
  type PaymentAlerts as PaymentAlertsData,
} from '@/lib/payment-alerts';

/**
 * "Pagamentos a tratar" — SOMENTE LEITURA. Mostra pedidos pagos sem reserva válida e reservas em revisão ou com
 * pagamento recebido sem peça. Não há botão que confirme, cancele, libere peça ou reembolse: a decisão é da equipe,
 * na Shopify/Reservas. Sem nome, e-mail ou telefone. Se não for possível verificar, avisa (nunca some em silêncio),
 * exceto com a API anterior ao recurso (rota ainda inexistente) ou sem permissão.
 */
export async function PaymentAlerts({ adminUserId }: { adminUserId: string }) {
  let data: PaymentAlertsData | null = null;
  let failed = false;
  try {
    data = parsePaymentAlerts(await getPaymentAlerts(adminUserId));
    failed = data === null;
  } catch (err) {
    // 400/404: API anterior ao recurso (a rota nova cai em `:id`) — janela de deploy. 403: operador sem o módulo Reservas.
    if (err instanceof AdminApiError && [400, 403, 404].includes(err.status)) return null;
    failed = true;
  }

  if (failed) {
    return (
      <p role="status" data-testid="pagamentos-a-tratar-erro" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
        Não foi possível verificar agora se há pagamentos a tratar. Atualize a página.
      </p>
    );
  }
  if (!data || data.count === 0) return null;

  const hidden = hiddenAlertsCount(data);
  return (
    <section aria-label="Pagamentos a tratar" data-testid="pagamentos-a-tratar" className="mb-5 rounded-xl border border-red-300 bg-red-50 p-4 dark:border-red-900/60 dark:bg-red-950/25">
      <h2 className="flex items-center gap-2 font-heading text-base font-semibold text-red-800 dark:text-red-300">
        <Banknote size={18} aria-hidden="true" />
        <span data-testid="pagamentos-a-tratar-titulo">{paymentAlertsHeadline(data.count)}</span>
      </h2>
      <p className="mt-1 text-sm text-red-800/80 dark:text-red-300/80">
        Dinheiro recebido que ainda precisa de uma decisão da equipe. Nada é confirmado, cancelado ou reembolsado automaticamente.
      </p>
      <ul className="mt-3 divide-y divide-red-200 dark:divide-red-900/50">
        {data.alerts.slice(0, PAYMENT_ALERTS_VISIBLE).map((alert) => {
          const amount = formatAlertAmount(alert.amount, alert.currency);
          const orderUrl = shopifyOrderAdminUrl(alert.orderId);
          return (
            <li key={alert.key} data-testid="pagamento-a-tratar" data-kind={alert.kind} className="py-2.5 text-sm">
              <p className="font-medium text-ink dark:text-dark-text">
                {paymentAlertTitle(alert.kind)}
                {alert.orderName ? <span className="ml-2 font-mono text-xs text-ink/70 dark:text-dark-muted">{alert.orderName}</span> : null}
                {amount ? <span className="ml-2 text-xs text-ink/70 dark:text-dark-muted">{amount}</span> : null}
              </p>
              <p className="mt-0.5 text-xs text-ink/70 dark:text-dark-muted">{paymentAlertHint(alert.kind)}</p>
              <p className="mt-0.5 text-xs text-ink/60 dark:text-dark-muted">
                {sinceLabel(alert.since)}
                {orderUrl ? (
                  <>
                    {' · '}
                    <a href={orderUrl} target="_blank" rel="noopener noreferrer" data-testid="pagamento-link-pedido" className="underline underline-offset-2">
                      abrir pedido na Shopify
                    </a>
                  </>
                ) : null}
                {alert.reservationId ? (
                  <>
                    {' · '}
                    <Link href={`/closetadmin/reservas/${alert.reservationId}`} data-testid="pagamento-link-reserva" className="underline underline-offset-2">
                      ver a reserva
                    </Link>
                  </>
                ) : null}
              </p>
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <p data-testid="pagamentos-a-tratar-mais" className="mt-2 text-xs text-red-800/80 dark:text-red-300/80">
          e mais {hidden} {hidden === 1 ? 'pagamento' : 'pagamentos'} a tratar.
        </p>
      ) : null}
    </section>
  );
}
