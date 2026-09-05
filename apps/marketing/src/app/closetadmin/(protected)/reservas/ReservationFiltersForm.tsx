'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

const STATUS_OPTIONS = [
  { value: '', label: 'Todos os status' },
  { value: 'hold', label: 'Em espera' },
  { value: 'pending_payment', label: 'Aguardando pagamento' },
  { value: 'confirmed', label: 'Confirmada' },
  { value: 'picked_up', label: 'Retirada' },
  { value: 'cancelled', label: 'Cancelada' },
  { value: 'expired', label: 'Expirada' },
  { value: 'problem', label: 'Requer atenção' },
];

const inputClass =
  'rounded-lg border border-ink/15 dark:border-white/15 bg-white dark:bg-dark-surface px-3 py-2 text-sm text-ink dark:text-dark-text outline-none transition focus:border-marsala dark:focus:border-gold focus:ring-2 focus:ring-marsala/20 dark:focus:ring-gold/20 placeholder:text-ink/40 dark:placeholder:text-dark-subtle';

export function ReservationFiltersForm({ initial }: { initial: Record<string, string | undefined> }) {
  const router = useRouter();
  const [values, setValues] = useState({
    status: initial.status ?? '',
    source: initial.source ?? '',
    customer: initial.customer ?? '',
    phone: initial.phone ?? '',
    unitCode: initial.unitCode ?? '',
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
      if (value) params.set(key, value);
    }
    router.push(`/closetadmin/reservas${params.toString() ? `?${params.toString()}` : ''}`);
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-3">
      <select
        value={values.status}
        onChange={(e) => setValues((v) => ({ ...v, status: e.target.value }))}
        className={inputClass}
      >
        {STATUS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value} className="bg-white dark:bg-dark-popover text-ink dark:text-dark-text">
            {o.label}
          </option>
        ))}
      </select>

      <select value={values.source} onChange={(e) => setValues((v) => ({ ...v, source: e.target.value }))} className={inputClass}>
        <option value="" className="bg-white dark:bg-dark-popover text-ink dark:text-dark-text">Todas as origens</option>
        <option value="online" className="bg-white dark:bg-dark-popover text-ink dark:text-dark-text">Online</option>
        <option value="manual_admin" className="bg-white dark:bg-dark-popover text-ink dark:text-dark-text">Manual</option>
      </select>

      <input
        placeholder="Cliente"
        value={values.customer}
        onChange={(e) => setValues((v) => ({ ...v, customer: e.target.value }))}
        className={inputClass}
      />
      <input placeholder="Telefone" value={values.phone} onChange={(e) => setValues((v) => ({ ...v, phone: e.target.value }))} className={inputClass} />
      <input
        placeholder="Código da peça"
        value={values.unitCode}
        onChange={(e) => setValues((v) => ({ ...v, unitCode: e.target.value }))}
        className={inputClass}
      />

      <button type="submit" className="rounded-lg bg-ink/5 dark:bg-white/10 px-4 py-2 text-sm font-medium text-ink/70 dark:text-dark-text hover:bg-ink/10 dark:hover:bg-white/15 transition">
        Filtrar
      </button>
    </form>
  );
}
