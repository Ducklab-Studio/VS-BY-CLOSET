import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { PAYMENT_CONFLICT_LIST_HREF, conflictHeadline } from '@/lib/payment-conflict';

/**
 * Alerta de pagamento recebido com conflito de disponibilidade. SOMENTE informação e link para a
 * lista já filtrada: não confirma, não cancela, não libera peça e não reembolsa. Sem dados de
 * cliente. `compact` = versão discreta de uma linha, para a lista de reservas.
 */
export function PaymentConflictAlert({ count, compact = false }: { count: number; compact?: boolean }) {
  if (count <= 0) return null;
  if (compact) {
    return (
      <p
        data-testid="alerta-conflito-pagamento"
        className="mb-4 flex flex-wrap items-center gap-x-2 rounded-lg border border-orange-300 bg-orange-50 px-3 py-2 text-sm text-orange-900 dark:border-orange-900/60 dark:bg-orange-950/25 dark:text-orange-200"
      >
        <AlertTriangle size={15} aria-hidden="true" className="shrink-0" />
        <span data-testid="alerta-conflito-titulo">{conflictHeadline(count)}.</span>
        <Link href={PAYMENT_CONFLICT_LIST_HREF} data-testid="alerta-conflito-link" className="font-medium underline underline-offset-2">
          Ver só essas
        </Link>
      </p>
    );
  }
  return (
    <section
      aria-label="Pagamentos recebidos com conflito de disponibilidade"
      data-testid="alerta-conflito-pagamento"
      className="mb-5 rounded-xl border border-orange-300 bg-orange-50 p-4 dark:border-orange-900/60 dark:bg-orange-950/25"
    >
      <h2 className="flex items-center gap-2 font-heading text-base font-semibold text-orange-900 dark:text-orange-200">
        <AlertTriangle size={18} aria-hidden="true" />
        <span data-testid="alerta-conflito-titulo">{conflictHeadline(count)}</span>
      </h2>
      <p className="mt-1 text-sm text-orange-900/80 dark:text-orange-200/80">
        A cliente pagou, mas a peça já estava ocupada e a reserva não pôde ser confirmada. Exige ação da equipe: verifique o pagamento na Shopify e
        decida entre atendimento alternativo ou reembolso. Nada foi confirmado, cancelado ou reembolsado automaticamente.
      </p>
      <Link
        href={PAYMENT_CONFLICT_LIST_HREF}
        data-testid="alerta-conflito-link"
        className="mt-2 inline-block text-sm font-medium text-orange-900 underline underline-offset-2 dark:text-orange-200"
      >
        Ver as reservas em conflito
      </Link>
    </section>
  );
}
