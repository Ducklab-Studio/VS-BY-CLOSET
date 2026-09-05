'use client';

import { useState } from 'react';
import type { RentalRuleConfig } from '@/lib/admin-data';
import { ConfirmDialog } from '@/components/closetadmin/ConfirmDialog';
import { updateRulesAction } from './actions';

const inputClass =
  'w-28 rounded-lg border border-ink/15 dark:border-white/15 bg-white dark:bg-dark-surface px-3 py-2 text-sm text-ink dark:text-dark-text outline-none transition focus:border-marsala dark:focus:border-gold focus:ring-2 focus:ring-marsala/20 dark:focus:ring-gold/20 placeholder:text-ink/40 dark:placeholder:text-dark-subtle';

/** Fase 10, item 3 — resumo do que muda de verdade, pra confirmação
 *  aparecer com contexto em vez de um "tem certeza?" genérico. Só
 *  campos que realmente divergem do valor carregado do backend entram
 *  na lista. */
function describeChanges(initial: RentalRuleConfig, form: RentalRuleConfig): string[] {
  const changes: string[] = [];
  if (initial.minAdvanceDays !== form.minAdvanceDays) {
    changes.push(`Antecedência mínima: ${initial.minAdvanceDays} → ${form.minAdvanceDays} dias`);
  }
  if (initial.prepDays !== form.prepDays) {
    changes.push(`Preparação: ${initial.prepDays} → ${form.prepDays} dias`);
  }
  if (initial.cleaningDays !== form.cleaningDays) {
    changes.push(`Limpeza: ${initial.cleaningDays} → ${form.cleaningDays} dias`);
  }
  if (initial.maxPieces !== form.maxPieces) {
    changes.push(`Máximo de peças: ${initial.maxPieces} → ${form.maxPieces}`);
  }
  if (initial.blackoutStart !== form.blackoutStart || initial.blackoutEnd !== form.blackoutEnd) {
    changes.push(`Temporada bloqueada: ${initial.blackoutStart} – ${initial.blackoutEnd} → ${form.blackoutStart} – ${form.blackoutEnd}`);
  }
  form.piecesToDaysTable.forEach((tier, i) => {
    const before = initial.piecesToDaysTable[i];
    if (before && before.days !== tier.days) {
      changes.push(`Até ${tier.upTo} peça(s): ${before.days} → ${tier.days} dia(s)`);
    }
  });
  return changes;
}

export function RulesForm({ initial }: { initial: RentalRuleConfig }) {
  const [form, setForm] = useState(initial);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);

  const changes = describeChanges(initial, form);

  async function save() {
    setPending(true);
    setMessage(null);
    const result = await updateRulesAction({
      minAdvanceDays: form.minAdvanceDays,
      prepDays: form.prepDays,
      cleaningDays: form.cleaningDays,
      blackoutStart: form.blackoutStart,
      blackoutEnd: form.blackoutEnd,
      maxPieces: form.maxPieces,
      piecesToDaysTable: form.piecesToDaysTable,
    });
    setPending(false);
    if (result.error) {
      // Lançar em vez de setMessage: o ConfirmDialog mostra o erro
      // dentro do próprio modal (que fica aberto) e deixa tentar de novo
      // sem precisar reabrir a confirmação.
      throw new Error(result.error);
    }
    setMessage({ type: 'ok', text: 'Regras atualizadas.' });
  }

  function updateTier(index: number, days: number) {
    setForm((prev) => ({
      ...prev,
      piecesToDaysTable: prev.piecesToDaysTable.map((tier, i) => (i === index ? { ...tier, days } : tier)),
    }));
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Field label="Antecedência mínima (dias)">
          <input type="number" min={0} value={form.minAdvanceDays} onChange={(e) => setForm((p) => ({ ...p, minAdvanceDays: Number(e.target.value) }))} className={inputClass} />
        </Field>
        <Field label="Preparação (dias)">
          <input type="number" min={0} value={form.prepDays} onChange={(e) => setForm((p) => ({ ...p, prepDays: Number(e.target.value) }))} className={inputClass} />
        </Field>
        <Field label="Limpeza (dias)">
          <input type="number" min={0} value={form.cleaningDays} onChange={(e) => setForm((p) => ({ ...p, cleaningDays: Number(e.target.value) }))} className={inputClass} />
        </Field>
        <Field label="Máximo de peças">
          <input type="number" min={1} value={form.maxPieces} onChange={(e) => setForm((p) => ({ ...p, maxPieces: Number(e.target.value) }))} className={inputClass} />
        </Field>
        <Field label="Início temporada bloqueada (MM-DD)">
          <input value={form.blackoutStart} onChange={(e) => setForm((p) => ({ ...p, blackoutStart: e.target.value }))} className={inputClass} />
        </Field>
        <Field label="Fim temporada bloqueada (MM-DD)">
          <input value={form.blackoutEnd} onChange={(e) => setForm((p) => ({ ...p, blackoutEnd: e.target.value }))} className={inputClass} />
        </Field>
      </div>

      <div>
        <p className="text-sm font-medium text-ink/70 dark:text-dark-muted">Duração por quantidade de peças</p>
        <div className="mt-2 flex flex-wrap gap-3">
          {form.piecesToDaysTable.map((tier, i) => (
            <label key={tier.upTo} className="flex items-center gap-2 rounded-lg border border-ink/10 dark:border-white/10 bg-white dark:bg-dark-surface px-3 py-2 text-sm shadow-sm">
              <span className="text-ink/50 dark:text-dark-muted">até {tier.upTo} peça(s) →</span>
              <input
                type="number"
                min={1}
                value={tier.days}
                onChange={(e) => updateTier(i, Number(e.target.value))}
                className="w-14 rounded-md border border-ink/15 dark:border-white/15 bg-white dark:bg-dark-card text-ink dark:text-dark-text px-2 py-1 text-center outline-none focus:border-marsala dark:focus:border-gold"
              />
              <span className="text-ink/50 dark:text-dark-muted">dia(s)</span>
            </label>
          ))}
        </div>
      </div>

      {message ? (
        <p className={`rounded-lg px-3.5 py-2.5 text-sm ${message.type === 'ok' ? 'bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/40 text-emerald-700 dark:text-emerald-300' : 'bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/40 text-red-700 dark:text-red-300'}`}>{message.text}</p>
      ) : null}

      <div>
        <ConfirmDialog
          trigger={
            <button
              type="button"
              disabled={pending || changes.length === 0}
              className="rounded-lg bg-marsala dark:bg-marsala-light px-5 py-2.5 text-sm font-medium text-cream dark:text-sand hover:bg-marsala/90 dark:hover:bg-marsala-glow transition disabled:opacity-60 shadow-sm"
            >
              {pending ? 'Salvando…' : 'Salvar regras'}
            </button>
          }
          title="Confirmar alteração das regras de aluguel?"
          description={
            changes.length > 0 ? (
              <>
                <span className="block">Isso vale imediatamente para o site e para novas reservas:</span>
                <ul className="mt-2 list-disc space-y-1 pl-4">
                  {changes.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
              </>
            ) : undefined
          }
          confirmLabel="Salvar alterações"
          onConfirm={save}
        />
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-ink/70 dark:text-dark-muted">{label}</span>
      {children}
    </label>
  );
}
