'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PieceListItem } from '@/lib/admin-data';
import { PhoneInput } from '@/components/closetadmin/PhoneInput';
import { createManualReservationAction } from './actions';

const VIOLATION_LABELS: Record<string, string> = {
  pickup_before_minimum_advance: 'Esta retirada possui menos antecedência que o mínimo configurado nas regras.',
  duration_mismatch_with_engine: 'A duração informada não corresponde ao cálculo automático do motor de regras.',
  pickup_outside_season: 'A data de retirada está dentro do período em que as reservas online ficam bloqueadas.',
  pickup_outside_online_season: 'A data de retirada está dentro do período em que as reservas online ficam bloqueadas.',
  pickup_is_sunday: 'A retirada não pode ser num domingo.',
  max_pieces_exceeded: 'Quantidade de peças acima do máximo permitido.',
  no_reservable_items: 'Nenhuma peça válida selecionada.',
  pickup_not_before_return: 'A data de devolução precisa ser depois da retirada.',
};

type OverrideKey = 'minLeadTime' | 'customDuration' | 'outsideOnlineSeason';

const OVERRIDE_KEY_BY_VIOLATION: Record<string, OverrideKey> = {
  pickup_before_minimum_advance: 'minLeadTime',
  duration_mismatch_with_engine: 'customDuration',
  pickup_outside_season: 'outsideOnlineSeason',
  pickup_outside_online_season: 'outsideOnlineSeason',
};

const inputClass =
  'rounded-lg border border-ink/15 dark:border-white/15 bg-white dark:bg-dark-surface px-3.5 py-2.5 text-sm text-ink dark:text-dark-text outline-none transition focus:border-marsala dark:focus:border-gold focus:ring-2 focus:ring-marsala/20 dark:focus:ring-gold/20 placeholder:text-ink/40 dark:placeholder:text-dark-subtle';

type Step = 1 | 2 | 3 | 4;

export function ManualReservationWizard({
  pieces,
  canOverrideSeason,
}: {
  pieces: PieceListItem[];
  canOverrideSeason: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [pickupDate, setPickupDate] = useState('');
  const [returnDate, setReturnDate] = useState('');
  const [selectedUnitIds, setSelectedUnitIds] = useState<string[]>([]);
  const [internalNote, setInternalNote] = useState('');

  const [violations, setViolations] = useState<string[] | null>(null);
  const [overrides, setOverrides] = useState<{
    minLeadTime?: boolean;
    customDuration?: boolean;
    outsideOnlineSeason?: boolean;
  }>({});
  const [overrideReason, setOverrideReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const overridable = useMemo(
    () =>
      (violations ?? []).filter((violation) => {
        const key = OVERRIDE_KEY_BY_VIOLATION[violation];
        if (!key) return false;
        if (key === 'outsideOnlineSeason' && !canOverrideSeason) return false;
        return true;
      }),
    [violations, canOverrideSeason],
  );

  const blocking = useMemo(
    () =>
      (violations ?? []).filter((violation) => {
        const key = OVERRIDE_KEY_BY_VIOLATION[violation];
        if (!key) return true;
        if (key === 'outsideOnlineSeason' && !canOverrideSeason) return true;
        return false;
      }),
    [violations, canOverrideSeason],
  );

  const activePieces = pieces.filter((p) => p.active);

  function resetServerFeedback() {
    setViolations(null);
    setOverrides({});
    setOverrideReason('');
    setError(null);
  }

  function toggleUnit(id: string) {
    resetServerFeedback();
    setSelectedUnitIds((prev) => (prev.includes(id) ? prev.filter((u) => u !== id) : [...prev, id]));
  }

  async function submit() {
    setPending(true);
    setError(null);
    const hasOverride = Object.values(overrides).some(Boolean);
    if (hasOverride && overrideReason.trim().length < 3) {
      setError('Informe um motivo para o(s) override(s) selecionado(s).');
      setPending(false);
      return;
    }

    const result = await createManualReservationAction({
      customerName,
      customerPhone,
      customerEmail: customerEmail || undefined,
      items: selectedUnitIds.map((rentalUnitId) => ({ rentalUnitId })),
      pickupDate,
      returnDate: returnDate || undefined,
      internalNote: internalNote || undefined,
      overrides: hasOverride ? overrides : undefined,
      overrideReason: hasOverride ? overrideReason.trim() : undefined,
    });

    setPending(false);
    if (result.ok && result.reservationId) {
      router.push(`/closetadmin/reservas/${result.reservationId}`);
      return;
    }
    if (result.violations) {
      // O backend pode descobrir overrides em etapas (ex.: temporada +
      // antecedência primeiro e duração customizada depois). Enquanto o
      // usuário não alterar datas/peças, as confirmações já dadas precisam
      // continuar ativas; apagá-las aqui fazia o wizard alternar entre os
      // mesmos grupos de violações indefinidamente.
      setViolations((previous) => Array.from(new Set([...(previous ?? []), ...result.violations])));
      setStep(4);
      return;
    }
    setError(result.error ?? 'Não foi possível criar a reserva.');
  }

  return (
    <div className="max-w-2xl">
      <StepIndicator step={step} />

      {step === 1 ? (
        <div className="mt-6 flex flex-col gap-4">
          <Field label="Nome do cliente">
            <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Telefone">
            <PhoneInput value={customerPhone} onChange={setCustomerPhone} />
          </Field>
          <Field label="E-mail (opcional)">
            <input value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} type="email" className={inputClass} />
          </Field>
          <NavButtons onNext={() => setStep(2)} nextDisabled={!customerName.trim() || !customerPhone.trim()} />
        </div>
      ) : null}

      {step === 2 ? (
        <div className="mt-6 flex flex-col gap-4">
          <Field label="Data de retirada">
            <input
              type="date"
              value={pickupDate}
              onChange={(e) => {
                setPickupDate(e.target.value);
                resetServerFeedback();
              }}
              className={inputClass}
            />
          </Field>
          <Field label="Data de devolução (opcional — o motor calcula automaticamente pelas peças)">
            <input
              type="date"
              value={returnDate}
              onChange={(e) => {
                setReturnDate(e.target.value);
                resetServerFeedback();
              }}
              className={inputClass}
            />
          </Field>
          <NavButtons onBack={() => setStep(1)} onNext={() => setStep(3)} nextDisabled={!pickupDate} />
        </div>
      ) : null}

      {step === 3 ? (
        <div className="mt-6">
          <p className="text-sm text-ink/55 dark:text-dark-muted">
            Selecione as peças físicas. A disponibilidade final é confirmada pelo servidor no momento de salvar — duas reservas nunca podem usar a mesma
            peça no mesmo período.
          </p>

          {activePieces.length === 0 ? (
            <div className="mt-3 rounded-xl border border-dashed border-ink/15 bg-white px-4 py-8 text-center text-sm text-ink/55 dark:border-white/10 dark:bg-dark-card dark:text-dark-muted">
              Nenhuma peça ativa está disponível para selecionar. Cadastre ou ative uma peça em “Peças”.
            </div>
          ) : (
            <ul className="mt-3 max-h-80 divide-y divide-ink/5 dark:divide-white/5 overflow-y-auto rounded-xl border border-ink/10 dark:border-white/10 bg-white dark:bg-dark-card">
              {activePieces.map((piece) => (
                <li key={piece.id}>
                  <label className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-ink/5 dark:hover:bg-white/5 transition">
                    <span>
                      <span className="font-medium text-ink dark:text-dark-text">{piece.code}</span>
                      <span className="ml-2 text-ink/50 dark:text-dark-muted">{piece.name}</span>
                      {!piece.reservableOnline ? (
                        <span className="ml-2 rounded-full bg-sand dark:bg-[#3D3325] px-2 py-0.5 text-xs text-ink/70 dark:text-sand">
                          Loja
                        </span>
                      ) : null}
                    </span>
                    <input
                      type="checkbox"
                      checked={selectedUnitIds.includes(piece.id)}
                      onChange={() => toggleUnit(piece.id)}
                      className="accent-marsala dark:accent-gold h-4 w-4 rounded"
                    />
                  </label>
                </li>
              ))}
            </ul>
          )}
          <NavButtons onBack={() => setStep(2)} onNext={() => setStep(4)} nextDisabled={selectedUnitIds.length === 0} />
        </div>
      ) : null}

      {step === 4 ? (
        <div className="mt-6 flex flex-col gap-4">
          <div className="rounded-xl border border-ink/10 dark:border-white/10 bg-white dark:bg-dark-card p-4 text-sm text-ink dark:text-dark-text shadow-sm">
            <p>
              <strong className="text-marsala dark:text-gold font-semibold">{customerName}</strong> · {customerPhone}
            </p>
            <p className="mt-1 text-ink/60 dark:text-dark-muted">
              Retirada: {pickupDate || '—'} {returnDate ? `· Devolução: ${returnDate}` : ''}
            </p>
            <p className="mt-1 text-ink/60 dark:text-dark-muted">{selectedUnitIds.length} peça(s) selecionada(s)</p>
          </div>

          <Field label="Nota interna (opcional)">
            <textarea value={internalNote} onChange={(e) => setInternalNote(e.target.value)} rows={2} className={inputClass} />
          </Field>

          {blocking.length > 0 ? (
            <div className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/40 px-4 py-3 text-sm text-red-700 dark:text-red-300">
              <p className="font-medium">Esta reserva não pode ser criada assim:</p>
              <ul className="mt-1 list-disc pl-5">
                {blocking.map((v) => (
                  <li key={v}>{VIOLATION_LABELS[v] ?? v}</li>
                ))}
              </ul>
              {!canOverrideSeason && blocking.some((v) => OVERRIDE_KEY_BY_VIOLATION[v] === 'outsideOnlineSeason') ? (
                <p className="mt-2 text-xs opacity-80">Exceção de temporada é exclusiva de usuário ADMIN.</p>
              ) : (
                <p className="mt-2 text-xs opacity-80">Volte e ajuste os dados; as validações serão refeitas ao confirmar novamente.</p>
              )}
            </div>
          ) : null}

          {overridable.length > 0 ? (
            <div className="rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/40 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
              <p className="font-medium">Regras que exigem confirmação explícita:</p>
              <div className="mt-2 flex flex-col gap-2">
                {overridable.map((v) => {
                  const key = OVERRIDE_KEY_BY_VIOLATION[v];
                  return (
                    <label key={v} className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(overrides[key])}
                        onChange={(e) => setOverrides((prev) => ({ ...prev, [key]: e.target.checked }))}
                        className="mt-0.5 accent-marsala dark:accent-gold"
                      />
                      <span>
                        {VIOLATION_LABELS[v] ?? v} — permitir mesmo assim.
                        {key === 'outsideOnlineSeason' ? ' O site público continua bloqueado; esta exceção vale somente para esta reserva manual.' : ''}
                      </span>
                    </label>
                  );
                })}
              </div>
              {Object.values(overrides).some(Boolean) ? (
                <label className="mt-3 flex flex-col gap-1">
                  <span className="font-medium text-ink dark:text-dark-text">Motivo do override (obrigatório)</span>
                  <textarea value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} rows={2} className={inputClass} />
                </label>
              ) : null}
            </div>
          ) : null}

          {error ? <p className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/40 px-3.5 py-2.5 text-sm text-red-700 dark:text-red-300">{error}</p> : null}

          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => {
                resetServerFeedback();
                setStep(3);
              }}
              className="rounded-lg px-4 py-2.5 text-sm font-medium text-ink/60 dark:text-dark-muted hover:bg-ink/5 dark:hover:bg-white/5 transition"
            >
              Voltar
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={pending || blocking.length > 0}
              className="rounded-lg bg-marsala dark:bg-marsala-light px-5 py-2.5 text-sm font-medium text-cream dark:text-sand hover:bg-marsala/90 dark:hover:bg-marsala-glow transition disabled:opacity-50 shadow-sm"
            >
              {pending ? 'Criando…' : 'Confirmar reserva'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StepIndicator({ step }: { step: Step }) {
  const labels = ['Cliente', 'Datas', 'Peças', 'Resumo'];
  return (
    <div className="flex items-center gap-2 text-xs text-ink/50 dark:text-dark-muted">
      {labels.map((label, i) => (
        <span key={label} className={`flex items-center gap-2 ${i + 1 === step ? 'font-semibold text-marsala dark:text-gold' : ''}`}>
          <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${i + 1 <= step ? 'bg-marsala dark:bg-gold text-cream dark:text-ink' : 'bg-ink/10 dark:bg-white/10 text-ink/60 dark:text-dark-muted'}`}>{i + 1}</span>
          {label}
          {i < labels.length - 1 ? <span className="text-ink/20 dark:text-white/15">—</span> : null}
        </span>
      ))}
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

function NavButtons({ onBack, onNext, nextDisabled }: { onBack?: () => void; onNext: () => void; nextDisabled?: boolean }) {
  return (
    <div className="flex justify-between">
      {onBack ? (
        <button type="button" onClick={onBack} className="rounded-lg px-4 py-2.5 text-sm font-medium text-ink/60 dark:text-dark-muted hover:bg-ink/5 dark:hover:bg-white/5 transition">
          Voltar
        </button>
      ) : (
        <span />
      )}
      <button
        type="button"
        onClick={onNext}
        disabled={nextDisabled}
        className="rounded-lg bg-marsala dark:bg-marsala-light px-5 py-2.5 text-sm font-medium text-cream dark:text-sand hover:bg-marsala/90 dark:hover:bg-marsala-glow transition disabled:opacity-50 shadow-sm"
      >
        Continuar
      </button>
    </div>
  );
}
