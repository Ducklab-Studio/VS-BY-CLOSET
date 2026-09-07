'use client';

import { useMemo, useState } from 'react';
import { Ban, CalendarRange, Package, Plus, Store, Trash2 } from 'lucide-react';
import type { BlockItem, PieceListItem } from '@/lib/admin-data';
import { ConfirmDialog } from '@/components/closetadmin/ConfirmDialog';
import { EmptyState } from '@/components/closetadmin/ui';
import { createBlockAction, removeBlockAction } from './actions';

const inputClass =
  'w-full rounded-lg border border-ink/15 bg-white px-3 py-2.5 text-sm text-ink outline-none transition focus:border-marsala focus:ring-2 focus:ring-marsala/20 dark:border-white/15 dark:bg-dark-surface dark:text-dark-text dark:focus:border-gold dark:focus:ring-gold/20';

export function BlocksSection({ blocks, pieces }: { blocks: BlockItem[]; pieces: PieceListItem[] }) {
  const [scope, setScope] = useState<'STORE_WIDE' | 'UNIT'>('STORE_WIDE');
  const [rentalUnitId, setRentalUnitId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedPiece = useMemo(() => pieces.find((piece) => piece.id === rentalUnitId), [pieces, rentalUnitId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    if (!startDate || !endDate || reason.trim().length < 3) {
      setError('Preencha as datas e um motivo com pelo menos 3 caracteres.');
      return;
    }
    if (scope === 'UNIT' && !rentalUnitId) {
      setError('Selecione a peça física que será bloqueada.');
      return;
    }
    if (endDate < startDate) {
      setError('A data final precisa ser igual ou posterior à data inicial.');
      return;
    }

    setPending(true);
    setError(null);

    const result = await createBlockAction({
      scope,
      rentalUnitId: scope === 'UNIT' ? rentalUnitId : undefined,
      startDate,
      endDate,
      reason: reason.trim(),
    });

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
    <div className="space-y-4">
      <form onSubmit={submit} className="rounded-xl border border-ink/10 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-dark-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-ink dark:text-dark-text">Criar novo bloqueio</h3>
            <p className="mt-1 text-xs text-ink/45 dark:text-dark-subtle">O bloqueio entra imediatamente na disponibilidade e impede novas reservas no período.</p>
          </div>
          <div className="rounded-lg bg-marsala/10 p-2 text-marsala dark:bg-gold/10 dark:text-gold">
            <Ban size={18} />
          </div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-12">
          <label className="lg:col-span-2">
            <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">Escopo</span>
            <select value={scope} onChange={(event) => setScope(event.target.value as 'STORE_WIDE' | 'UNIT')} className={`${inputClass} mt-1.5`}>
              <option value="STORE_WIDE" className="bg-white text-ink dark:bg-dark-popover dark:text-dark-text">Loja inteira</option>
              <option value="UNIT" className="bg-white text-ink dark:bg-dark-popover dark:text-dark-text">Peça específica</option>
            </select>
          </label>

          {scope === 'UNIT' ? (
            <label className="lg:col-span-3">
              <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">Peça física</span>
              <select value={rentalUnitId} onChange={(event) => setRentalUnitId(event.target.value)} className={`${inputClass} mt-1.5`}>
                <option value="" className="bg-white text-ink dark:bg-dark-popover dark:text-dark-text">Selecione uma peça…</option>
                {pieces.map((piece) => (
                  <option key={piece.id} value={piece.id} className="bg-white text-ink dark:bg-dark-popover dark:text-dark-text">
                    {piece.code} · {piece.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className={scope === 'UNIT' ? 'lg:col-span-2' : 'lg:col-span-2'}>
            <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">De</span>
            <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className={`${inputClass} mt-1.5`} />
          </label>

          <label className={scope === 'UNIT' ? 'lg:col-span-2' : 'lg:col-span-2'}>
            <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">Até</span>
            <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className={`${inputClass} mt-1.5`} />
          </label>

          <label className={scope === 'UNIT' ? 'lg:col-span-3' : 'lg:col-span-4'}>
            <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">Motivo</span>
            <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Ex.: manutenção, evento, indisponibilidade" className={`${inputClass} mt-1.5`} />
          </label>

          <div className={scope === 'UNIT' ? 'lg:col-span-12' : 'lg:col-span-2 lg:flex lg:items-end'}>
            <button type="submit" disabled={pending} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-marsala px-4 py-2.5 text-sm font-medium text-cream shadow-sm transition hover:bg-marsala/90 disabled:opacity-50 dark:bg-marsala-light dark:text-sand dark:hover:bg-marsala-glow">
              <Plus size={15} />
              {pending ? 'Criando…' : 'Criar bloqueio'}
            </button>
          </div>
        </div>

        {scope === 'UNIT' && selectedPiece ? (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-ink/10 bg-ink/[0.02] px-3 py-2 text-xs text-ink/55 dark:border-white/10 dark:bg-white/[0.025] dark:text-dark-muted">
            <Package size={14} className="text-marsala dark:text-gold" />
            Será bloqueada apenas a peça <strong className="font-semibold text-ink dark:text-dark-text">{selectedPiece.code}</strong>.
          </div>
        ) : null}

        {error ? (
          <p className="mt-3 rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3.5 py-2.5 text-sm text-red-400">{error}</p>
        ) : null}
      </form>

      {blocks.length === 0 ? (
        <EmptyState title="Nenhum bloqueio ativo" description="A operação está sem indisponibilidades adicionais além das regras gerais de aluguel." />
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {blocks.map((block) => (
            <article key={block.id} className="rounded-xl border border-ink/10 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-dark-card">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <div className={`rounded-lg p-2.5 ${block.scope === 'STORE_WIDE' ? 'bg-amber-500/10 text-amber-400' : 'bg-marsala/10 text-marsala dark:bg-gold/10 dark:text-gold'}`}>
                    {block.scope === 'STORE_WIDE' ? <Store size={17} /> : <Package size={17} />}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-ink dark:text-dark-text">
                        {block.scope === 'STORE_WIDE' ? 'Loja inteira' : block.rentalUnitCode ?? 'Peça específica'}
                      </h3>
                      <span className="rounded-full border border-ink/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink/45 dark:border-white/10 dark:text-dark-subtle">
                        {block.scope === 'STORE_WIDE' ? 'geral' : 'peça'}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-ink/45 dark:text-dark-subtle">
                      <CalendarRange size={13} />
                      {formatDatePt(block.startDate)} – {formatDatePt(block.endDate)}
                    </div>
                  </div>
                </div>

                <ConfirmDialog
                  trigger={
                    <button type="button" className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/[0.05] px-2.5 py-1.5 text-xs font-medium text-red-400 transition hover:bg-red-500/10">
                      <Trash2 size={13} />
                      Remover
                    </button>
                  }
                  title="Remover este bloqueio?"
                  description="A peça ou a loja voltará a ficar disponível normalmente para esse período, respeitando as demais regras existentes."
                  confirmLabel="Remover bloqueio"
                  danger
                  onConfirm={async () => {
                    const result = await removeBlockAction(block.id);
                    if (result.error) throw new Error(result.error);
                  }}
                />
              </div>

              <div className="mt-4 rounded-lg border border-ink/10 bg-ink/[0.015] px-3.5 py-3 dark:border-white/10 dark:bg-white/[0.02]">
                <p className="text-[11px] uppercase tracking-wide text-ink/35 dark:text-dark-subtle">Motivo</p>
                <p className="mt-1 text-sm text-ink/70 dark:text-dark-muted">{block.reason}</p>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDatePt(iso: string): string {
  const [year, month, day] = iso.split('-');
  return year && month && day ? `${day}/${month}/${year}` : iso;
}
