'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import type { ValePassCampaign, ValePassExtensionPreview, ValePassExtensionView } from '@/lib/admin-data';
import { formatCents } from '@/lib/valle-pass-balance';
import { confirmValePassExtensionAction, listValePassExtensionsAction, prepareValePassExtensionAction } from './actions';

/**
 * Prorrogação coletiva da validade dos vouchers (só o proprietário). A tela NUNCA sugere uma data: o campo nasce vazio e a nova data é sempre digitada por quem decide.
 * Duas etapas: prévia (nada é gravado) e confirmação com justificativa, nova data redigitada e a contagem vista na prévia. A tela só ENCAMINHA: a API revalida (somente
 * SUPER_ADMIN), o banco só aceita data MAIOR e aplica tudo ou nada. Prévia desatualizada nunca é confirmada (a tela descarta ao mudar campanha/data, e o servidor recusa).
 */
const inputClass =
  'w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink outline-none transition focus:border-marsala focus:ring-2 focus:ring-marsala/20 dark:border-white/15 dark:bg-dark-surface dark:text-dark-text';
const buttonClass =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-ink/15 px-3 py-2 text-xs font-medium text-ink/80 transition hover:bg-ink/[0.04] disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:text-dark-text dark:hover:bg-white/5';
const primaryButtonClass =
  'inline-flex items-center justify-center gap-1.5 rounded-lg bg-marsala px-3.5 py-2 text-xs font-semibold text-cream transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayBR = (iso: string) => (ISO_DAY.test(iso) ? iso.split('-').reverse().join('/') : iso);
const dateTimeBR = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function ValidityExtensionPanel({ campaigns }: { campaigns: readonly ValePassCampaign[] }) {
  const [expanded, setExpanded] = useState(false);
  const [campaignId, setCampaignId] = useState(campaigns.length === 1 ? campaigns[0].id : '');
  const [newUntil, setNewUntil] = useState('');
  const [preview, setPreview] = useState<ValePassExtensionPreview | null>(null);
  const [reason, setReason] = useState('');
  const [confirmDate, setConfirmDate] = useState('');
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<readonly ValePassExtensionView[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  /** Validade atual conhecida pela tela (atualizada depois de uma prorrogação, sem depender de recarregar a página). */
  const [untilOverride, setUntilOverride] = useState<Record<string, string>>({});
  const inFlight = useRef(false);

  const campaign = useMemo(() => campaigns.find((c) => c.id === campaignId) ?? null, [campaigns, campaignId]);
  const currentUntil = campaign ? (untilOverride[campaign.id] ?? campaign.voucherValidUntil) : null;

  const loadHistory = useCallback(async (id: string) => {
    const result = await listValePassExtensionsAction(id);
    if (result.error) {
      setHistory(null);
      setHistoryError(result.error.message);
    } else {
      setHistoryError(null);
      setHistory(result.data);
    }
  }, []);

  useEffect(() => {
    if (expanded && campaignId) void loadHistory(campaignId);
  }, [expanded, campaignId, loadHistory]);

  function discardPreview() {
    setPreview(null);
    setReason('');
    setConfirmDate('');
    setError(null);
  }

  async function runPreview() {
    if (!campaignId || !ISO_DAY.test(newUntil) || inFlight.current) return;
    inFlight.current = true;
    setLoadingPreview(true);
    setNotice(null);
    discardPreview();
    const result = await prepareValePassExtensionAction(campaignId, newUntil);
    inFlight.current = false;
    setLoadingPreview(false);
    if (result.error) setError(result.error.message);
    else setPreview(result.data);
  }

  async function confirm() {
    if (!preview || !campaignId || inFlight.current) return;
    inFlight.current = true;
    setConfirming(true);
    setError(null);
    const result = await confirmValePassExtensionAction(campaignId, {
      newUntil: preview.newUntil,
      reason: reason.trim(),
      operationId: preview.operationId,
      confirmDate,
      expectedEligibleCount: preview.counts.eligible,
    });
    inFlight.current = false;
    setConfirming(false);
    if (result.error) {
      setError(result.error.message);
      // Prévia vencida/alterada: nunca se reaproveita; o operador precisa ver os números de novo.
      if (['STALE_PREVIEW', 'NOT_AFTER_CURRENT', 'IDEMPOTENCY_CONFLICT', 'CHANGED_DURING_OPERATION'].includes(result.error.code ?? '')) setPreview(null);
      return;
    }
    const done = result.data;
    setUntilOverride((current) => ({ ...current, [campaignId]: done.extension.newUntil }));
    setNotice(
      `${done.replayed ? 'Esta prorrogação já tinha sido registrada' : 'Prorrogação registrada'}: validade até ${dayBR(done.extension.newUntil)}. ${done.extension.extendedCount} voucher(s) prorrogado(s); saldos e histórico intactos.`,
    );
    setPreview(null);
    setReason('');
    setConfirmDate('');
    setNewUntil('');
    await loadHistory(campaignId);
  }

  const reasonOk = reason.trim().length >= 10 && reason.trim().length <= 500;
  const dateOk = preview !== null && confirmDate === preview.newUntil;
  const canConfirm = preview !== null && preview.canProceed && reasonOk && dateOk && !confirming;

  return (
    <section className="space-y-4" aria-label="Prorrogação de validade">
      <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} className="flex w-full items-center justify-between gap-2 text-left">
        <span className="flex items-center gap-2">
          <CalendarClock size={18} className="text-marsala dark:text-gold" />
          <h2 className="font-heading text-lg font-semibold text-ink dark:text-dark-text">Prorrogação de validade</h2>
        </span>
        {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>

      {expanded ? (
        <div className="space-y-4">
          <p className="text-xs leading-relaxed text-ink/60 dark:text-dark-subtle">
            Estende a validade de <strong>todos</strong> os vouchers elegíveis da campanha para uma data <strong>posterior</strong> à atual. A data é sempre informada por você: o sistema não sugere nenhuma.
            A prorrogação <strong>não reativa</strong> vouchers cancelados, reembolsados ou já expirados e <strong>não altera saldos nem histórico</strong>. Nenhum e-mail é enviado.
          </p>

          {campaigns.length === 0 ? <p className="text-sm text-ink/60">Nenhuma campanha cadastrada.</p> : (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs font-medium text-ink/70 dark:text-dark-subtle">
                Campanha
                <select
                  className={inputClass}
                  value={campaignId}
                  onChange={(event) => { setCampaignId(event.target.value); setHistory(null); setNotice(null); discardPreview(); }}
                >
                  <option value="">Selecione…</option>
                  {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <div className="space-y-1 text-xs font-medium text-ink/70 dark:text-dark-subtle">
                <span>Validade atual</span>
                <p className="rounded-lg bg-ink/[0.04] px-3 py-2 text-sm text-ink dark:bg-white/5 dark:text-dark-text" data-testid="current-validity">
                  {campaign ? (currentUntil ? `até ${dayBR(currentUntil)}` : 'não configurada (nada a prorrogar)') : '—'}
                </p>
              </div>
            </div>
          )}

          {campaign && currentUntil ? (
            <div className="space-y-3 rounded-xl border border-ink/10 p-3.5 dark:border-white/10">
              <div className="flex flex-wrap items-end gap-3">
                <label className="space-y-1 text-xs font-medium text-ink/70 dark:text-dark-subtle">
                  Nova data final (último dia de uso)
                  <input type="date" className={inputClass} value={newUntil} onChange={(event) => { setNewUntil(event.target.value); setNotice(null); discardPreview(); }} />
                </label>
                <button type="button" className={buttonClass} disabled={!ISO_DAY.test(newUntil) || loadingPreview} onClick={() => void runPreview()}>
                  {loadingPreview ? <Loader2 size={14} className="animate-spin" /> : null} Ver prévia
                </button>
              </div>

              {error ? <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/[0.08] px-3 py-2 text-xs text-red-500">{error}</p> : null}
              {notice ? <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.08] px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">{notice}</p> : null}

              {preview ? (
                <div className="space-y-3" data-testid="extension-preview">
                  {preview.problems.length > 0 ? (
                    <ul role="alert" className="space-y-1 rounded-lg border border-red-500/30 bg-red-500/[0.08] px-3 py-2 text-xs text-red-500">
                      {preview.problems.map((problem) => <li key={problem.code}>{problem.message}</li>)}
                    </ul>
                  ) : (
                    <>
                      <p className="text-sm text-ink dark:text-dark-text">
                        Validade de <strong>{dayBR(preview.currentUntil ?? '')}</strong> para <strong>{dayBR(preview.newUntil)}</strong>
                        {preview.newExpiresAt ? <span className="text-xs text-ink/60 dark:text-dark-subtle"> (deixa de valer em {dateTimeBR(preview.newExpiresAt)}, fuso {preview.timezone})</span> : null}.
                      </p>
                      <dl className="grid gap-2 text-sm sm:grid-cols-2">
                        <div className="rounded-lg bg-emerald-500/[0.07] px-3 py-2">
                          <dt className="text-xs font-medium text-ink/60 dark:text-dark-subtle">Serão prorrogados</dt>
                          <dd className="text-lg font-semibold text-ink dark:text-dark-text" data-testid="eligible-count">{preview.counts.eligible}</dd>
                          <dd className="text-[0.7rem] text-ink/60 dark:text-dark-subtle">
                            Valle Showroom {preview.counts.eligibleByCompany.VALLE_SHOWROOM} · VS BY CLOSET {preview.counts.eligibleByCompany.VS_BY_CLOSET}
                            {preview.counts.eligibleByCompany.LEGACY > 0 ? ` · legado ${preview.counts.eligibleByCompany.LEGACY}` : ''} · saldos somados {formatCents(preview.counts.eligibleBalanceCents)} (não mudam)
                          </dd>
                        </div>
                        <div className="rounded-lg bg-ink/[0.04] px-3 py-2 dark:bg-white/5">
                          <dt className="text-xs font-medium text-ink/60 dark:text-dark-subtle">Ficam de fora</dt>
                          <dd className="text-lg font-semibold text-ink dark:text-dark-text" data-testid="excluded-count">{preview.counts.expiredNotIncluded + preview.counts.cancelledNotIncluded + preview.counts.alreadyLonger}</dd>
                          <dd className="text-[0.7rem] text-ink/60 dark:text-dark-subtle">
                            expirados {preview.counts.expiredNotIncluded} · cancelados/reembolsados {preview.counts.cancelledNotIncluded} · já com validade igual ou maior {preview.counts.alreadyLonger}
                          </dd>
                        </div>
                      </dl>
                      <ul className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-xs text-ink/80 dark:text-dark-text">
                        <li><strong>Expirados</strong> ({preview.counts.expiredNotIncluded}) <strong>não</strong> são reativados nem prorrogados: essa regra ainda depende de decisão comercial.</li>
                        <li><strong>Cancelados e reembolsados</strong> ({preview.counts.cancelledNotIncluded}) continuam cancelados.</li>
                        <li>Saldos, histórico de resgates, bloqueios e benefícios não são alterados. A prorrogação só aumenta a validade e não pode ser desfeita.</li>
                      </ul>

                      <div className="space-y-3 rounded-lg border border-ink/10 p-3 dark:border-white/10">
                        <label className="block space-y-1 text-xs font-medium text-ink/70 dark:text-dark-subtle">
                          Justificativa (mínimo 10 caracteres)
                          <textarea className={inputClass} rows={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
                        </label>
                        <label className="block space-y-1 text-xs font-medium text-ink/70 dark:text-dark-subtle">
                          Digite novamente a nova data (AAAA-MM-DD)
                          <input className={inputClass} placeholder="AAAA-MM-DD" value={confirmDate} onChange={(event) => setConfirmDate(event.target.value.trim())} inputMode="numeric" autoComplete="off" />
                        </label>
                        <button type="button" className={primaryButtonClass} disabled={!canConfirm} onClick={() => void confirm()}>
                          {confirming ? <><Loader2 size={14} className="animate-spin" /> Registrando…</> : 'Confirmar prorrogação'}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}

          {campaignId ? (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-ink dark:text-dark-text">Histórico de prorrogações</h3>
              {historyError ? <p role="alert" className="text-xs text-red-500">{historyError}</p> : null}
              {history === null && !historyError ? <p role="status" className="text-xs text-ink/60">Carregando…</p> : null}
              {history && history.length === 0 ? <p className="text-xs text-ink/60 dark:text-dark-subtle">Nenhuma prorrogação registrada.</p> : null}
              <ul className="space-y-1.5">
                {(history ?? []).map((entry) => (
                  <li key={entry.id} className="rounded-lg border border-ink/10 px-3 py-2 text-xs dark:border-white/10" data-testid="extension-history-row">
                    <p className="font-medium text-ink dark:text-dark-text">#{entry.seq} · {dayBR(entry.previousUntil)} → {dayBR(entry.newUntil)} · {dateTimeBR(entry.createdAt)} · {entry.actorName ?? 'Sistema'}</p>
                    <p className="text-ink/60 dark:text-dark-subtle">
                      {entry.extendedCount} prorrogado(s) · de fora: {entry.expiredNotIncluded} expirado(s), {entry.cancelledNotIncluded} cancelado(s), {entry.alreadyLongerCount} com validade maior · saldos somados {formatCents(entry.balanceTotalCents)}
                    </p>
                    <p className="text-ink/60 dark:text-dark-subtle">Motivo: {entry.reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
