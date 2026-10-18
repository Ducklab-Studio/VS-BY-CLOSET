'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, ShieldAlert } from 'lucide-react';
import type { ValePassFlowStatus } from '@/lib/admin-data';
import { notifyValePassFinancialChanged } from '@/components/closetadmin/useValePassFinancialAttention';
import { confirmValePassPaymentTimeAction, getValePassFlowStatusAction, regularizeValePassOrderAction, verifyValePassPaymentTimeAction } from './actions';

/**
 * Integração financeira do Valle Pass 2027 (ClosetAdmin): estado das DUAS chaves e o que ainda não está resolvido.
 *
 * Diferencia três coisas que não se misturam: (1) pagamentos RETIDOS (a fila de resolução, por causa), (2) unidades pagas SEM tratamento nenhum
 * (variante sem campanha, compra que aumentou) com a regularização do ADMIN, e (3) e-mails AGUARDANDO envio (só registrados na fila — nada sai
 * enquanto o envio estiver desligado). As chaves são lidas do servidor e NÃO são alteradas por aqui: ligar/desligar é configuração do Railway.
 */

const secondaryButton =
  'inline-flex items-center gap-1.5 rounded-lg border border-ink/15 px-2.5 py-1.5 text-xs font-medium text-ink/75 transition hover:bg-ink/[0.04] disabled:opacity-50 dark:border-white/15 dark:text-dark-text dark:hover:bg-white/5';
const inputClass =
  'w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink outline-none transition focus:border-marsala focus:ring-2 focus:ring-marsala/20 dark:border-white/15 dark:bg-dark-surface dark:text-dark-text dark:focus:border-gold dark:focus:ring-gold/20';
const hintClass = 'mt-1 text-[0.7rem] leading-snug text-ink/45 dark:text-dark-subtle';
const ON = 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300';
const OFF = 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300';

const KIND_LABELS = { NOT_PROCESSED: 'pagamento sem nenhum voucher', QUANTITY_INCREASED: 'compra aumentou depois da emissão' } as const;

function FlagBadge({ label, on, offHint }: { label: string; on: boolean; offHint: string }) {
  return (
    <div className="rounded-xl border border-ink/10 p-3 dark:border-white/10" data-flag={label}>
      <p className="text-xs text-ink/60 dark:text-dark-muted">{label}</p>
      <span className={`mt-1 inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${on ? ON : OFF}`}>{on ? 'LIGADA' : 'DESLIGADA'}</span>
      {!on ? <p className={hintClass}>{offHint}</p> : null}
    </div>
  );
}

export function FlowPanel({ canManage }: { canManage: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<ValePassFlowStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await getValePassFlowStatusAction();
    setLoading(false);
    setError(result.error);
    if (!result.error) setStatus(result.status);
  }, []);

  useEffect(() => {
    if (expanded) void refresh();
  }, [expanded, refresh]);

  const pending = status ? status.heldPayments + status.ordersWithoutTreatment.length : 0;
  const refreshAll = useCallback(async () => {
    await refresh();
    notifyValePassFinancialChanged(); // o contador do menu acompanha na hora
  }, [refresh]);

  return (
    <section className="space-y-4" aria-label="Integração financeira">
      <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} className="flex w-full items-center justify-between gap-2 text-left">
        <span className="flex items-center gap-2">
          <ShieldAlert size={18} className="text-marsala dark:text-gold" />
          <h2 className="font-heading text-lg font-semibold text-ink dark:text-dark-text">Integração financeira</h2>
          {pending > 0 ? <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[0.7rem] font-semibold text-red-500">{pending} pendência(s)</span> : null}
        </span>
        {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>

      {expanded ? (
        <div className="space-y-4 rounded-2xl border border-ink/10 p-4 dark:border-white/10">
          {error ? (
            <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3.5 py-2.5 text-sm text-red-400">
              {error}
            </p>
          ) : null}
          {!status && loading ? <p className="text-xs text-ink/45 dark:text-dark-subtle">Carregando…</p> : null}
          {status ? <FlowView status={status} canManage={canManage} onChanged={refreshAll} /> : null}
        </div>
      ) : null}
    </section>
  );
}

function FlowView({ status, canManage, onChanged }: { status: ValePassFlowStatus; canManage: boolean; onChanged: () => void }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <FlagBadge label="Emissão dos dois vouchers" on={status.twoVoucherFlow} offHint="Pagamentos de campanhas com benefícios ficam RETIDOS; nenhum voucher é emitido." />
        <FlagBadge label="Reembolso por unidade (campanhas sem benefícios)" on={status.unitRefunds} offHint="Pedidos dos dois vouchers são SEMPRE tratados por unidade; esta chave só vale para os demais." />
      </div>
      {status.notices.length > 0 ? (
        <ul className="space-y-1 text-xs text-ink/70 dark:text-dark-muted">
          {status.notices.map((notice) => (
            <li key={notice}>• {notice}</li>
          ))}
        </ul>
      ) : null}
      <p className={hintClass}>As chaves são lidas do servidor (Railway) e não são alteradas por esta tela. Nada é ligado sem autorização expressa.</p>

      <OperationalCounters status={status} />
      <p className={hintClass} data-testid="payment-time-policy">
        Horário do pagamento — política {status.paymentTimePolicy.mode === 'strict' ? 'ESTRITA (padrão): o webhook sozinho não confirma; vale a transação da Shopify ou a confirmação de um ADMIN' : `concordância do webhook (tolerância de ${status.paymentTimePolicy.toleranceSeconds} s)`}.
      </p>

      <div className="grid gap-3 sm:grid-cols-3" role="group" aria-label="Resumo das pendências">
        <div className="rounded-xl border border-ink/10 p-3 dark:border-white/10">
          <p className="text-xs text-ink/60 dark:text-dark-muted">Pagamentos retidos</p>
          <p className="text-lg font-semibold text-ink dark:text-dark-text">{status.heldPayments}</p>
          <p className={hintClass}>
            {status.heldUnits} unidade(s). Integração desligada: {status.byCause.integrationDisabled} · instante do pagamento desconhecido: {status.byCause.paymentTimeUnknown} · compra aumentou:{' '}
            {status.byCause.quantityIncreased} · valores divergentes: {status.byCause.financialMismatch} · limite/campanha: {status.byCause.capacityOrCampaign}
          </p>
        </div>
        <div className="rounded-xl border border-ink/10 p-3 dark:border-white/10">
          <p className="text-xs text-ink/60 dark:text-dark-muted">Unidades pagas sem tratamento</p>
          <p className="text-lg font-semibold text-ink dark:text-dark-text">{status.unitsWithoutTreatment}</p>
          <p className={hintClass}>{status.ordersWithoutTreatment.length} pedido(s) sem voucher e sem retenção (ex.: variante sem campanha).</p>
        </div>
        <div className="rounded-xl border border-ink/10 p-3 dark:border-white/10">
          <p className="text-xs text-ink/60 dark:text-dark-muted">E-mails aguardando envio</p>
          <p className="text-lg font-semibold text-ink dark:text-dark-text">{status.emails.awaitingSend}</p>
          <p className={hintClass}>
            Precisam de atenção: {status.emails.needsAttention} · resultado desconhecido: {status.emails.unknownResult}. Só registrados na fila: o envio segue desligado.
          </p>
        </div>
      </div>

      {status.paymentTimePending.length > 0 ? (
        <section aria-label="Horário do pagamento desconhecido">
          <h4 className="mb-2 text-xs font-semibold text-red-500">Horário do pagamento desconhecido ({status.paymentTimePending.length})</h4>
          <ul className="space-y-2">
            {status.paymentTimePending.map((candidate) => (
              <PaymentTimeRow key={candidate.orderId} candidate={candidate} canManage={canManage} onChanged={onChanged} />
            ))}
          </ul>
          <p className={hintClass}>
            Sem o horário real do pagamento o prazo de 3 dias não pode ser calculado e nada é emitido. &quot;Conferir na Shopify&quot; lê a transação financeira (somente leitura) e só confirma se ela concordar com o webhook;
            se divergir, confira o horário na Shopify e confirme manualmente. Depois de confirmar, use &quot;Retomar retenções&quot;.
          </p>
        </section>
      ) : null}

      {status.ordersWithoutTreatment.length > 0 ? (
        <section aria-label="Pedidos pagos sem tratamento">
          <h4 className="mb-2 text-xs font-semibold text-red-500">Pedidos pagos sem tratamento ({status.ordersWithoutTreatment.length})</h4>
          <ul className="space-y-2">
            {status.ordersWithoutTreatment.map((order) => (
              <UntreatedRow key={order.orderId} order={order} canManage={canManage} onChanged={onChanged} />
            ))}
          </ul>
          <p className={hintClass}>
            Regularizar revalida o pagamento (valor, moeda, quantidade, desconto, saldo) com o último evento da Shopify e só então emite o que falta; se algo não fecha, o pedido vai para a fila de
            retenções. Exige a emissão dos dois vouchers LIGADA e o instante real do pagamento.
          </p>
        </section>
      ) : null}
    </div>
  );
}

const formatDateTime = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

function OperationalCounters({ status }: { status: ValePassFlowStatus }) {
  const o = status.operational;
  const tone = o.severity === 'critical' ? 'border-red-500/40 bg-red-500/[0.07]' : o.severity === 'warning' ? 'border-amber-500/40 bg-amber-500/[0.07]' : 'border-emerald-500/30 bg-emerald-500/[0.06]';
  return (
    <div role="group" aria-label="Alertas operacionais" className={`rounded-xl border p-3 text-xs text-ink dark:text-dark-text ${tone}`} data-severity={o.severity}>
      <p className="font-semibold">
        {o.severity === 'ok' ? 'Nenhum pagamento confirmado sem benefício.' : o.severity === 'critical' ? 'CRÍTICO: há pagamento confirmado sem benefício fora do prazo (ou e-mail vencido).' : 'Atenção: há pagamento confirmado sem benefício.'}
      </p>
      <ul className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
        <li>Pagamentos confirmados sem benefício: <strong>{o.withoutBenefit.orders}</strong> pedido(s), {o.withoutBenefit.units} unidade(s)</li>
        <li>Entre 48 h e 72 h (faltam menos de 24 h): <strong>{o.nearDeadline.orders}</strong></li>
        <li>72 h ou mais (prazo de 3 dias vencido): <strong>{o.overdue.orders}</strong></li>
        <li>Horário do pagamento desconhecido: <strong>{o.paymentTimeUnknown.orders}</strong></li>
        <li>E-mails de voucher fora do prazo: <strong>{o.emailsOverdue.units}</strong></li>
        <li>Mais antigo: <strong>{o.oldestHours === null ? '—' : `${o.oldestHours} h`}</strong></li>
      </ul>
      <p className={hintClass}>O contador vermelho do menu e o aviso ativo (log/webhook, desligados por padrão) usam estes mesmos números; não dependem de abrir esta tela.</p>
    </div>
  );
}

function PaymentTimeRow({ candidate, canManage, onChanged }: { candidate: ValePassFlowStatus['paymentTimePending'][number]; canManage: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [local, setLocal] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function verify() {
    setPending(true);
    setError(null);
    const result = await verifyValePassPaymentTimeAction(candidate.orderId, note);
    setPending(false);
    if (result.error) return setError(result.error);
    setMessage(result.message ?? 'Conferido.');
    onChanged();
  }

  async function confirm() {
    setPending(true);
    setError(null);
    // O campo é horário de Brasília (sem horário de verão desde 2019): enviado com o fuso explícito.
    const withSeconds = /T\d{2}:\d{2}$/.test(local) ? `${local}:00` : local;
    const result = await confirmValePassPaymentTimeAction(candidate.orderId, local ? `${withSeconds}-03:00` : '', note);
    setPending(false);
    if (result.error) return setError(result.error);
    setMessage('Horário confirmado manualmente. Agora use "Retomar retenções".');
    onChanged();
  }

  return (
    <li className="rounded-lg border border-red-500/20 px-3 py-2 text-xs text-ink dark:text-dark-text">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          Pedido {candidate.orderName ?? candidate.orderId}: {candidate.quantity} unidade(s) · retido desde {formatDateTime(candidate.heldSince)}
          <span className="mt-0.5 block text-ink/60 dark:text-dark-muted">
            Webhook: {candidate.webhookTriggeredAt ? formatDateTime(candidate.webhookTriggeredAt) : 'sem sinal válido'}
            {candidate.webhookDeltaSeconds !== null ? ` (diferença entre os sinais: ${candidate.webhookDeltaSeconds} s)` : ''} · Transação da Shopify:{' '}
            {candidate.transactionInstant ? formatDateTime(candidate.transactionInstant) : candidate.transactionReason ? `não confirmou (${candidate.transactionReason})` : 'ainda não conferida'}
          </span>
        </span>
        {canManage ? (
          <button type="button" className={secondaryButton} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
            {open ? 'Fechar' : 'Resolver'}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-2 space-y-2">
          <textarea className={inputClass} rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Justificativa (mínimo de 10 caracteres)" />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={secondaryButton} disabled={pending || note.trim().length < 10} onClick={verify}>
              Conferir na Shopify
            </button>
            <label className="inline-flex items-center gap-1.5">
              <span>Ou informe o horário (Brasília):</span>
              <input type="datetime-local" className={`${inputClass} w-auto`} value={local} onChange={(event) => setLocal(event.target.value)} aria-label="Horário do pagamento (Brasília)" />
            </label>
            <button type="button" className={secondaryButton} disabled={pending || note.trim().length < 10 || !local} onClick={confirm}>
              Confirmar manualmente
            </button>
          </div>
          {error ? <p role="alert" className="text-red-500">{error}</p> : null}
          {message ? <p role="status">{message}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

function UntreatedRow({ order, canManage, onChanged }: { order: ValePassFlowStatus['ordersWithoutTreatment'][number]; canManage: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setError(null);
    const result = await regularizeValePassOrderAction(order.orderId, note);
    setPending(false);
    if (result.error) return setError(result.error);
    setMessage(result.message ?? 'Pedido avaliado.');
    setNote('');
    onChanged();
  }

  return (
    <li className="rounded-lg border border-red-500/20 px-3 py-2 text-xs text-ink dark:text-dark-text">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          Pedido {order.orderName ?? order.orderId}: {order.missing} unidade(s) sem voucher de {order.quantity} paga(s) · {KIND_LABELS[order.kind]}
        </span>
        {canManage ? (
          <button type="button" className={secondaryButton} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
            {open ? 'Fechar' : 'Regularizar'}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-2 space-y-2">
          <textarea className={inputClass} rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Justificativa (mínimo de 10 caracteres)" />
          <button type="button" className={secondaryButton} disabled={pending || note.trim().length < 10} onClick={run}>
            Regularizar agora
          </button>
          {error ? <p role="alert" className="text-red-500">{error}</p> : null}
          {message ? <p role="status">{message}</p> : null}
        </div>
      ) : null}
    </li>
  );
}
