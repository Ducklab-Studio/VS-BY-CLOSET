'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowDownCircle, CheckCircle2, Loader2, Lock, LockOpen, RotateCcw, Search, Wallet } from 'lucide-react';
import type { ValePassBalanceView, ValePassBlockPreview, ValePassLedgerEntry, ValePassRedeemPreview, ValePassReversePreview } from '@/lib/admin-data';
import { centsToInput, COMPANY_LABELS, describeBalanceError, formatCents, parseReaisToCents, usedPercent } from '@/lib/valle-pass-balance';
import {
  confirmValePassBlockAction,
  prepareValePassBlockAction,
  confirmValePassRedeemAction,
  confirmValePassReverseAction,
  lookupValePassBalanceAction,
  prepareValePassRedeemAction,
  prepareValePassReverseAction,
} from './actions';

/**
 * Saldo e resgate parcial (ClosetAdmin — Valle Pass 2027).
 *
 * Consulta o voucher pelo código, mostra valor inicial, utilizado e saldo, restrições e histórico, e registra resgates parciais e reversões.
 * Tudo que protege o saldo está no BACKEND: esta tela só conduz a conferência em duas etapas (conferir → confirmar) e mostra o resultado devolvido
 * pela API. Resgate e reversão exigem administrador; para os demais usuários a tela só consulta (sem botões decorativos). O mesmo `operationId` é
 * reenviado em caso de falha de rede: a API é idempotente e nunca desconta duas vezes.
 */

const inputClass =
  'w-full rounded-lg border border-ink/15 bg-white px-3 py-2.5 text-sm text-ink outline-none transition focus:border-marsala focus:ring-2 focus:ring-marsala/20 disabled:opacity-60 dark:border-white/15 dark:bg-dark-surface dark:text-dark-text dark:focus:border-gold dark:focus:ring-gold/20';
const primaryButton =
  'inline-flex items-center justify-center gap-1.5 rounded-lg bg-marsala px-3.5 py-2.5 text-sm font-medium text-cream shadow-sm transition hover:bg-marsala/90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gold dark:text-dark-bg dark:hover:bg-gold/90';
const secondaryButton =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-ink/15 px-3 py-2 text-sm font-medium text-ink/75 transition hover:bg-ink/[0.04] disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:text-dark-text dark:hover:bg-white/5';
const labelClass = 'mb-1 block text-xs font-medium text-ink/60 dark:text-dark-subtle';
const hintClass = 'mt-1 text-[0.7rem] leading-snug text-ink/45 dark:text-dark-subtle';

const STATUS_LABELS = { ACTIVE: 'Ativo', USED: 'Utilizado', EXPIRED: 'Expirado', CANCELLED: 'Cancelado' } as const;
const STATUS_STYLES = {
  ACTIVE: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
  USED: 'bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300',
  EXPIRED: 'bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400',
  CANCELLED: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
} as const;
const COMPANY_STYLES = {
  VALLE_SHOWROOM: 'bg-marsala/10 text-marsala dark:bg-gold/15 dark:text-gold',
  VS_BY_CLOSET: 'bg-ink/10 text-ink dark:bg-white/10 dark:text-dark-text',
} as const;

const dateTime = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

interface Failure {
  readonly message: string;
  readonly code: string | null;
}

/**
 * `canOperate` = administrador (reversão, bloqueio e demais ações administrativas). `canRedeem` = quem pode TENTAR resgatar (inclui funcionários vinculados a um
 * estabelecimento); a decisão de verdade, por voucher, é do servidor (`view.operatorAccess`), nunca só da tela.
 */
export function BalanceDesk({ canOperate, canRedeem, request }: { canOperate: boolean; canRedeem: boolean; request: { code: string; nonce: number } | null }) {
  const [codeInput, setCodeInput] = useState('');
  const [view, setView] = useState<ValePassBalanceView | null>(null);
  const [loading, setLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // Resgate
  const [amountText, setAmountText] = useState('');
  const [reference, setReference] = useState('');
  const [preview, setPreview] = useState<ValePassRedeemPreview | null>(null);
  const [confirmText, setConfirmText] = useState('');
  // Conferência presencial da identidade: OPCIONAL (não é regra de acesso). Só registra no histórico e na auditoria.
  const [identityChecked, setIdentityChecked] = useState(false);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [redeemBusy, setRedeemBusy] = useState(false);
  const redeemLock = useRef(false);
  const lookupSeq = useRef(0);

  // Reversão
  const [reversing, setReversing] = useState<string | null>(null);
  const [reversePreview, setReversePreview] = useState<ValePassReversePreview | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [reverseConfirm, setReverseConfirm] = useState('');
  const [reverseError, setReverseError] = useState<string | null>(null);
  const [reverseBusy, setReverseBusy] = useState(false);
  const reverseLock = useRef(false);

  // Bloqueio / desbloqueio (somente ADMIN; a API exige justificativa, código redigitado e é idempotente)
  const [blockMode, setBlockMode] = useState<null | 'block' | 'unblock'>(null);
  const [blockPreview, setBlockPreview] = useState<ValePassBlockPreview | null>(null);
  const [blockReason, setBlockReason] = useState('');
  const [blockConfirmCode, setBlockConfirmCode] = useState('');
  const [blockError, setBlockError] = useState<string | null>(null);
  const [blockBusy, setBlockBusy] = useState(false);
  const blockLock = useRef(false);

  function resetForms() {
    setBlockMode(null);
    setBlockPreview(null);
    setBlockReason('');
    setBlockConfirmCode('');
    setBlockError(null);
    setAmountText('');
    setReference('');
    setPreview(null);
    setConfirmText('');
    setIdentityChecked(false);
    setRedeemError(null);
    setReversing(null);
    setReversePreview(null);
    setReverseReason('');
    setReverseConfirm('');
    setReverseError(null);
  }

  async function consult(raw: string, options: { keepFlash?: boolean; keepForms?: boolean } = {}) {
    const code = raw.trim();
    if (!code) {
      setLookupError('Informe o código do voucher.');
      return;
    }
    // Só a consulta MAIS RECENTE vale: a atualização em segundo plano de um voucher anterior (depois de um resgate) não pode sobrescrever a tela
    // quando a pessoa já consultou outro código.
    const seq = ++lookupSeq.current;
    setLoading(true);
    setLookupError(null);
    if (!options.keepFlash) setFlash(null);
    const { data, error } = await lookupValePassBalanceAction(code);
    if (seq !== lookupSeq.current) return;
    setLoading(false);
    if (error || !data) {
      setView(null);
      setLookupError(error?.message ?? 'Não foi possível consultar o voucher.');
      return;
    }
    // Atualização em segundo plano (depois de um resgate/reversão) não mexe no campo: a pessoa pode já estar digitando outro código.
    if (!options.keepForms) setCodeInput(data.code);
    setView(data);
    if (!options.keepForms) resetForms();
  }

  // Aberto a partir da lista de vouchers ("Resgatar por saldo").
  useEffect(() => {
    if (request) void consult(request.code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce]);

  // Autorização por estabelecimento: a tela só ESCONDE o que o servidor já recusaria (a barreira de verdade é do backend).
  const storeAllowed = view?.operatorAccess?.canOperate ?? true;
  const canRedeemHere = canRedeem && storeAllowed && view !== null && view.company !== null && view.redeemable;

  async function checkRedeem() {
    if (!view || !view.company) return;
    setRedeemError(null);
    const cents = parseReaisToCents(amountText);
    if (cents === null) return setRedeemError('Informe um valor válido em reais (ex.: 200 ou 200,50), maior que zero.');
    if (reference.trim().length < 3) return setRedeemError('Informe a referência da utilização (nota, pedido ou comanda).');
    setRedeemBusy(true);
    const { data, error } = await prepareValePassRedeemAction(view.code, { company: view.company, amountCents: cents, reference: reference.trim() });
    setRedeemBusy(false);
    if (error || !data) return setRedeemError(describeBalanceError(error?.code, error?.message ?? 'Não foi possível conferir o resgate.'));
    if (!data.canRedeem) return setRedeemError(data.problems.map((p) => describeBalanceError(p.code, p.message)).join(' '));
    setPreview(data);
    setConfirmText('');
  }

  async function confirmRedeem() {
    if (!view || !view.company || !preview || redeemLock.current) return;
    const typed = parseReaisToCents(confirmText);
    if (typed !== preview.amountCents) return setRedeemError('O valor digitado não confere com o resgate. Digite novamente o valor para confirmar.');
    redeemLock.current = true;
    setRedeemBusy(true);
    setRedeemError(null);
    const { data, error } = await confirmValePassRedeemAction(view.code, {
      company: view.company, amountCents: preview.amountCents, reference: reference.trim(),
      operationId: preview.operationId, expectedBalanceCents: preview.expectedBalanceCents, confirmAmountCents: typed,
      ...(identityChecked ? { identityChecked: true } : {}),
    });
    redeemLock.current = false;
    setRedeemBusy(false);
    if (error || !data) {
      setRedeemError(describeBalanceError(error?.code, error?.message ?? 'Não foi possível registrar o resgate.'));
      // Recusa DEFINITIVA (saldo mudou, restrição…): a prévia perdeu o sentido. Falha de rede: mantém — repetir é seguro (mesma operação, nunca desconta duas vezes).
      if (error?.code) {
        setPreview(null);
        void consult(view.code, { keepFlash: true, keepForms: true });
      }
      return;
    }
    // Saldo e histórico vêm da RESPOSTA do backend.
    setView({
      ...view,
      balanceCents: data.balanceCents,
      usedCents: data.usedCents,
      status: data.status,
      redeemable: data.status === 'ACTIVE' && view.redeemable,
      entries: [data.entry, ...view.entries.filter((e) => e.id !== data.entry.id)],
    });
    setFlash(
      data.replayed
        ? 'Esta operação já estava registrada: nada foi descontado de novo.'
        : `Resgate de ${formatCents(-data.entry.deltaCents)} registrado. Saldo disponível: ${formatCents(data.balanceCents)}.`,
    );
    setAmountText('');
    setReference('');
    setPreview(null);
    setConfirmText('');
    setIdentityChecked(false);
    void consult(view.code, { keepFlash: true, keepForms: true }); // atualiza restrições e histórico completo
  }

  async function openBlock(mode: 'block' | 'unblock') {
    if (!view) return;
    setBlockError(null);
    setBlockPreview(null);
    setBlockReason('');
    setBlockConfirmCode('');
    setBlockMode(mode);
    setBlockBusy(true);
    const { data, error } = await prepareValePassBlockAction(view.code, mode === 'unblock');
    setBlockBusy(false);
    if (error || !data) return setBlockError(describeBalanceError(error?.code, error?.message ?? 'Não foi possível conferir a operação.'));
    if (!data.canProceed) return setBlockError(data.problems.map((p) => describeBalanceError(p.code, p.message)).join(' '));
    setBlockPreview(data);
  }

  async function confirmBlock() {
    if (!view || !blockMode || !blockPreview || blockLock.current) return;
    if (blockReason.trim().length < 10) return setBlockError('Informe a justificativa (mínimo de 10 caracteres).');
    if (blockConfirmCode.trim().toUpperCase() !== view.code) return setBlockError('O código digitado não confere. Digite novamente o código do voucher.');
    blockLock.current = true;
    setBlockBusy(true);
    setBlockError(null);
    const unblock = blockMode === 'unblock';
    const { data, error } = await confirmValePassBlockAction(view.code, unblock, { reason: blockReason.trim(), operationId: blockPreview.operationId, confirmCode: blockConfirmCode.trim() });
    blockLock.current = false;
    setBlockBusy(false);
    if (error || !data) {
      setBlockError(describeBalanceError(error?.code, error?.message ?? 'Não foi possível concluir a operação.'));
      // Recusa definitiva (já bloqueado, cancelado, reembolso em revisão…): a prévia perdeu o sentido; falha de rede mantém (repetir é idempotente).
      if (error?.code) {
        setBlockPreview(null);
        setBlockMode(null);
        void consult(view.code, { keepFlash: true, keepForms: true });
      }
      return;
    }
    setFlash(data.replayed ? 'Esta operação já estava registrada: nada foi alterado de novo.' : unblock ? 'Voucher desbloqueado. O saldo e o status não mudaram.' : 'Voucher bloqueado. O saldo e o status não mudaram: nenhum resgate será aceito até o desbloqueio.');
    setBlockMode(null);
    setBlockPreview(null);
    setBlockReason('');
    setBlockConfirmCode('');
    void consult(view.code, { keepFlash: true });
  }

  async function checkReverse(entry: ValePassLedgerEntry) {
    if (!view) return;
    setReverseError(null);
    setReversing(entry.id);
    setReversePreview(null);
    setReverseReason('');
    setReverseConfirm('');
    const { data, error } = await prepareValePassReverseAction(view.code, entry.id);
    if (error || !data) return setReverseError(describeBalanceError(error?.code, error?.message ?? 'Não foi possível conferir a reversão.'));
    if (!data.canReverse) return setReverseError(data.problems.map((p) => describeBalanceError(p.code, p.message)).join(' '));
    setReversePreview(data);
  }

  async function confirmReverse() {
    if (!view || !reversing || !reversePreview || !reversePreview.entry || reverseLock.current) return;
    const typed = parseReaisToCents(reverseConfirm);
    if (typed !== -reversePreview.entry.deltaCents) return setReverseError('O valor digitado não confere com o resgate revertido.');
    if (reverseReason.trim().length < 10) return setReverseError('Informe a justificativa da reversão (mínimo de 10 caracteres).');
    reverseLock.current = true;
    setReverseBusy(true);
    setReverseError(null);
    const { data, error } = await confirmValePassReverseAction(view.code, reversing, {
      reason: reverseReason.trim(), operationId: reversePreview.operationId, expectedBalanceCents: reversePreview.expectedBalanceCents, confirmAmountCents: typed,
    });
    reverseLock.current = false;
    setReverseBusy(false);
    if (error || !data) {
      setReverseError(describeBalanceError(error?.code, error?.message ?? 'Não foi possível registrar a reversão.'));
      if (error?.code) {
        setReversePreview(null);
        void consult(view.code, { keepFlash: true, keepForms: true });
      }
      return;
    }
    setFlash(data.replayed ? 'Esta reversão já estava registrada: nada foi alterado de novo.' : `Reversão registrada. Saldo disponível: ${formatCents(data.balanceCents)}.`);
    setReversing(null);
    setReversePreview(null);
    void consult(view.code, { keepFlash: true });
  }

  return (
    <section className="space-y-4" aria-labelledby="balance-desk-title">
      <div className="flex items-center gap-2">
        <Wallet size={18} className="text-marsala dark:text-gold" />
        <h2 id="balance-desk-title" className="font-heading text-lg font-semibold text-ink dark:text-dark-text">
          Saldo e resgate
        </h2>
      </div>

      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          void consult(codeInput);
        }}
      >
        <div className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/35 dark:text-dark-subtle" />
          <input
            value={codeInput}
            onChange={(event) => setCodeInput(event.target.value.toUpperCase())}
            placeholder="Código do voucher (ex.: VALLE-AB12-CD34)"
            aria-label="Código do voucher"
            autoComplete="off"
            spellCheck={false}
            maxLength={40}
            className={`${inputClass} pl-9 font-mono tracking-wide`}
          />
        </div>
        <button type="submit" className={primaryButton} disabled={loading}>
          {loading ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />} Consultar
        </button>
      </form>

      <div aria-live="polite" className="space-y-2">
        {lookupError ? <Notice tone="error">{lookupError}</Notice> : null}
        {flash ? <Notice tone="success">{flash}</Notice> : null}
      </div>

      {!view && !lookupError && !loading ? (
        <p className="rounded-xl border border-dashed border-ink/15 px-4 py-8 text-center text-sm text-ink/50 dark:border-white/15 dark:text-dark-subtle">
          Digite o código de um voucher para ver o saldo, a validade e o histórico de utilização.
        </p>
      ) : null}

      {view ? (
        <div className="space-y-4 rounded-2xl border border-ink/10 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-dark-surface sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            {view.company ? <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${COMPANY_STYLES[view.company]}`}>{COMPANY_LABELS[view.company]}</span> : <span className="rounded-full bg-neutral-200 px-2.5 py-1 text-xs font-semibold text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">Voucher legado</span>}
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_STYLES[view.status]}`}>{STATUS_LABELS[view.status]}</span>
            {view.blockedAt ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-700 dark:bg-red-950/60 dark:text-red-300"><Lock size={12} /> Bloqueado</span>
            ) : null}
            <span className="font-mono text-sm text-ink/70 dark:text-dark-subtle">{view.code}</span>
          </div>

          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Metric label="Valor inicial" value={formatCents(view.amountCents)} />
            <Metric label="Utilizado" value={formatCents(view.usedCents)} />
            <Metric label="Saldo disponível" value={formatCents(view.balanceCents)} strong />
          </dl>
          <div className="h-2 overflow-hidden rounded-full bg-ink/10 dark:bg-white/10" role="img" aria-label={`${usedPercent(view.amountCents, view.balanceCents)}% utilizado`}>
            <div className="h-full rounded-full bg-marsala dark:bg-gold" style={{ width: `${usedPercent(view.amountCents, view.balanceCents)}%` }} />
          </div>

          <div className="grid gap-x-6 gap-y-1 text-xs text-ink/60 dark:text-dark-subtle sm:grid-cols-2">
            {view.benefitLabel ? <p>Benefício: {view.benefitLabel}</p> : null}
            <p>Validade: {view.validFrom ? `${day(view.validFrom)} a ` : 'até '}{day(view.expiresAt)}</p>
            {view.orderName ? <p>Pedido: {view.orderName}</p> : null}
            <p>Titular: {view.holder.name ?? '—'}{view.holder.phoneMasked ? ` · tel. ${view.holder.phoneMasked}` : ''}{view.holder.emailMasked ? ` · ${view.holder.emailMasked}` : ''}</p>
          </div>

          {view.restrictions.length > 0 ? (
            <Notice tone="warning">
              <strong className="font-semibold">Resgate indisponível:</strong>{' '}
              {view.restrictions.map((r) => describeBalanceError(r.code, r.message)).join(' ')}
            </Notice>
          ) : null}

          {/* ── Resgate ──────────────────────────────────────────────── */}
          {view.company === null ? null : !canRedeem ? (
            <p className="flex items-start gap-2 rounded-lg bg-ink/[0.04] px-3 py-2.5 text-xs text-ink/60 dark:bg-white/5 dark:text-dark-subtle">
              <Lock size={14} className="mt-0.5 shrink-0" /> Resgate e reversão por saldo exigem um administrador. Você pode consultar o saldo e o histórico.
            </p>
          ) : !storeAllowed ? (
            <p className="flex items-start gap-2 rounded-lg bg-ink/[0.04] px-3 py-2.5 text-xs text-ink/60 dark:bg-white/5 dark:text-dark-subtle">
              <Lock size={14} className="mt-0.5 shrink-0" /> {view.operatorAccess?.message ?? 'Seu usuário não está autorizado neste estabelecimento.'} Você pode consultar o saldo e o histórico.
            </p>
          ) : canRedeemHere ? (
            <div className="space-y-3 rounded-xl border border-ink/10 p-3.5 dark:border-white/10">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink dark:text-dark-text"><ArrowDownCircle size={15} /> Registrar resgate ({COMPANY_LABELS[view.company]})</h3>
              {!canOperate ? <p className="text-xs text-ink/55 dark:text-dark-subtle">Você pode registrar o resgate neste estabelecimento. Reversões e bloqueios são feitos por um administrador.</p> : null}
              {!preview ? (
                <>
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end">
                    <div>
                      <label htmlFor="redeem-amount" className={labelClass}>Valor a utilizar (R$)</label>
                      <input id="redeem-amount" inputMode="decimal" autoComplete="off" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="200,00" className={inputClass} disabled={redeemBusy} />
                      {view.balanceCents > 0 ? (
                        <button type="button" data-testid="redeem-use-full" className="mt-1 text-[0.7rem] font-medium text-marsala underline underline-offset-2 hover:opacity-80 disabled:opacity-50 dark:text-gold" onClick={() => setAmountText(centsToInput(view.balanceCents))} disabled={redeemBusy}>
                          Usar saldo total ({formatCents(view.balanceCents)})
                        </button>
                      ) : null}
                    </div>
                    <div>
                      <label htmlFor="redeem-ref" className={labelClass}>Referência da utilização</label>
                      <input id="redeem-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Nota, pedido ou comanda" maxLength={200} className={inputClass} disabled={redeemBusy} />
                    </div>
                    <button type="button" className={primaryButton} onClick={() => void checkRedeem()} disabled={redeemBusy || !amountText.trim() || !reference.trim()}>
                      {redeemBusy ? <Loader2 size={15} className="animate-spin" /> : null} Conferir
                    </button>
                  </div>
                  <p className={hintClass}>O saldo só muda depois da confirmação. Nada é gravado nesta etapa.</p>
                </>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-2 rounded-lg bg-cream/60 p-3 text-center dark:bg-white/5">
                    <Metric label="Saldo antes" value={formatCents(preview.balanceBeforeCents)} />
                    <Metric label="Resgate" value={`− ${formatCents(preview.amountCents)}`} />
                    <Metric label="Saldo depois" value={formatCents(preview.balanceAfterCents ?? 0)} strong />
                  </div>
                  <p className="text-xs text-ink/60 dark:text-dark-subtle">Referência: {reference.trim()}</p>
                  <label className="flex items-start gap-2 text-xs text-ink/70 dark:text-dark-muted">
                    <input type="checkbox" data-testid="redeem-identity" className="mt-0.5" checked={identityChecked} onChange={(e) => setIdentityChecked(e.target.checked)} disabled={redeemBusy} />
                    <span>
                      Identidade do titular conferida pela equipe (opcional). Fica registrada no histórico e na auditoria; não é exigida para o resgate nem altera o saldo.
                    </span>
                  </label>
                  <div>
                    <label htmlFor="redeem-confirm" className={labelClass}>Digite novamente o valor ({formatCents(preview.amountCents)}) para confirmar</label>
                    <input id="redeem-confirm" inputMode="decimal" autoComplete="off" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} className={inputClass} disabled={redeemBusy} />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={primaryButton} onClick={() => void confirmRedeem()} disabled={redeemBusy || parseReaisToCents(confirmText) !== preview.amountCents}>
                      {redeemBusy ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} Confirmar resgate
                    </button>
                    <button type="button" className={secondaryButton} onClick={() => { setPreview(null); setRedeemError(null); }} disabled={redeemBusy}>Voltar</button>
                  </div>
                </div>
              )}
              {redeemError ? <Notice tone="error">{redeemError}</Notice> : null}
            </div>
          ) : null}

          {/* ── Bloqueio (somente ADMIN) ───────────────────────────── */}
          {view.blockedAt ? (
            <Notice tone="warning">
              <strong className="font-semibold">Voucher bloqueado</strong> em {dateTime(view.blockedAt)}.{view.blockedReason ? ` Motivo: ${view.blockedReason}` : ''} Nenhum resgate ou reversão é aceito até o desbloqueio.
            </Notice>
          ) : null}
          {canOperate ? (
            <div className="space-y-3 rounded-xl border border-ink/10 p-3.5 dark:border-white/10">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink dark:text-dark-text">{view.blockedAt ? <LockOpen size={15} /> : <Lock size={15} />} Bloqueio administrativo</h3>
                {blockMode === null ? (
                  <button type="button" className={secondaryButton} onClick={() => void openBlock(view.blockedAt ? 'unblock' : 'block')} disabled={blockBusy}>
                    {view.blockedAt ? 'Desbloquear voucher…' : 'Bloquear voucher…'}
                  </button>
                ) : null}
              </div>
              <p className={hintClass}>
                Bloquear não cancela o voucher nem altera saldo ou histórico. Desbloquear nunca reativa voucher cancelado, expirado ou com reembolso em análise.
              </p>
              {blockMode !== null ? (
                <div className="space-y-3">
                  {blockBusy && !blockPreview ? <p className="flex items-center gap-2 text-xs text-ink/60 dark:text-dark-subtle"><Loader2 size={14} className="animate-spin" /> Conferindo…</p> : null}
                  {blockPreview ? (
                    <>
                      {blockMode === 'unblock' && blockPreview.stillRestricted.length > 0 ? (
                        <Notice tone="warning">
                          <strong className="font-semibold">Depois do desbloqueio, o resgate continuará indisponível:</strong>{' '}
                          {blockPreview.stillRestricted.map((r) => describeBalanceError(r.code, r.message)).join(' ')}
                        </Notice>
                      ) : null}
                      <div>
                        <label htmlFor="block-reason" className={labelClass}>Justificativa (mínimo 10 caracteres)</label>
                        <input id="block-reason" value={blockReason} onChange={(e) => setBlockReason(e.target.value)} maxLength={500} className={inputClass} disabled={blockBusy} />
                      </div>
                      <div>
                        <label htmlFor="block-confirm" className={labelClass}>Digite novamente o código do voucher ({view.code}) para confirmar</label>
                        <input id="block-confirm" value={blockConfirmCode} onChange={(e) => setBlockConfirmCode(e.target.value.toUpperCase())} autoComplete="off" spellCheck={false} maxLength={40} className={`${inputClass} font-mono tracking-wide`} disabled={blockBusy} />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className={primaryButton}
                          onClick={() => void confirmBlock()}
                          disabled={blockBusy || blockReason.trim().length < 10 || blockConfirmCode.trim().toUpperCase() !== view.code}
                        >
                          {blockBusy ? <Loader2 size={15} className="animate-spin" /> : blockMode === 'unblock' ? <LockOpen size={15} /> : <Lock size={15} />} {blockMode === 'unblock' ? 'Confirmar desbloqueio' : 'Confirmar bloqueio'}
                        </button>
                        <button type="button" className={secondaryButton} onClick={() => { setBlockMode(null); setBlockPreview(null); setBlockError(null); }} disabled={blockBusy}>Cancelar</button>
                      </div>
                    </>
                  ) : (
                    <button type="button" className={secondaryButton} onClick={() => { setBlockMode(null); setBlockError(null); }} disabled={blockBusy}>Fechar</button>
                  )}
                </div>
              ) : null}
              {blockError ? <Notice tone="error">{blockError}</Notice> : null}
              {view.blockHistory.length > 0 ? (
                <ul className="divide-y divide-ink/10 text-xs dark:divide-white/10">
                  {view.blockHistory.map((entry) => (
                    <li key={entry.id} className="py-1.5 text-ink/65 dark:text-dark-subtle">
                      <span className="font-medium text-ink dark:text-dark-text">{entry.kind === 'BLOCK' ? 'Bloqueio' : 'Desbloqueio'}</span> · {dateTime(entry.createdAt)} · {entry.actorName ?? 'Sistema'}
                      {entry.reason ? ` · ${entry.reason}` : ''}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {/* ── Histórico ────────────────────────────────────────────── */}
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-ink dark:text-dark-text">Histórico de movimentações</h3>
            {view.entries.length === 0 ? (
              <p className="rounded-lg bg-ink/[0.03] px-3 py-4 text-center text-xs text-ink/50 dark:bg-white/5 dark:text-dark-subtle">Nenhuma movimentação ainda. O saldo é o valor inicial.</p>
            ) : (
              <ul className="divide-y divide-ink/10 overflow-hidden rounded-xl border border-ink/10 dark:divide-white/10 dark:border-white/10">
                {view.entries.map((entry) => (
                  <li key={entry.id} className="space-y-2 px-3 py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-ink/45 dark:text-dark-subtle">#{entry.seq}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[0.7rem] font-semibold ${entry.kind === 'REDEEM' ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300' : 'bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300'}`}>
                          {entry.kind === 'REDEEM' ? 'Resgate' : entry.kind === 'REVERSAL' ? 'Reversão' : entry.kind === 'ADJUSTMENT' ? 'Ajuste' : 'Baixa por reembolso'}
                        </span>
                        {entry.reversed ? <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-[0.7rem] font-semibold text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">Revertido</span> : null}
                      </div>
                      <div className="text-right">
                        <p className={`font-semibold tabular-nums ${entry.deltaCents < 0 ? 'text-ink dark:text-dark-text' : 'text-emerald-700 dark:text-emerald-300'}`}>
                          {entry.deltaCents < 0 ? '− ' : '+ '}{formatCents(Math.abs(entry.deltaCents))}
                        </p>
                        <p className="text-[0.7rem] text-ink/50 dark:text-dark-subtle">Saldo: {formatCents(entry.balanceAfterCents)}</p>
                      </div>
                    </div>
                    <p className="text-xs text-ink/55 dark:text-dark-subtle">
                      {dateTime(entry.createdAt)} · {entry.actorName ?? 'Sistema'}
                      {entry.reference ? ` · Ref.: ${entry.reference}` : ''}
                      {entry.reason ? ` · Motivo: ${entry.reason}` : ''}
                    </p>
                    {canOperate && storeAllowed && entry.kind === 'REDEEM' && !entry.reversed ? (
                      <div>
                        {reversing === entry.id && reversePreview?.entry ? (
                          <div className="space-y-2.5 rounded-lg border border-ink/10 p-3 dark:border-white/10">
                            <p className="text-xs text-ink/70 dark:text-dark-subtle">Saldo {formatCents(reversePreview.balanceBeforeCents)} → {formatCents(reversePreview.balanceAfterCents ?? 0)} após devolver {formatCents(-reversePreview.entry.deltaCents)}.</p>
                            <div>
                              <label className={labelClass} htmlFor={`rv-reason-${entry.id}`}>Justificativa (mínimo 10 caracteres)</label>
                              <input id={`rv-reason-${entry.id}`} value={reverseReason} onChange={(e) => setReverseReason(e.target.value)} maxLength={500} className={inputClass} disabled={reverseBusy} />
                            </div>
                            <div>
                              <label className={labelClass} htmlFor={`rv-confirm-${entry.id}`}>Digite novamente o valor ({formatCents(-reversePreview.entry.deltaCents)})</label>
                              <input id={`rv-confirm-${entry.id}`} inputMode="decimal" autoComplete="off" value={reverseConfirm} onChange={(e) => setReverseConfirm(e.target.value)} className={inputClass} disabled={reverseBusy} />
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <button type="button" className={primaryButton} onClick={() => void confirmReverse()} disabled={reverseBusy || reverseReason.trim().length < 10 || parseReaisToCents(reverseConfirm) !== -reversePreview.entry.deltaCents}>
                                {reverseBusy ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />} Confirmar reversão
                              </button>
                              <button type="button" className={secondaryButton} onClick={() => { setReversing(null); setReversePreview(null); setReverseError(null); }} disabled={reverseBusy}>Cancelar</button>
                            </div>
                          </div>
                        ) : (
                          <button type="button" className={secondaryButton} onClick={() => void checkReverse(entry)} disabled={reverseBusy || reversing === entry.id}>
                            {reversing === entry.id ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />} Reverter este resgate
                          </button>
                        )}
                        {reversing === entry.id && reverseError ? <div className="mt-2"><Notice tone="error">{reverseError}</Notice></div> : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Metric({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-lg bg-cream/50 px-3 py-2.5 dark:bg-white/5">
      <dt className="text-[0.7rem] font-medium uppercase tracking-wide text-ink/50 dark:text-dark-subtle">{label}</dt>
      <dd className={`mt-0.5 tabular-nums ${strong ? 'text-xl font-semibold text-marsala dark:text-gold' : 'text-base font-medium text-ink dark:text-dark-text'}`}>{value}</dd>
    </div>
  );
}

const NOTICE_STYLES = {
  error: 'border-red-500/30 bg-red-500/[0.08] text-red-600 dark:text-red-400',
  warning: 'border-amber-500/30 bg-amber-500/[0.08] text-amber-700 dark:text-amber-400',
  success: 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300',
} as const;

function Notice({ tone, children }: { tone: keyof typeof NOTICE_STYLES; children: React.ReactNode }) {
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs leading-snug ${NOTICE_STYLES[tone]}`}>
      {tone === 'success' ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
      <span>{children}</span>
    </p>
  );
}
