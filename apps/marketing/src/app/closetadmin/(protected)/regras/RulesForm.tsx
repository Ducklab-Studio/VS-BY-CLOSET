'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, RotateCcw, Sparkles } from 'lucide-react';
import type { RentalRuleConfig } from '@/lib/admin-data';
import { ConfirmDialog } from '@/components/closetadmin/ConfirmDialog';
import { updateRulesAction } from './actions';

const inputClass =
  'w-full rounded-lg border border-ink/15 bg-white px-3 py-2.5 text-sm text-ink outline-none transition focus:border-marsala focus:ring-2 focus:ring-marsala/20 dark:border-white/15 dark:bg-dark-surface dark:text-dark-text dark:focus:border-gold dark:focus:ring-gold/20';

function describeChanges(initial: RentalRuleConfig, form: RentalRuleConfig): string[] {
  const changes: string[] = [];
  if (initial.minAdvanceDays !== form.minAdvanceDays) changes.push(`Antecedência mínima: ${initial.minAdvanceDays} → ${form.minAdvanceDays} dias`);
  if (initial.prepDays !== form.prepDays) changes.push(`Preparação: ${initial.prepDays} → ${form.prepDays} dias`);
  if (initial.cleaningDays !== form.cleaningDays) changes.push(`Limpeza: ${initial.cleaningDays} → ${form.cleaningDays} dias`);
  if (initial.maxPieces !== form.maxPieces) changes.push(`Máximo de peças: ${initial.maxPieces} → ${form.maxPieces}`);
  if (initial.operationStartDate !== form.operationStartDate) {
    changes.push(`Início da operação: ${formatStart(initial.operationStartDate)} → ${formatStart(form.operationStartDate)}`);
  }
  form.piecesToDaysTable.forEach((tier, index) => {
    const before = initial.piecesToDaysTable[index];
    if (before && before.days !== tier.days) changes.push(`Até ${tier.upTo} peça(s): ${before.days} → ${tier.days} dia(s)`);
  });
  return changes;
}

export function RulesForm({ initial }: { initial: RentalRuleConfig }) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);

  const changes = describeChanges(initial, form);
  const dirty = changes.length > 0;

  useEffect(() => {
    // Mantém o card "Como a disponibilidade é formada" sincronizado com
    // o que o Anderson está editando, antes mesmo de salvar. O backend só
    // muda quando ele confirma; isto aqui é apenas preview visual da mesma
    // configuração que será enviada no save.
    window.dispatchEvent(new CustomEvent<RentalRuleConfig>('closet:rules-preview', { detail: form }));
  }, [form]);

  async function save() {
    setPending(true);
    setMessage(null);
    const result = await updateRulesAction({
      minAdvanceDays: form.minAdvanceDays,
      prepDays: form.prepDays,
      cleaningDays: form.cleaningDays,
      operationStartDate: form.operationStartDate,
      maxPieces: form.maxPieces,
      piecesToDaysTable: form.piecesToDaysTable,
    });
    setPending(false);
    if (result.error) throw new Error(result.error);
    setMessage({ type: 'ok', text: 'Regras atualizadas e aplicadas ao motor de disponibilidade.' });
    // O resumo lateral e os cards superiores também leem os valores salvos
    // do backend. Atualiza os Server Components para todos mostrarem a
    // mesma configuração persistida imediatamente.
    router.refresh();
  }

  function updateTier(index: number, days: number) {
    setForm((prev) => ({
      ...prev,
      piecesToDaysTable: prev.piecesToDaysTable.map((tier, i) => (i === index ? { ...tier, days } : tier)),
    }));
  }

  function reset() {
    setForm(initial);
    setMessage(null);
  }

  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Field label="Antecedência mínima" hint="Dias entre a reserva e a retirada">
          <NumberInput value={form.minAdvanceDays} min={0} suffix="dias" onChange={(value) => setForm((prev) => ({ ...prev, minAdvanceDays: value }))} />
        </Field>
        <Field label="Preparação" hint="Bloqueio antes da retirada">
          <NumberInput value={form.prepDays} min={0} suffix="dias" onChange={(value) => setForm((prev) => ({ ...prev, prepDays: value }))} />
        </Field>
        <Field label="Limpeza" hint="Bloqueio após a devolução">
          <NumberInput value={form.cleaningDays} min={0} suffix="dias" onChange={(value) => setForm((prev) => ({ ...prev, cleaningDays: value }))} />
        </Field>
        <Field label="Máximo por reserva" hint="Limite total de peças">
          <NumberInput value={form.maxPieces} min={1} suffix="peças" onChange={(value) => setForm((prev) => ({ ...prev, maxPieces: value }))} />
        </Field>
      </section>

      <section className="rounded-xl border border-ink/10 bg-ink/[0.015] p-4 dark:border-white/10 dark:bg-white/[0.02]">
        <div className="flex items-center gap-2">
          <CalendarClock size={17} className="text-marsala dark:text-gold" />
          <div>
            <h3 className="text-sm font-semibold text-ink dark:text-dark-text">Início da operação</h3>
            <p className="text-xs text-ink/45 dark:text-dark-subtle">
              Primeira data de retirada aceita. Antes dela o calendário fica indisponível; depois, a loja segue aberta. Para fechar períodos, use os períodos fechados abaixo.
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,16rem)_auto] sm:items-end">
          <Field label="Primeira retirada" hint={form.operationStartDate ? undefined : 'Sem data: a loja aceita reservas normalmente.'}>
            <input
              type="date"
              value={form.operationStartDate ?? ''}
              onChange={(event) => setForm((prev) => ({ ...prev, operationStartDate: event.target.value || null }))}
              className={inputClass}
            />
          </Field>
          {form.operationStartDate ? (
            <button
              type="button"
              onClick={() => setForm((prev) => ({ ...prev, operationStartDate: null }))}
              className="rounded-lg border border-ink/10 px-4 py-2.5 text-sm font-medium text-ink/60 transition hover:bg-ink/5 dark:border-white/10 dark:text-dark-muted dark:hover:bg-white/5"
            >
              Remover data (loja aberta)
            </button>
          ) : null}
        </div>
      </section>

      <section>
        <div className="flex items-center gap-2">
          <Sparkles size={17} className="text-marsala dark:text-gold" />
          <div>
            <h3 className="text-sm font-semibold text-ink dark:text-dark-text">Duração por quantidade de peças</h3>
            <p className="text-xs text-ink/45 dark:text-dark-subtle">A quantidade reservada define automaticamente quantos dias o aluguel terá.</p>
          </div>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {form.piecesToDaysTable.map((tier, index) => (
            <label key={tier.upTo} className="rounded-xl border border-ink/10 bg-white p-4 dark:border-white/10 dark:bg-dark-surface">
              <span className="text-xs text-ink/45 dark:text-dark-subtle">Até {tier.upTo} peça(s)</span>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={tier.days}
                  onChange={(event) => updateTier(index, Number(event.target.value))}
                  className="w-20 rounded-lg border border-ink/15 bg-white px-3 py-2 text-center text-lg font-semibold text-ink outline-none focus:border-marsala focus:ring-2 focus:ring-marsala/20 dark:border-white/15 dark:bg-dark-card dark:text-dark-text dark:focus:border-gold dark:focus:ring-gold/20"
                />
                <span className="text-sm text-ink/50 dark:text-dark-muted">dia(s)</span>
              </div>
            </label>
          ))}
        </div>
      </section>

      {dirty ? (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">Alterações não salvas</p>
          <ul className="mt-2 space-y-1 text-xs text-ink/60 dark:text-dark-muted">
            {changes.slice(0, 5).map((change) => <li key={change}>• {change}</li>)}
            {changes.length > 5 ? <li>• +{changes.length - 5} alteração(ões)</li> : null}
          </ul>
        </div>
      ) : null}

      {message ? (
        <p className={`rounded-lg border px-3.5 py-2.5 text-sm ${message.type === 'ok' ? 'border-emerald-500/20 bg-emerald-500/[0.07] text-emerald-500' : 'border-red-500/20 bg-red-500/[0.07] text-red-400'}`}>
          {message.text}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <ConfirmDialog
          trigger={
            <button
              type="button"
              disabled={pending || !dirty}
              className="rounded-lg bg-marsala px-5 py-2.5 text-sm font-medium text-cream shadow-sm transition hover:bg-marsala/90 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-marsala-light dark:text-sand dark:hover:bg-marsala-glow"
            >
              {pending ? 'Salvando…' : dirty ? `Salvar ${changes.length} alteração(ões)` : 'Tudo salvo'}
            </button>
          }
          title="Confirmar alteração das regras de aluguel?"
          description={
            dirty ? (
              <>
                <span className="block">Isso vale imediatamente para o site e para novas reservas:</span>
                <ul className="mt-2 list-disc space-y-1 pl-4">
                  {changes.map((change) => <li key={change}>{change}</li>)}
                </ul>
              </>
            ) : undefined
          }
          confirmLabel="Salvar alterações"
          onConfirm={save}
        />

        <button
          type="button"
          onClick={reset}
          disabled={!dirty || pending}
          className="inline-flex items-center gap-2 rounded-lg border border-ink/10 px-4 py-2.5 text-sm font-medium text-ink/60 transition hover:bg-ink/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:text-dark-muted dark:hover:bg-white/5"
        >
          <RotateCcw size={15} />
          Descartar alterações
        </button>
      </div>
    </div>
  );
}

function formatStart(iso: string | null): string {
  if (!iso) return 'sem data';
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-ink/70 dark:text-dark-muted">{label}</span>
      {hint ? <span className="mt-0.5 block text-[11px] text-ink/40 dark:text-dark-subtle">{hint}</span> : null}
      <div className="mt-2">{children}</div>
    </label>
  );
}

function NumberInput({ value, min, suffix, onChange }: { value: number; min: number; suffix: string; onChange: (value: number) => void }) {
  return (
    <div className="relative">
      <input type="number" min={min} value={value} onChange={(event) => onChange(Number(event.target.value))} className={`${inputClass} pr-16`} />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink/35 dark:text-dark-subtle">{suffix}</span>
    </div>
  );
}
