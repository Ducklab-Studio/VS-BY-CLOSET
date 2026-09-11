'use client';

import { useState } from 'react';
import { Archive } from 'lucide-react';
import type { ArchiveExecutionResult, ArchiveFilters, ArchivePreviewResult } from '@/lib/admin-data';
import { previewArchiveAction, executeArchiveAction } from './archive-actions';

const CONFIRM_PHRASE = 'LIMPAR HISTÓRICOS';

const inputClass =
  'w-full rounded-lg border border-ink/15 dark:border-white/15 bg-white dark:bg-dark-surface px-3 py-2.5 text-sm text-ink dark:text-dark-text outline-none transition placeholder:text-ink/40 dark:placeholder:text-dark-subtle focus:border-marsala dark:focus:border-gold focus:ring-2 focus:ring-marsala/20 dark:focus:ring-gold/20';

type Step = 'filters' | 'preview' | 'result';

/**
 * "Limpar históricos" — arquivamento (soft delete) de reservas em
 * estado terminal. Nunca some com nada: só tira da listagem
 * operacional padrão (ver ReservationArchiveService). Botão só aparece
 * pra ADMIN (`ClosetAdminReservationsPage` decide isso); o servidor
 * recusa de qualquer jeito se alguém contornar isso.
 */
export function ArchiveHistoryPanel() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('filters');
  const [filters, setFilters] = useState<ArchiveFilters>({});
  const [reason, setReason] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [preview, setPreview] = useState<ArchivePreviewResult | null>(null);
  const [result, setResult] = useState<ArchiveExecutionResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStep('filters');
    setFilters({});
    setReason('');
    setConfirmText('');
    setPreview(null);
    setResult(null);
    setError(null);
  }

  function close() {
    if (pending) return;
    setOpen(false);
    reset();
  }

  async function handlePreview() {
    setPending(true);
    setError(null);
    const { result: previewResult, error: previewError } = await previewArchiveAction(filters);
    setPending(false);
    if (previewError || !previewResult) {
      setError(previewError ?? 'Não foi possível calcular a prévia.');
      return;
    }
    setPreview(previewResult);
    setStep('preview');
  }

  async function handleExecute() {
    if (confirmText.trim() !== CONFIRM_PHRASE) {
      setError(`Digite exatamente "${CONFIRM_PHRASE}" para confirmar.`);
      return;
    }
    if (reason.trim().length < 3) {
      setError('Informe um motivo (mínimo 3 caracteres).');
      return;
    }
    setPending(true);
    setError(null);
    const { result: execResult, error: execError } = await executeArchiveAction(filters, confirmText.trim(), reason.trim());
    setPending(false);
    if (execError || !execResult) {
      setError(execError ?? 'Não foi possível concluir o arquivamento.');
      return;
    }
    setResult(execResult);
    setStep('result');
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-ink/15 dark:border-white/15 px-3 py-2 text-xs font-medium text-ink/55 dark:text-dark-muted transition hover:bg-ink/5 hover:text-ink dark:hover:bg-white/5 dark:hover:text-dark-text"
      >
        <Archive size={14} />
        Limpar históricos
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8">
          <button aria-label="Fechar" className="absolute inset-0 bg-black/50 dark:bg-black/80 backdrop-blur-sm" onClick={close} />
          <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white dark:bg-dark-card border border-ink/10 dark:border-white/10 p-6 shadow-2xl">
            <h2 className="font-heading text-lg font-bold text-ink dark:text-dark-text tracking-wide">Limpar históricos</h2>
            <p className="mt-1.5 text-sm text-ink/60 dark:text-dark-muted">
              As reservas serão removidas da listagem operacional, mas continuarão preservadas para auditoria e consulta histórica.
            </p>

            {error ? (
              <p className="mt-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/40 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                {error}
              </p>
            ) : null}

            {step === 'filters' ? (
              <div className="mt-4 flex flex-col gap-3">
                <label className="flex items-center gap-2 text-sm text-ink dark:text-dark-text">
                  <input
                    type="checkbox"
                    checked={filters.onlyCancelled === true}
                    onChange={(e) => setFilters((f) => ({ ...f, onlyCancelled: e.target.checked, onlyReturned: e.target.checked ? false : f.onlyReturned }))}
                  />
                  Somente reservas canceladas
                </label>
                <label className="flex items-center gap-2 text-sm text-ink dark:text-dark-text">
                  <input
                    type="checkbox"
                    checked={filters.onlyReturned === true}
                    onChange={(e) => setFilters((f) => ({ ...f, onlyReturned: e.target.checked, onlyCancelled: e.target.checked ? false : f.onlyCancelled }))}
                  />
                  Somente reservas concluídas/devolvidas
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-ink/55 dark:text-dark-muted">Origem</span>
                  <select
                    value={filters.source ?? ''}
                    onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value || undefined }))}
                    className={inputClass}
                  >
                    <option value="">Todas as origens</option>
                    <option value="online">Online</option>
                    <option value="manual_admin">Manual</option>
                  </select>
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-ink/55 dark:text-dark-muted">Encerradas até</span>
                  <input
                    type="date"
                    value={filters.closedBefore ?? ''}
                    onChange={(e) => setFilters((f) => ({ ...f, closedBefore: e.target.value || undefined }))}
                    className={inputClass}
                  />
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-ink/55 dark:text-dark-muted">Período mínimo de segurança (dias)</span>
                  <input
                    type="number"
                    min={0}
                    placeholder="Padrão: 30"
                    value={filters.minSafetyDays ?? ''}
                    onChange={(e) => setFilters((f) => ({ ...f, minSafetyDays: e.target.value ? Number(e.target.value) : undefined }))}
                    className={inputClass}
                  />
                </label>

                <div className="mt-2 flex justify-end gap-2">
                  <button type="button" onClick={close} className="rounded-lg px-3.5 py-2 text-sm font-medium text-ink/60 dark:text-dark-muted hover:bg-ink/5 dark:hover:bg-white/5">
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={handlePreview}
                    className="rounded-lg bg-marsala dark:bg-marsala-light px-3.5 py-2 text-sm font-medium text-cream dark:text-sand hover:bg-marsala/90 dark:hover:bg-marsala-glow disabled:opacity-60"
                  >
                    {pending ? 'Calculando…' : 'Ver prévia'}
                  </button>
                </div>
              </div>
            ) : null}

            {step === 'preview' && preview ? (
              <div className="mt-4 flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <SummaryStat label="Elegíveis para arquivar" value={preview.eligibleCount} tone="highlight" />
                  <SummaryStat label="Protegidas (ainda ativas)" value={preview.protectedActiveCount} />
                  <SummaryStat label="Futuras" value={preview.futureCount} />
                  <SummaryStat label="Já arquivadas" value={preview.alreadyArchivedCount} />
                </div>
                <p className="text-xs text-ink/50 dark:text-dark-subtle">
                  Data limite usada: encerradas até {formatDatePt(preview.cutoffDate)} ({preview.minSafetyDays} dias de segurança) · status considerados: {preview.statuses.join(', ')}
                </p>

                {preview.sample.length > 0 ? (
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-ink/10 dark:border-white/10">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-ink/10 dark:border-white/10 text-left text-ink/50 dark:text-dark-subtle">
                          <th className="px-2 py-1.5 font-medium">Reserva</th>
                          <th className="px-2 py-1.5 font-medium">Cliente</th>
                          <th className="px-2 py-1.5 font-medium">Status</th>
                          <th className="px-2 py-1.5 font-medium">Encerrada em</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-ink/5 dark:divide-white/5">
                        {preview.sample.map((row) => (
                          <tr key={row.id}>
                            <td className="px-2 py-1.5 font-mono">#{row.id.replace(/-/g, '').slice(0, 8).toUpperCase()}</td>
                            <td className="px-2 py-1.5">{row.customerName ?? '—'}</td>
                            <td className="px-2 py-1.5 uppercase">{row.status}</td>
                            <td className="px-2 py-1.5">{formatDatePt(row.closureDate)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-ink/50 dark:text-dark-subtle">Nenhuma reserva elegível com esses filtros.</p>
                )}

                {preview.eligibleCount > 0 ? (
                  <>
                    <label className="mt-2 block">
                      <span className="mb-1.5 block text-xs font-medium text-ink/55 dark:text-dark-muted">Motivo desta operação</span>
                      <textarea
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        rows={2}
                        placeholder="Ex.: limpeza trimestral de histórico"
                        className={inputClass}
                      />
                    </label>

                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-ink/55 dark:text-dark-muted">
                        Digite <strong className="font-mono">{CONFIRM_PHRASE}</strong> para confirmar
                      </span>
                      <input
                        value={confirmText}
                        onChange={(e) => setConfirmText(e.target.value)}
                        className={inputClass}
                      />
                    </label>
                  </>
                ) : null}

                <div className="mt-2 flex justify-end gap-2">
                  <button type="button" onClick={() => setStep('filters')} className="rounded-lg px-3.5 py-2 text-sm font-medium text-ink/60 dark:text-dark-muted hover:bg-ink/5 dark:hover:bg-white/5">
                    Voltar
                  </button>
                  {preview.eligibleCount > 0 ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={handleExecute}
                      className="rounded-lg bg-red-600 dark:bg-red-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-red-700 dark:hover:bg-red-600 disabled:opacity-60"
                    >
                      {pending ? 'Arquivando…' : `Arquivar ${preview.eligibleCount} reserva${preview.eligibleCount === 1 ? '' : 's'}`}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {step === 'result' && result ? (
              <div className="mt-4 flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <SummaryStat label="Arquivadas" value={result.archivedCount} tone="highlight" />
                  <SummaryStat label="Ignoradas" value={result.ignoredCount} />
                </div>
                {result.ignoredCount > 0 ? (
                  <div className="text-xs text-ink/55 dark:text-dark-subtle">
                    Motivo das ignoradas:{' '}
                    {Object.entries(result.ignoredReasons)
                      .map(([reason, count]) => `${reason} (${count})`)
                      .join(', ')}
                  </div>
                ) : null}
                <p className="text-xs text-ink/50 dark:text-dark-subtle">
                  Para desfazer, abra qualquer reserva arquivada e use &quot;Restaurar reserva&quot;.
                </p>
                <div className="mt-2 flex justify-end">
                  <button type="button" onClick={close} className="rounded-lg bg-marsala dark:bg-marsala-light px-3.5 py-2 text-sm font-medium text-cream dark:text-sand hover:bg-marsala/90 dark:hover:bg-marsala-glow">
                    Concluir
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function SummaryStat({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'highlight' }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${tone === 'highlight' ? 'border-marsala/20 bg-marsala/[0.06] dark:border-gold/20 dark:bg-gold/[0.06]' : 'border-ink/10 dark:border-white/10'}`}>
      <p className="text-[11px] text-ink/50 dark:text-dark-subtle">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-ink dark:text-dark-text">{value}</p>
    </div>
  );
}

function formatDatePt(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
