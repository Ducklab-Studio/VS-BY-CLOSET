'use client';

import { useState } from 'react';

/**
 * Item "UX/Design": "Evitar window.confirm." Modal simples e controlado
 * — quem usa passa `onConfirm` (pode ser async) e opcionalmente um campo
 * de motivo obrigatório (overrides / cancelamento / bloqueio removido
 * sempre pedem um motivo, nunca aplicados silenciosamente).
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel = 'Confirmar',
  requireReason = false,
  danger = false,
  onConfirm,
}: {
  trigger: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  requireReason?: boolean;
  danger?: boolean;
  onConfirm: (reason?: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    if (requireReason && reason.trim().length < 3) {
      setError('Informe um motivo (mínimo 3 caracteres).');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onConfirm(requireReason ? reason.trim() : undefined);
      setOpen(false);
      setReason('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível concluir a ação.');
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <span onClick={() => setOpen(true)}>{trigger}</span>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <button aria-label="Fechar" className="absolute inset-0 bg-black/50 dark:bg-black/80 backdrop-blur-sm" onClick={() => !pending && setOpen(false)} />
          <div className="relative w-full max-w-sm rounded-2xl bg-white dark:bg-dark-card border border-ink/10 dark:border-white/10 p-6 shadow-2xl transition-colors">
            <h2 className="font-heading text-lg font-bold text-ink dark:text-dark-text tracking-wide">{title}</h2>
            {/* div, não <p>: description agora aceita ReactNode (ex.: RulesForm
                passa uma <ul> com o resumo das mudanças) — <ul> dentro de <p>
                é HTML inválido e quebra a hidratação. */}
            {description ? <div className="mt-1.5 text-sm text-ink/60 dark:text-dark-muted">{description}</div> : null}

            {requireReason ? (
              <label className="mt-4 flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-ink/70 dark:text-dark-muted">Motivo</span>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  disabled={pending}
                  className="rounded-lg border border-ink/15 dark:border-white/15 bg-white dark:bg-dark-surface px-3 py-2 text-ink dark:text-dark-text outline-none transition focus:border-marsala dark:focus:border-gold focus:ring-2 focus:ring-marsala/20 dark:focus:ring-gold/20"
                />
              </label>
            ) : null}

            {error ? <p className="mt-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/40 px-3 py-2 text-sm text-red-700 dark:text-red-300">{error}</p> : null}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3.5 py-2 text-sm font-medium text-ink/60 dark:text-dark-muted hover:bg-ink/5 dark:hover:bg-white/5 transition"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={handleConfirm}
                className={`rounded-lg px-3.5 py-2 text-sm font-medium text-white transition disabled:opacity-60 shadow-sm ${
                  danger ? 'bg-red-600 dark:bg-red-700 hover:bg-red-700 dark:hover:bg-red-600' : 'bg-marsala dark:bg-marsala-light hover:bg-marsala/90 dark:hover:bg-marsala-glow text-cream dark:text-sand'
                }`}
              >
                {pending ? 'Aguarde…' : confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
