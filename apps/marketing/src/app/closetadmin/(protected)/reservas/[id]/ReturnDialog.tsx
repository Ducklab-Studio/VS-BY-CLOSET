'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CONDITION_INFO, RETURN_CONDITIONS, lateLabel, validateInspection, type ReturnCondition } from '@/lib/return-inspection';
import { receiveItemAction } from './actions';

/**
 * Recebimento de UMA peça com conferência. Duas etapas: (1) condição e
 * observação; (2) resumo e confirmação. Nada é enviado antes da confirmação
 * final, e o envio é protegido contra duplo clique (ref síncrona): a API e o
 * banco também recusam devolução repetida.
 */
export function ReturnDialog({
  reservationId,
  reservationItemId,
  code,
  overdueDays,
}: {
  reservationId: string;
  reservationItemId: string;
  code: string;
  overdueDays: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'inspect' | 'confirm'>('inspect');
  const [condition, setCondition] = useState<ReturnCondition | null>(null);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  function close() {
    if (pendingRef.current) return;
    setOpen(false);
    setStep('inspect');
    setCondition(null);
    setNotes('');
    setError(null);
  }

  function goToConfirm() {
    const invalid = validateInspection({ condition, notes });
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setStep('confirm');
  }

  async function submit() {
    if (pendingRef.current || !condition) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await receiveItemAction(reservationId, reservationItemId, { condition, notes });
      if (result.error) {
        setError(result.error);
        return;
      }
      pendingRef.current = false;
      setPending(false);
      close();
      router.refresh();
    } catch {
      setError('Não foi possível registrar a devolução agora. Atualize a tela e confira se ela já foi registrada.');
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  const info = condition ? CONDITION_INFO[condition] : null;

  return (
    <>
      <button
        type="button"
        data-testid={`registrar-devolucao-${code}`}
        onClick={() => setOpen(true)}
        className="rounded-lg border border-ink/15 dark:border-white/15 px-3.5 py-2 text-sm font-medium text-ink dark:text-dark-text hover:bg-ink/5 dark:hover:bg-white/10 transition"
      >
        Registrar devolução
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <button aria-label="Fechar" className="absolute inset-0 bg-black/50 dark:bg-black/80 backdrop-blur-sm" onClick={close} />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="return-dialog-title"
            data-testid="dialogo-devolucao"
            className="relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-ink/10 bg-white p-6 shadow-2xl transition-colors dark:border-white/10 dark:bg-dark-card"
          >
            <h2 id="return-dialog-title" className="font-heading text-lg font-bold tracking-wide text-ink dark:text-dark-text">
              {step === 'inspect' ? `Conferir peça ${code}` : 'Confirmar devolução?'}
            </h2>

            {overdueDays > 0 ? (
              <p data-testid="aviso-atraso" className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                Devolução em atraso: {lateLabel(overdueDays)}. O atraso fica registrado; nenhuma cobrança é gerada por esta tela.
              </p>
            ) : null}

            {step === 'inspect' ? (
              <>
                <fieldset className="mt-4 space-y-2" disabled={pending}>
                  <legend className="text-sm font-medium text-ink/70 dark:text-dark-muted">Condição da peça</legend>
                  {RETURN_CONDITIONS.map((value) => (
                    <label
                      key={value}
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm transition ${condition === value ? 'border-marsala bg-marsala/5 dark:border-gold dark:bg-gold/10' : 'border-ink/15 hover:border-marsala/60 dark:border-white/15'}`}
                    >
                      <input
                        type="radio"
                        name="condition"
                        value={value}
                        checked={condition === value}
                        onChange={() => {
                          setCondition(value);
                          setError(null);
                        }}
                        className="mt-1"
                        data-testid={`condicao-${value}`}
                      />
                      <span>
                        <span className="block font-medium text-ink dark:text-dark-text">{CONDITION_INFO[value].label}</span>
                        <span className="block text-xs text-ink/60 dark:text-dark-muted">{CONDITION_INFO[value].hint}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>

                <label className="mt-4 flex flex-col gap-1.5 text-sm">
                  <span className="font-medium text-ink/70 dark:text-dark-muted">
                    Observações {info?.needsNotes ? '(obrigatório)' : '(opcional)'}
                  </span>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                    maxLength={2000}
                    disabled={pending}
                    data-testid="observacoes-devolucao"
                    className="rounded-lg border border-ink/15 bg-white px-3 py-2 text-ink outline-none transition focus:border-marsala focus:ring-2 focus:ring-marsala/20 dark:border-white/15 dark:bg-dark-surface dark:text-dark-text dark:focus:border-gold dark:focus:ring-gold/20"
                  />
                </label>
                <p className="mt-2 text-xs text-ink/55 dark:text-dark-subtle">Anexo de fotos ainda não está disponível. Descreva a ocorrência no texto.</p>
              </>
            ) : (
              <div className="mt-3 space-y-2 text-sm text-ink/80 dark:text-dark-text" data-testid="resumo-devolucao">
                <p>
                  Peça <strong>{code}</strong> · <strong>{info?.label}</strong>
                </p>
                {notes.trim() ? <p className="whitespace-pre-wrap text-ink/70 dark:text-dark-muted">“{notes.trim()}”</p> : null}
                <p className="text-ink/60 dark:text-dark-muted">
                  {info?.holds
                    ? 'A peça ficará retida e indisponível até um administrador liberá-la.'
                    : 'A peça continuará indisponível até a higienização ser concluída.'}
                </p>
              </div>
            )}

            {error ? (
              <p role="alert" data-testid="erro-devolucao" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800/40 dark:bg-red-950/40 dark:text-red-300">
                {error}
              </p>
            ) : null}

            <div className="mt-5 flex justify-end gap-2">
              {step === 'confirm' ? (
                <button type="button" disabled={pending} onClick={() => setStep('inspect')} className="rounded-lg px-3.5 py-2 text-sm font-medium text-ink/70 hover:bg-ink/5 disabled:opacity-50 dark:text-dark-muted dark:hover:bg-white/10">
                  Voltar
                </button>
              ) : (
                <button type="button" onClick={close} className="rounded-lg px-3.5 py-2 text-sm font-medium text-ink/70 hover:bg-ink/5 dark:text-dark-muted dark:hover:bg-white/10">
                  Cancelar
                </button>
              )}
              {step === 'inspect' ? (
                <button
                  type="button"
                  data-testid="continuar-devolucao"
                  onClick={goToConfirm}
                  className="rounded-lg bg-marsala px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110 dark:bg-gold dark:text-neutral-950"
                >
                  Continuar
                </button>
              ) : (
                <button
                  type="button"
                  data-testid="confirmar-devolucao"
                  disabled={pending}
                  onClick={submit}
                  className="rounded-lg bg-marsala px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-60 dark:bg-gold dark:text-neutral-950"
                >
                  {pending ? 'Registrando…' : 'Confirmar devolução'}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
