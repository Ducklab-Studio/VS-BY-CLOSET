'use client';

import { useMemo, useRef, useState } from 'react';
import { Ban, CalendarRange, Package, Pencil, Plus, Power, Store, Trash2, X } from 'lucide-react';
import type { BlockItem, PieceListItem } from '@/lib/admin-data';
import { ConfirmDialog } from '@/components/closetadmin/ConfirmDialog';
import { EmptyState } from '@/components/closetadmin/ui';
import { createBlockAction, removeBlockAction, setBlockActiveAction, updateBlockAction } from './actions';

const inputClass =
  'w-full rounded-lg border border-ink/15 bg-white px-3 py-2.5 text-sm text-ink outline-none transition focus:border-marsala focus:ring-2 focus:ring-marsala/20 dark:border-white/15 dark:bg-dark-surface dark:text-dark-text dark:focus:border-gold dark:focus:ring-gold/20';

type Scope = 'STORE_WIDE' | 'UNIT';

export function BlocksSection({ blocks, pieces }: { blocks: BlockItem[]; pieces: PieceListItem[] }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>('STORE_WIDE');
  const [rentalUnitId, setRentalUnitId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const selectedPiece = useMemo(() => pieces.find((piece) => piece.id === rentalUnitId), [pieces, rentalUnitId]);
  const sorted = useMemo(() => [...blocks].sort((a, b) => Number(b.active) - Number(a.active) || b.startDate.localeCompare(a.startDate)), [blocks]);

  function resetForm() {
    setEditingId(null);
    setScope('STORE_WIDE');
    setStartDate('');
    setEndDate('');
    setReason('');
    setRentalUnitId('');
    setError(null);
  }

  function startEditing(block: BlockItem) {
    setEditingId(block.id);
    setScope(block.scope);
    setRentalUnitId(block.rentalUnitId ?? '');
    setStartDate(block.startDate);
    setEndDate(block.endDate);
    setReason(block.reason);
    setError(null);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

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

    const input = {
      scope,
      rentalUnitId: scope === 'UNIT' ? rentalUnitId : undefined,
      startDate,
      endDate,
      reason: reason.trim(),
    };
    const result = editingId ? await updateBlockAction(editingId, input) : await createBlockAction(input);

    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    resetForm();
  }

  const editingBlock = editingId ? blocks.find((block) => block.id === editingId) : undefined;

  return (
    <div className="space-y-4">
      <form ref={formRef} onSubmit={submit} className="scroll-mt-24 rounded-xl border border-ink/10 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-dark-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-ink dark:text-dark-text">{editingId ? 'Editar período fechado' : 'Criar período fechado'}</h3>
            <p className="mt-1 text-xs text-ink/45 dark:text-dark-subtle">
              {editingId
                ? 'A alteração vale imediatamente. Reservas já existentes no período não são canceladas.'
                : 'O período entra imediatamente na disponibilidade e impede novas reservas. Reservas já existentes não são canceladas.'}
            </p>
          </div>
          <div className="rounded-lg bg-marsala/10 p-2 text-marsala dark:bg-gold/10 dark:text-gold">
            {editingId ? <Pencil size={18} /> : <Ban size={18} />}
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-12">
          <label className="lg:col-span-2">
            <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">Escopo</span>
            <select value={scope} onChange={(event) => setScope(event.target.value as Scope)} className={`${inputClass} mt-1.5`}>
              <option value="STORE_WIDE" className="bg-white text-ink dark:bg-dark-popover dark:text-dark-text">Loja inteira</option>
              <option value="UNIT" className="bg-white text-ink dark:bg-dark-popover dark:text-dark-text">Peça específica</option>
            </select>
          </label>

          {scope === 'UNIT' ? (
            <label className="lg:col-span-3">
              <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">Peça física</span>
              <select value={rentalUnitId} onChange={(event) => setRentalUnitId(event.target.value)} className={`${inputClass} mt-1.5`}>
                <option value="" className="bg-white text-ink dark:bg-dark-popover dark:text-dark-text">Selecione uma peça…</option>
                {editingBlock?.rentalUnitId && !pieces.some((piece) => piece.id === editingBlock.rentalUnitId) ? (
                  <option value={editingBlock.rentalUnitId} className="bg-white text-ink dark:bg-dark-popover dark:text-dark-text">
                    {editingBlock.rentalUnitCode ?? 'Peça atual'} (inativa)
                  </option>
                ) : null}
                {pieces.map((piece) => (
                  <option key={piece.id} value={piece.id} className="bg-white text-ink dark:bg-dark-popover dark:text-dark-text">
                    {piece.code} · {piece.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="lg:col-span-2">
            <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">De</span>
            <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className={`${inputClass} mt-1.5`} />
          </label>

          <label className="lg:col-span-2">
            <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">Até</span>
            <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className={`${inputClass} mt-1.5`} />
          </label>

          <label className={`sm:col-span-2 ${scope === 'UNIT' ? 'lg:col-span-3' : 'lg:col-span-4'}`}>
            <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">Motivo</span>
            <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Ex.: temporada fechada, manutenção, evento" className={`${inputClass} mt-1.5`} />
          </label>

          <div className={`flex flex-col gap-2 sm:col-span-2 sm:flex-row ${scope === 'UNIT' ? 'lg:col-span-12' : 'lg:col-span-2 lg:flex-col lg:justify-end'}`}>
            <button type="submit" disabled={pending} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-marsala px-4 py-2.5 text-sm font-medium text-cream shadow-sm transition hover:bg-marsala/90 disabled:opacity-50 dark:bg-marsala-light dark:text-sand dark:hover:bg-marsala-glow">
              {editingId ? <Pencil size={15} /> : <Plus size={15} />}
              {pending ? 'Salvando…' : editingId ? 'Salvar alterações' : 'Criar período'}
            </button>
            {editingId ? (
              <button type="button" onClick={resetForm} disabled={pending} className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-ink/10 px-4 py-2.5 text-sm font-medium text-ink/60 transition hover:bg-ink/5 disabled:opacity-50 dark:border-white/10 dark:text-dark-muted dark:hover:bg-white/5">
                <X size={15} />
                Cancelar edição
              </button>
            ) : null}
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

      {sorted.length === 0 ? (
        <EmptyState title="Nenhum período fechado" description="Sem períodos fechados, a loja segue aberta, respeitando só as regras gerais de aluguel." />
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {sorted.map((block) => (
            <article
              key={block.id}
              className={`rounded-xl border bg-white p-4 shadow-sm dark:bg-dark-card ${block.active ? 'border-ink/10 dark:border-white/10' : 'border-dashed border-ink/15 opacity-70 dark:border-white/15'} ${editingId === block.id ? 'ring-2 ring-marsala/30 dark:ring-gold/30' : ''}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <div className={`rounded-lg p-2.5 ${block.scope === 'STORE_WIDE' ? 'bg-amber-500/10 text-amber-400' : 'bg-marsala/10 text-marsala dark:bg-gold/10 dark:text-gold'}`}>
                    {block.scope === 'STORE_WIDE' ? <Store size={17} /> : <Package size={17} />}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-ink dark:text-dark-text">
                        {block.scope === 'STORE_WIDE' ? 'Loja inteira' : block.rentalUnitCode ?? 'Peça específica'}
                      </h3>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${block.active ? 'border-emerald-500/20 bg-emerald-500/[0.07] text-emerald-500' : 'border-ink/10 text-ink/45 dark:border-white/10 dark:text-dark-subtle'}`}
                      >
                        {block.active ? 'ativo' : 'desativado'}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-ink/45 dark:text-dark-subtle">
                      <CalendarRange size={13} />
                      {formatDatePt(block.startDate)} – {formatDatePt(block.endDate)}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => startEditing(block)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-ink/10 px-2.5 py-1.5 text-xs font-medium text-ink/60 transition hover:bg-ink/5 dark:border-white/10 dark:text-dark-muted dark:hover:bg-white/5"
                  >
                    <Pencil size={13} />
                    Editar
                  </button>

                  <ConfirmDialog
                    trigger={
                      <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border border-ink/10 px-2.5 py-1.5 text-xs font-medium text-ink/60 transition hover:bg-ink/5 dark:border-white/10 dark:text-dark-muted dark:hover:bg-white/5">
                        <Power size={13} />
                        {block.active ? 'Desativar' : 'Ativar'}
                      </button>
                    }
                    title={block.active ? 'Desativar este período?' : 'Ativar este período?'}
                    description={
                      block.active
                        ? 'As datas voltam a ficar disponíveis (respeitando as demais regras). O período continua salvo e pode ser ativado de novo.'
                        : 'As datas deixam de aceitar novas reservas. Reservas já existentes não são canceladas.'
                    }
                    confirmLabel={block.active ? 'Desativar' : 'Ativar'}
                    onConfirm={async () => {
                      const result = await setBlockActiveAction(block.id, !block.active);
                      if (result.error) throw new Error(result.error);
                    }}
                  />

                  <ConfirmDialog
                    trigger={
                      <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/[0.05] px-2.5 py-1.5 text-xs font-medium text-red-400 transition hover:bg-red-500/10">
                        <Trash2 size={13} />
                        Remover
                      </button>
                    }
                    title="Remover este período?"
                    description="O período sai da lista e deixa de valer. O registro continua na auditoria."
                    confirmLabel="Remover período"
                    danger
                    onConfirm={async () => {
                      const result = await removeBlockAction(block.id);
                      if (result.error) throw new Error(result.error);
                      if (editingId === block.id) resetForm();
                    }}
                  />
                </div>
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
