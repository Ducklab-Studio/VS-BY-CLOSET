/** Fase 9 — peças de UI compartilhadas entre as telas do ClosetAdmin
 *  (item "UX/Design": loading, skeleton, empty, error, badge). Mantidas
 *  num único arquivo pequeno de propósito — nenhuma delas tem lógica de
 *  negócio, só apresentação. */

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-ink/15 dark:border-white/10 bg-white dark:bg-dark-card/60 px-6 py-14 text-center transition-colors">
      <p className="font-medium text-ink/70 dark:text-dark-text">{title}</p>
      {description ? <p className="text-sm text-ink/65 dark:text-dark-muted">{description}</p> : null}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-5 py-4 text-sm text-red-700 dark:text-red-300">
      <p className="font-medium">Não foi possível carregar esta tela.</p>
      <p className="mt-0.5 text-red-600/90 dark:text-red-400">{message}</p>
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-ink/10 dark:bg-white/10 ${className}`} />;
}

const STATUS_STYLES: Record<string, string> = {
  hold: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 dark:border dark:border-amber-700/40',
  pending_payment: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 dark:border dark:border-amber-700/40',
  confirmed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border dark:border-emerald-700/40',
  picked_up: 'bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300 dark:border dark:border-sky-700/40',
  cancelled: 'bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400 dark:border dark:border-neutral-700/50',
  expired: 'bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400 dark:border dark:border-neutral-700/50',
  problem: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300 dark:border dark:border-red-700/40',
  preparing: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 dark:border dark:border-amber-700/40',
  ready_for_pickup: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border dark:border-emerald-700/40',
  cleaning: 'bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300 dark:border dark:border-sky-700/40',
  returned: 'bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400 dark:border dark:border-neutral-700/50',
  completed: 'bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400 dark:border dark:border-neutral-700/50',
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 dark:border dark:border-amber-700/40',
};

/**
 * Cobre os 13 valores de `ReservationStatus` (schema.prisma), não só os
 * do caminho feliz: faltavam os quatro operacionais de
 * OCCUPYING_RESERVATION_STATUSES (preparing/ready_for_pickup/returned/
 * cleaning) e os dois legados, e o fallback `?? status` imprimia o
 * identificador cru em inglês no painel. Visto de verdade na lista de
 * reservas: uma reserva devolvida aparecia como "returned" no meio de
 * "Confirmada"/"Cancelada".
 */
const STATUS_LABELS: Record<string, string> = {
  hold: 'Em espera',
  pending_payment: 'Aguardando pagamento',
  confirmed: 'Confirmada',
  preparing: 'Em preparação',
  ready_for_pickup: 'Pronta para retirada',
  picked_up: 'Retirada',
  returned: 'Devolvida',
  cleaning: 'Em higienização',
  cancelled: 'Cancelada',
  expired: 'Expirada',
  problem: 'Requer atenção',
  completed: 'Concluída',
  pending: 'Pendente',
};

/** Mesma tradução do StatusBadge, para onde o status aparece como texto
 *  corrido (ex.: a faixa bloqueada de cada peça no detalhe da reserva) —
 *  nunca reimprimir o identificador do enum na tela. */
export function reservationStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium tracking-wide shadow-sm transition-colors ${STATUS_STYLES[status] ?? 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300'}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function SourceBadge({ source }: { source: string }) {
  const isManual = source === 'manual_admin';
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium tracking-wide shadow-sm transition-colors ${isManual ? 'bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300 dark:border dark:border-violet-700/40' : 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 dark:border dark:border-blue-700/40'}`}>
      {isManual ? 'Manual' : 'Online'}
    </span>
  );
}

/** "Limpar históricos" — selo discreto pra reserva arquivada; nunca
 *  substitui o StatusBadge (arquivamento não é um status, é só um
 *  filtro de listagem por cima do status real). */
export function ArchivedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-neutral-200/70 px-2.5 py-1 text-xs font-medium tracking-wide text-neutral-600 dark:bg-white/5 dark:text-dark-subtle">
      Arquivada
    </span>
  );
}

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-ink/10 dark:border-white/10 bg-white dark:bg-dark-card p-5 dark:shadow-md dark:shadow-black/30 transition-colors ${className}`}>{children}</div>;
}

export function PageHeader({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="font-heading text-2xl font-bold text-ink dark:text-dark-text tracking-wide">{title}</h1>
        {description ? <p className="mt-1 text-sm text-ink/55 dark:text-dark-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

