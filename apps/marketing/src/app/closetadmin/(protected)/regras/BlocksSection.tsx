'use client';

import { useState } from 'react';
import type { BlockItem, PieceListItem } from '@/lib/admin-data';
import { ConfirmDialog } from '@/components/closetadmin/ConfirmDialog';
import { EmptyState } from '@/components/closetadmin/ui';
import { createBlockAction, removeBlockAction } from './actions';

const inputClass =
  'rounded-lg border border-ink/15 dark:border-white/15 bg-white dark:bg-dark-surface px-3 py-2 text-sm text-ink dark:text-dark-text outline-none transition focus:border-marsala dark:focus:border-gold focus:ring-2 focus:ring-marsala/20 dark:focus:ring-gold/20 placeholder:text-ink/40 dark:placeholder:text-dark-subtle';

/**
 * Item 13 — "Bloqueio deve afetar o BACKEND... Nunca fazer bloqueio
 * somente visual." Esta seção só CRIA/REMOVE via os Server Actions, que
 * chamam o reservations-api de verdade — o efeito real (disponibilidade,
 * calendário, reserva manual) já está garantido no backend, não aqui.
 */
export function BlocksSection({ blocks, pieces }: { blocks: BlockItem[]; pieces: PieceListItem[] }) {
  const [scope, setScope] = useState<'STORE_WIDE' | 'UNIT'>('STORE_WIDE');
  const [rentalUnitId, setRentalUnitId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!startDate || !endDate || reason.trim().length < 3) {
      setError('Preencha as datas e um motivo (mínimo 3 caracteres).');
      return;
    }
    setPending(true);
    setError(null);
    const result = await createBlockAction({ scope, rentalUnitId: scope === 'UNIT' ? rentalUnitId : undefined, startDate, endDate, reason: reason.trim() });
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setStartDate('');
    setEndDate('');
    setReason('');
    setRentalUnitId('');
  }

  return (
    <div>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3 rounded-xl border border-ink/10 dark:border-white/10 bg-white dark:bg-dark-card p-4 shadow-sm transition-colors">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-ink/70 dark:text-dark-muted">Escopo</span>
          <select value={scope} onChange={(e) => setScope(e.target.value as 'STORE_WIDE' | 'UNIT')} className={inputClass}>
            <option value="STORE_WIDE" className="bg-white dark:bg-dark-popover text-ink dark:text-dark-text">Loja inteira</option>
            <option value="UNIT" className="bg-white dark:bg-dark-popover text-ink dark:text-dark-text">Peça específica</option>
          </select>
        </label>

        {scope === 'UNIT' ? (
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-ink/70 dark:text-dark-muted">Peça</span>
            <select value={rentalUnitId} onChange={(e) => setRentalUnitId(e.target.value)} className={inputClass}>
              <option value="" className="bg-white dark:bg-dark-popover text-ink dark:text-dark-text">Selecione…</option>
              {pieces.map((p) => (
                <option key={p.id} value={p.id} className="bg-white dark:bg-dark-popover text-ink dark:text-dark-text">
                  {p.code}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-ink/70 dark:text-dark-muted">De</span>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-ink/70 dark:text-dark-muted">Até</span>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={inputClass} />
        </label>
        <label className="flex min-w-[14rem] flex-1 flex-col gap-1.5 text-sm">
          <span className="font-medium text-ink/70 dark:text-dark-muted">Motivo</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: manutenção, evento" className={inputClass} />
        </label>

        <button type="submit" disabled={pending} className="rounded-lg bg-marsala dark:bg-marsala-light px-4 py-2 text-sm font-medium text-cream dark:text-sand hover:bg-marsala/90 dark:hover:bg-marsala-glow transition disabled:opacity-60 shadow-sm">
          {pending ? 'Criando…' : 'Criar bloqueio'}
        </button>
      </form>

      {error ? <p className="mt-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/40 px-3.5 py-2.5 text-sm text-red-700 dark:text-red-300">{error}</p> : null}

      <div className="mt-4">
        {blocks.length === 0 ? (
          <EmptyState title="Nenhum bloqueio ativo" />
        ) : (
          <ul className="divide-y divide-ink/5 dark:divide-white/5 rounded-xl border border-ink/10 dark:border-white/10 bg-white dark:bg-dark-card shadow-sm transition-colors">
            {blocks.map((block) => (
              <li key={block.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <div>
                  <span className="font-medium text-ink dark:text-dark-text">{block.scope === 'STORE_WIDE' ? 'Loja inteira' : block.rentalUnitCode}</span>
                  <span className="ml-2 text-ink/50 dark:text-dark-muted font-mono text-xs">
                    {block.startDate} – {block.endDate}
                  </span>
                  <p className="text-ink/45 dark:text-dark-muted mt-0.5">{block.reason}</p>
                </div>
                <ConfirmDialog
                  trigger={<button type="button" className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50/50 dark:bg-red-950/30 px-3 py-1.5 text-xs font-medium text-red-700 dark:text-red-400 hover:bg-red-100/60 dark:hover:bg-red-900/40 transition">Remover</button>}
                  title="Remover este bloqueio?"
                  description="A peça/loja volta a ficar disponível normalmente para o período."
                  confirmLabel="Remover"
                  danger
                  onConfirm={async () => {
                    const result = await removeBlockAction(block.id);
                    if (result.error) throw new Error(result.error);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
