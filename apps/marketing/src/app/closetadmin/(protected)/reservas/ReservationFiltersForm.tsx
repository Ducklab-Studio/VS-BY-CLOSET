'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Filter, RotateCcw, Search } from 'lucide-react';
import { ClearListButton } from './ClearListButton';

const STATUS_OPTIONS = [
  { value: '', label: 'Todos os status' },
  { value: 'hold', label: 'Em espera' },
  { value: 'pending_payment', label: 'Aguardando pagamento' },
  { value: 'confirmed', label: 'Confirmada' },
  // Etapas operacionais que existem no enum e ocupam peça
  // (OCCUPYING_RESERVATION_STATUSES) mas não eram filtráveis — uma
  // reserva nesses estados só aparecia em "Todos os status".
  { value: 'preparing', label: 'Em preparação' },
  { value: 'ready_for_pickup', label: 'Pronta para retirada' },
  { value: 'picked_up', label: 'Retirada' },
  { value: 'returned', label: 'Devolvida' },
  { value: 'cleaning', label: 'Em higienização' },
  { value: 'cancelled', label: 'Cancelada' },
  { value: 'expired', label: 'Expirada' },
  { value: 'problem', label: 'Requer atenção' },
];

const inputClass =
  'w-full rounded-lg border border-ink/15 bg-white px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink/40 focus:border-marsala focus:ring-2 focus:ring-marsala/20 dark:border-white/15 dark:bg-dark-surface dark:text-dark-text dark:placeholder:text-dark-subtle dark:focus:border-gold dark:focus:ring-gold/20';

export function ReservationFiltersForm({
  initial,
  showClearList = false,
  estimatedArchivableCount = 0,
}: {
  initial: Record<string, string | undefined>;
  /** Só ADMIN vê "Limpar lista" — decidido no server (page.tsx), o
   *  mesmo padrão já usado pelo resto do ClosetAdmin. */
  showClearList?: boolean;
  estimatedArchivableCount?: number;
}) {
  const router = useRouter();
  const [values, setValues] = useState({
    status: initial.status ?? '',
    source: initial.source ?? '',
    customer: initial.customer ?? '',
    phone: initial.phone ?? '',
    unitCode: initial.unitCode ?? '',
    code: initial.code ?? '',
    from: initial.from ?? '',
    to: initial.to ?? '',
  });
  const [includeArchived, setIncludeArchived] = useState(initial.includeArchived === 'true');
  const [archivedOnly, setArchivedOnly] = useState(initial.archivedOnly === 'true');

  const activeCount = Object.values(values).filter(Boolean).length + (includeArchived ? 1 : 0) + (archivedOnly ? 1 : 0);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
      if (value) params.set(key, value);
    }
    if (archivedOnly) params.set('archivedOnly', 'true');
    else if (includeArchived) params.set('includeArchived', 'true');
    router.push(`/closetadmin/reservas${params.toString() ? `?${params.toString()}` : ''}`);
  }

  function clearFilters() {
    setValues({ status: '', source: '', customer: '', phone: '', unitCode: '', code: '', from: '', to: '' });
    setIncludeArchived(false);
    setArchivedOnly(false);
    router.push('/closetadmin/reservas');
  }

  return (
    <form onSubmit={submit} className="mt-5 rounded-xl border border-ink/10 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-dark-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-marsala/10 p-2 text-marsala dark:bg-gold/10 dark:text-gold">
            <Filter size={16} />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-ink dark:text-dark-text">Filtros de reservas</h2>
            <p className="text-xs text-ink/45 dark:text-dark-subtle">
              {activeCount > 0 ? `${activeCount} filtro${activeCount === 1 ? '' : 's'} ativo${activeCount === 1 ? '' : 's'}` : 'Busque por operação, cliente ou peça física.'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {activeCount > 0 ? (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium text-ink/55 transition hover:bg-ink/5 hover:text-ink dark:text-dark-muted dark:hover:bg-white/5 dark:hover:text-dark-text"
            >
              <RotateCcw size={14} />
              Limpar filtros
            </button>
          ) : null}
          {showClearList ? <ClearListButton estimatedCount={estimatedArchivableCount} /> : null}
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Field label="Status">
          <select
            value={values.status}
            onChange={(e) => setValues((v) => ({ ...v, status: e.target.value }))}
            className={inputClass}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value} className="bg-white text-ink dark:bg-dark-popover dark:text-dark-text">
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Origem">
          <select
            value={values.source}
            onChange={(e) => setValues((v) => ({ ...v, source: e.target.value }))}
            className={inputClass}
          >
            <option value="" className="bg-white text-ink dark:bg-dark-popover dark:text-dark-text">Todas as origens</option>
            <option value="online" className="bg-white text-ink dark:bg-dark-popover dark:text-dark-text">Online</option>
            <option value="manual_admin" className="bg-white text-ink dark:bg-dark-popover dark:text-dark-text">Manual</option>
          </select>
        </Field>

        <Field label="Retirada a partir de">
          <input
            type="date"
            value={values.from}
            onChange={(e) => setValues((v) => ({ ...v, from: e.target.value }))}
            className={inputClass}
          />
        </Field>

        <Field label="Retirada até">
          <input
            type="date"
            value={values.to}
            onChange={(e) => setValues((v) => ({ ...v, to: e.target.value }))}
            className={inputClass}
          />
        </Field>

        <Field label="Cliente">
          <input
            placeholder="Nome do cliente"
            value={values.customer}
            onChange={(e) => setValues((v) => ({ ...v, customer: e.target.value }))}
            className={inputClass}
          />
        </Field>

        <Field label="Telefone">
          <input
            placeholder="Telefone do cliente"
            value={values.phone}
            onChange={(e) => setValues((v) => ({ ...v, phone: e.target.value }))}
            className={inputClass}
          />
        </Field>

        <Field label="Código da peça">
          <input
            placeholder="Ex.: VS-SOB-001"
            value={values.unitCode}
            onChange={(e) => setValues((v) => ({ ...v, unitCode: e.target.value }))}
            className={inputClass}
          />
        </Field>

        <Field label="Código da reserva">
          <input
            placeholder="Ex.: A1B2C3D4"
            value={values.code}
            onChange={(e) => setValues((v) => ({ ...v, code: e.target.value }))}
            className={inputClass}
          />
        </Field>

        <div className="flex flex-col justify-end gap-2 pb-1 text-sm">
          <label className="flex items-center gap-2 text-ink dark:text-dark-text">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => {
                setIncludeArchived(e.target.checked);
                if (e.target.checked) setArchivedOnly(false);
              }}
            />
            Mostrar arquivadas
          </label>
          <label className="flex items-center gap-2 text-ink dark:text-dark-text">
            <input
              type="checkbox"
              checked={archivedOnly}
              onChange={(e) => {
                setArchivedOnly(e.target.checked);
                if (e.target.checked) setIncludeArchived(false);
              }}
            />
            Somente histórico arquivado
          </label>
        </div>

        <div className="flex items-end">
          <button
            type="submit"
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-marsala px-4 py-2.5 text-sm font-medium text-white transition hover:brightness-110 dark:bg-gold dark:text-neutral-950"
          >
            <Search size={15} />
            Aplicar filtros
          </button>
        </div>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink/55 dark:text-dark-muted">{label}</span>
      {children}
    </label>
  );
}
