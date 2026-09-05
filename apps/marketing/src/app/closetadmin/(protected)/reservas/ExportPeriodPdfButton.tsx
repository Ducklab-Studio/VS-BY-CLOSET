'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { FileDown } from 'lucide-react';

const inputClass =
  'rounded-lg border border-ink/15 dark:border-white/15 bg-white dark:bg-dark-surface px-3 py-2 text-sm text-ink dark:text-dark-text outline-none focus:border-marsala dark:focus:border-gold focus:ring-2 focus:ring-marsala/20 dark:focus:ring-gold/20';

/**
 * Fase 10, item 2 — relatório de reservas por período em PDF. Reaproveita
 * os filtros JÁ aplicados na tela (status/origem/cliente/telefone/código
 * — vindos da própria URL) e só pede o período, que a lista de reservas
 * não tem campo pra hoje. Abre em nova aba — nunca substitui a tela
 * atual, então o operador não perde o filtro que já tinha montado.
 */
export function ExportPeriodPdfButton() {
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!from || !to) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set('from', from);
    params.set('to', to);
    window.open(`/closetadmin/reservas/pdf?${params.toString()}`, '_blank');
    setOpen(false);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg border border-ink/15 dark:border-white/15 px-3.5 py-2 text-sm font-medium text-ink/70 dark:text-dark-text hover:bg-ink/5 dark:hover:bg-white/10"
      >
        <FileDown size={16} /> Exportar PDF
      </button>

      {open ? (
        <div className="absolute right-0 top-full z-10 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-ink/10 dark:border-white/10 bg-white dark:bg-dark-card p-4 shadow-lg">
          <p className="mb-3 text-sm font-medium text-ink dark:text-dark-text">Relatório por período</p>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs text-ink/60 dark:text-dark-muted">
              De
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required className={inputClass} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-ink/60 dark:text-dark-muted">
              Até
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} required className={inputClass} />
            </label>
            <button type="submit" className="rounded-lg bg-marsala dark:bg-marsala-light px-3.5 py-2 text-sm font-medium text-cream dark:text-sand hover:bg-marsala/90">
              Gerar PDF
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
