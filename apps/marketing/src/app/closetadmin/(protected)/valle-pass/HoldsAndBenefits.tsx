'use client';

import { useState } from 'react';
import type { ValePassCapacityCancellationAlert, ValePassCapacityRefundReview, ValePassBenefitInput, ValePassCapacityBenefit, ValePassCapacityHold, ValePassHoldProjection } from '@/lib/admin-data';
import { formatCents } from '@/lib/valle-pass-balance';
import { acknowledgeValePassCancellationAlertAction, resumeHeldPaymentsAction, resolveValePassRefundReviewAction, issueValePassHoldAction, previewValePassHoldAction, replaceValePassBenefitsAction, resolveValePassHoldAction } from './actions';

/**
 * Valle Pass 2027 — fila de pagamentos retidos e benefícios da campanha (ClosetAdmin).
 *
 * Retenção = pagamento CONFIRMADO que a emissão automática não atendeu (limite global esgotado ou campanha sem validade). A
 * unidade continua contando como consumida. Só ADMIN resolve, com justificativa (auditada): "Emitir" aprova um excedente
 * consciente; "Descartar" só vale depois de o pedido ter sido reembolsado/cancelado na Shopify. Nada aqui reembolsa ou cancela.
 */

const inputClass =
  'w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink outline-none transition focus:border-marsala focus:ring-2 focus:ring-marsala/20 dark:border-white/15 dark:bg-dark-surface dark:text-dark-text dark:focus:border-gold dark:focus:ring-gold/20';
const secondaryButton =
  'inline-flex items-center gap-1.5 rounded-lg border border-ink/15 px-2.5 py-1.5 text-xs font-medium text-ink/75 transition hover:bg-ink/[0.04] disabled:opacity-50 dark:border-white/15 dark:text-dark-text dark:hover:bg-white/5';
const hintClass = 'mt-1 text-[0.7rem] leading-snug text-ink/45 dark:text-dark-subtle';

const REASON_LABELS: Record<ValePassCapacityHold['reason'], string> = {
  CAPACITY_EXCEEDED: 'Limite global esgotado',
  CAMPAIGN_NOT_READY: 'Campanha sem validade/benefícios prontos',
  FINANCIAL_MISMATCH: 'Valor, moeda, quantidade ou desconto fora do esperado',
};
/** Divergências financeiras em português claro (os códigos vêm da API; nada além deles). */
const ISSUE_LABELS: Record<string, string> = {
  FINANCIALS_UNDEFINED: 'sem dados financeiros do pedido',
  NOT_FULLY_PAID: 'pagamento não está integral',
  ORDER_CANCELLED: 'pedido cancelado',
  OUTSTANDING_BALANCE: 'saldo em aberto',
  OUTSTANDING_UNDEFINED: 'saldo em aberto indefinido',
  CURRENCY_MISMATCH: 'moeda diferente de BRL',
  CURRENCY_UNDEFINED: 'moeda indefinida',
  NO_VALLE_PASS_LINE: 'sem linha de Valle Pass',
  MIXED_CART: 'carrinho misto',
  UNKNOWN_VALE_PASS_VARIANT: 'variante sem preço configurado',
  PRICE_UNDEFINED: 'preço indefinido',
  PRICE_MISMATCH: 'preço diferente do configurado',
  DISCOUNT_PRESENT: 'desconto aplicado',
  DISCOUNT_UNDEFINED: 'desconto indefinido',
  QUANTITY_INVALID: 'quantidade inválida',
  QUANTITY_UNDEFINED: 'quantidade indefinida',
  QUANTITY_OUT_OF_RANGE: 'quantidade acima do teto',
  QUANTITY_CHANGED: 'unidades removidas ou reembolsadas',
  REFUND_PRESENT: 'há reembolso',
  EXTRA_CHARGES: 'frete ou cobrança extra',
  TOTAL_UNDEFINED: 'total indefinido',
  TOTAL_MISMATCH: 'total pago diferente do esperado',
  REFUND_PENDING_REVIEW: 'reembolso aguardando decisão de um administrador',
  INTEGRATION_DISABLED: 'o pagamento chegou com a integração dos dois vouchers desligada',
  PAYMENT_TIME_UNKNOWN: 'instante real do pagamento desconhecido (prazo de 3 dias não calculável)',
  QUANTITY_INCREASED: 'a compra aumentou depois da emissão (unidades pagas sem voucher)',
  TEST_ORDER: 'pedido de TESTE da Shopify (nunca emite voucher comercial)',
  MANUAL_PAYMENT: 'pagamento marcado manualmente na Shopify (revisão do administrador)',
  ORDER_NOT_REGISTERED: 'pedido ainda não registrado',
  MULTIPLE_CAMPAIGNS: 'mais de uma campanha no mesmo pedido',
};
const COMPANY_LABELS = { VALLE_SHOWROOM: 'Valle Showroom', VS_BY_CLOSET: 'VS BY CLOSET' } as const;
const formatCurrency = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const formatDateTime = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function HoldsPanel({ holds, canManage, onChanged }: { holds: readonly ValePassCapacityHold[]; canManage: boolean; onChanged: () => void }) {
  return (
    <section aria-label="Pagamentos retidos">
      <h4 className="mb-2 text-xs font-semibold text-red-500">Pagamentos confirmados aguardando resolução ({holds.length})</h4>
      {canManage && holds.some((hold) => ['INTEGRATION_DISABLED', 'PAYMENT_TIME_UNKNOWN', 'QUANTITY_INCREASED'].some((code) => hold.issues.includes(code))) ? <ResumeHeldPayments onChanged={onChanged} /> : null}
      <ul className="space-y-2">
        {holds.map((hold) => (
          <HoldRow key={hold.id} hold={hold} canManage={canManage} onChanged={onChanged} />
        ))}
      </ul>
      <p className={hintClass}>
        A unidade retida continua contando como vendida. &quot;Emitir&quot; cria os vouchers acima do limite (decisão consciente);
        &quot;Descartar&quot; só é aceito depois que o pedido for reembolsado ou cancelado na Shopify. Nenhuma das duas ações mexe no pagamento.
      </p>
    </section>
  );
}

const MIN_ISSUE_NOTE = 10;

function HoldRow({ hold, canManage, onChanged }: { hold: ValePassCapacityHold; canManage: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [typed, setTyped] = useState('');
  const [projection, setProjection] = useState<ValePassHoldProjection | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openPanel() {
    if (open) return setOpen(false);
    setOpen(true);
    await loadProjection();
  }

  /** Busca os números ATUAIS. Chamado ao abrir e sempre que o servidor disser que algo mudou (nova confirmação). */
  async function loadProjection() {
    setError(null);
    setTyped('');
    const result = await previewValePassHoldAction(hold.id);
    setProjection(result.projection);
    if (result.error) setError(result.error);
  }

  async function dismiss() {
    setPending(true);
    setError(null);
    const result = await resolveValePassHoldAction(hold.id, 'dismiss', note);
    setPending(false);
    if (result.error) return setError(result.error);
    setOpen(false);
    setNote('');
    onChanged();
  }

  async function issue() {
    if (!projection) return;
    setPending(true);
    setError(null);
    const result = await issueValePassHoldAction(hold.id, {
      note,
      confirmTotal: Number(typed),
      expected: { projectedTotal: projection.projectedTotal, consumedTotal: projection.consumedBefore, globalLimit: projection.globalLimit, holdUpdatedAt: projection.holdUpdatedAt },
    });
    if (result.error) {
      const message = result.error;
      if (/mudou desde que|divergiu/.test(message)) {
        await loadProjection(); // números novos na tela; a pessoa precisa digitar de novo (a recarga limpa a mensagem, então ela volta depois)
        setError(`${message} Os números abaixo já foram atualizados.`);
      } else {
        setError(message);
      }
      setPending(false);
      return;
    }
    setPending(false);
    setOpen(false);
    setNote('');
    setTyped('');
    onChanged();
  }

  const typedOk = projection !== null && typed.trim() !== '' && Number(typed) === projection.projectedTotal;
  const noteOk = note.trim().length >= MIN_ISSUE_NOTE;

  return (
    <li className="rounded-lg border border-red-500/20 px-3 py-2 text-xs text-ink dark:text-dark-text">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          Pedido {hold.shopifyOrderName ?? hold.shopifyOrderId}: {hold.units} unidade(s) · {REASON_LABELS[hold.reason]} · retido em {formatDateTime(hold.createdAt)} · {hold.paymentConfirmedAt ? `pago em ${formatDateTime(hold.paymentConfirmedAt)} (prazo de 3 dias conta daqui)` : 'instante do pagamento DESCONHECIDO'}
          {hold.reason === 'FINANCIAL_MISMATCH' && hold.issues.length > 0 ? (
            <span className="mt-0.5 block text-ink/60 dark:text-dark-muted">Divergências: {hold.issues.map((code) => ISSUE_LABELS[code] ?? code).join('; ')}.</span>
          ) : null}
        </span>
        {canManage ? (
          <button type="button" className={secondaryButton} onClick={() => void openPanel()} aria-expanded={open}>
            Resolver
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-2 space-y-2">
          {projection ? (
            <div className="space-y-1.5 rounded-lg border border-ink/10 bg-ink/[0.03] p-3 dark:border-white/10 dark:bg-white/[0.03]" aria-label="Confirmação da emissão excepcional">
              <p className="font-semibold">Confirmação da emissão excepcional</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                <dt>Limite global</dt>
                <dd>{projection.globalLimit === null ? 'sem limite' : projection.globalLimit}</dd>
                <dt>Consumido hoje</dt>
                <dd>
                  {projection.consumedBefore} ({projection.soldBefore} vendidos + {projection.pendingBefore} pagos aguardando)
                </dd>
                <dt>Total projetado depois</dt>
                <dd>
                  <strong>{projection.projectedTotal}</strong> ({projection.soldAfter} vendidos + {projection.pendingAfter} aguardando)
                </dd>
              </dl>
              {projection.exceedsLimit ? (
                <p role="alert" className="rounded border border-red-500/30 bg-red-500/[0.08] px-2 py-1.5 font-medium text-red-500">
                  Atenção: esta emissão ultrapassa o limite autorizado em {projection.exceededBy} unidade(s) ({projection.projectedTotal} de {projection.globalLimit}). A venda continua
                  bloqueada para novos clientes, mas este excedente fica registrado e auditado.
                </p>
              ) : (
                <p className={hintClass}>O total projetado não ultrapassa o limite atual.</p>
              )}
              {!projection.canIssue ? (
                <p role="alert" className="text-red-500">
                  {projection.blockedReason}
                </p>
              ) : null}
            </div>
          ) : null}
          <label className="block text-xs font-medium text-ink/60 dark:text-dark-muted">
            Justificativa (mínimo de {MIN_ISSUE_NOTE} caracteres; fica registrada na auditoria)
            <input className={`${inputClass} mt-1`} value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
          </label>
          <label className="block text-xs font-medium text-ink/60 dark:text-dark-muted">
            {projection ? `Para emitir, digite o total projetado (${projection.projectedTotal})` : 'Total projetado'}
            <input className={`${inputClass} mt-1`} inputMode="numeric" value={typed} onChange={(event) => setTyped(event.target.value.replace(/[^0-9]/g, ''))} maxLength={7} />
          </label>
          {error ? (
            <p role="alert" className="text-xs text-red-500">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={secondaryButton} disabled={pending || !projection?.canIssue || !typedOk || !noteOk} onClick={() => void issue()}>
              Emitir (excedente aprovado)
            </button>
            <button type="button" className={secondaryButton} disabled={pending || note.trim().length < 3} onClick={() => void dismiss()}>
              Descartar (pedido não está mais pago)
            </button>
            <button type="button" className={secondaryButton} disabled={pending} onClick={() => void loadProjection()}>
              Atualizar números
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** Modelo comercial do Valle Pass 2027. É só uma SUGESTÃO: nada é salvo até o ADMIN confirmar. As condições do desconto de 10% ainda estão pendentes. */
const VALLE_PASS_2027_PRESET: readonly ValePassBenefitInput[] = [
  { code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 },
  { code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 },
  { code: 'desconto_passeios', kind: 'DISCOUNT', label: '10% de desconto em passeios elegíveis', discountPercent: 10, terms: 'Condições a definir. Direito comercial: não gera desconto automático.', sortOrder: 2 },
];

export function BenefitsPanel({ campaignId, benefits, canManage, onChanged }: { campaignId: string; benefits: readonly ValePassCapacityBenefit[]; canManage: boolean; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setPending(true);
    setError(null);
    const result = await replaceValePassBenefitsAction(campaignId, VALLE_PASS_2027_PRESET);
    setPending(false);
    if (result.error) return setError(result.error);
    setConfirming(false);
    onChanged();
  }

  return (
    <section aria-label="Benefícios do Valle Pass">
      <h4 className="mb-2 text-xs font-semibold text-marsala dark:text-gold">Benefícios por unidade comprada</h4>
      {benefits.length === 0 ? (
        <p className="text-xs text-ink/55 dark:text-dark-muted">Nenhum benefício cadastrado: esta campanha segue o modelo antigo (um voucher por passe).</p>
      ) : (
        <ul className="space-y-1.5">
          {benefits.map((benefit) => (
            <li key={benefit.code} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink/10 px-3 py-2 text-xs text-ink dark:border-white/10 dark:text-dark-text">
              <span>
                {benefit.label}
                {benefit.kind === 'VOUCHER' && benefit.company && benefit.amountCents !== null
                  ? ` · ${formatCurrency(benefit.amountCents)} · exclusivo ${COMPANY_LABELS[benefit.company]}`
                  : benefit.discountPercent !== null
                    ? ` · ${benefit.discountPercent}% (direito comercial, sem código nem saldo)`
                    : ''}
              </span>
              <span className="text-ink/50 dark:text-dark-subtle">
                {benefit.active ? 'ativo' : 'inativo'} · {benefit.vouchersIssued} emitido(s)
              </span>
            </li>
          ))}
        </ul>
      )}
      {canManage && benefits.length === 0 ? (
        confirming ? (
          <div className="mt-2 space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3 text-xs text-ink dark:text-dark-text">
            <p>
              Cadastrar o modelo Valle Pass 2027 (voucher R$ 500 Valle Showroom + voucher R$ 50 VS BY CLOSET + 10% em passeios)? Isto só registra a
              configuração; a emissão dos dois vouchers só passa a valer quando a ligação ao pagamento for autorizada.
            </p>
            {error ? (
              <p role="alert" className="text-red-500">
                {error}
              </p>
            ) : null}
            <div className="flex gap-2">
              <button type="button" className={secondaryButton} disabled={pending} onClick={() => void save()}>
                Confirmar cadastro
              </button>
              <button type="button" className={secondaryButton} disabled={pending} onClick={() => setConfirming(false)}>
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className={`${secondaryButton} mt-2`} onClick={() => setConfirming(true)}>
            Sugerir modelo Valle Pass 2027
          </button>
        )
      ) : null}
      <p className={hintClass}>Empresa e valor de um voucher não mudam depois da primeira emissão. Cada empresa tem saldo próprio: um voucher nunca vale na outra empresa.</p>
    </section>
  );
}

const REFUND_REASON_LABELS: Record<string, string> = {
  USED_VOUCHERS: 'voucher já usado em unidade reembolsada',
  UNIT_CONFIRMATION_REQUIRED: 'a Shopify não diz qual unidade foi devolvida: confirme a proposta (os vouchers propostos estão bloqueados para resgate)',
  AMOUNT_MISMATCH: 'valor devolvido não fecha com o preço',
  AMOUNT_ONLY_REFUND: 'dinheiro devolvido sem unidade identificada: o resgate de TODOS os vouchers deste pedido está bloqueado até a decisão',
  QUANTITY_EXCEEDS_UNITS: 'mais unidades devolvidas que as existentes',
  PAID_UNITS_EXCEEDED: 'devoluções acima das unidades pagas',
  PRICE_UNKNOWN: 'variante sem preço configurado',
  REFUND_UNDEFINED: 'dados do reembolso incompletos',
  TRANSACTION_UNDEFINED: 'valor da transação ilegível',
};

/** Reembolsos em revisão: a API já cancelou o que era seguro; aqui o ADMIN decide o resto. Voucher usado nunca é alterado. */
const COMPANY_NAMES: Record<string, string> = { VALLE_SHOWROOM: 'Valle Showroom', VS_BY_CLOSET: 'VS BY CLOSET', LEGACY: 'Voucher único (legado)' };

/**
 * Pedidos CANCELADOS/REEMBOLSADOS cujo crédito já tinha sido utilizado. Só informa: os vouchers não utilizados já foram cancelados pela regra de sempre e nada foi alterado em
 * saldos nem no histórico. O ADMIN confere o reembolso/conciliação com o financeiro e marca como conferido (justificativa + auditoria). Sem código de voucher e sem dado pessoal.
 */
export function CancellationAlertsPanel({ alerts, canManage, onChanged }: { alerts: readonly ValePassCapacityCancellationAlert[]; canManage: boolean; onChanged: () => void }) {
  return (
    <section aria-label="Cancelamentos com crédito utilizado">
      <h4 className="mb-2 text-xs font-semibold text-red-500">Pedidos cancelados/reembolsados com crédito já utilizado ({alerts.length})</h4>
      <ul className="space-y-2">
        {alerts.map((alert) => (
          <CancellationAlertRow key={alert.id} alert={alert} canManage={canManage} onChanged={onChanged} />
        ))}
      </ul>
      <p className={hintClass}>
        Confira o reembolso feito na Shopify (ou, se foi feito fora dela, a conciliação com o financeiro) levando em conta o crédito já consumido. Marcar como conferido não altera saldos, vouchers nem o reembolso.
      </p>
    </section>
  );
}

function CancellationAlertRow({ alert, canManage, onChanged }: { alert: ValePassCapacityCancellationAlert; canManage: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function acknowledge() {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await acknowledgeValePassCancellationAlertAction(alert.id, note);
    setPending(false);
    if (result.error) return setError(result.error);
    setNote('');
    setOpen(false);
    onChanged();
  }

  return (
    <li className="rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-xs text-ink dark:text-dark-text" data-testid="cancellation-alert-row">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <strong>{alert.orderName ?? 'Pedido'}</strong> · <span title="Identificador interno do pedido na Shopify">ref. {alert.shopifyOrderId}</span> · {alert.topic} · {formatDateTime(alert.createdAt)} · <strong>{formatCents(alert.usedCents)} já utilizados</strong>
        </span>
        {canManage ? (
          <button type="button" className={secondaryButton} onClick={() => setOpen((value) => !value)}>
            {open ? 'Fechar' : 'Conferir'}
          </button>
        ) : null}
      </div>
      <ul className="mt-1.5 space-y-0.5 text-[0.72rem] text-ink/70 dark:text-dark-subtle">
        {alert.lines.map((line) => (
          <li key={line.company}>
            {COMPANY_NAMES[line.company] ?? line.company}: emitido {formatCents(line.amountCents)} · utilizado {formatCents(line.usedCents)} · saldo {formatCents(line.balanceCents)}
          </li>
        ))}
      </ul>
      {open ? (
        <div className="mt-2 space-y-2">
          <textarea className={inputClass} rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Justificativa da conferência (mínimo de 10 caracteres)" />
          <button type="button" className={secondaryButton} disabled={pending || note.trim().length < 10} onClick={() => void acknowledge()}>
            {pending ? 'Registrando…' : 'Marcar como conferido'}
          </button>
          {error ? <p role="alert" className="text-red-500">{error}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

export function RefundReviewsPanel({ reviews, canManage, onChanged }: { reviews: readonly ValePassCapacityRefundReview[]; canManage: boolean; onChanged: () => void }) {
  return (
    <section aria-label="Reembolsos em revisão">
      <h4 className="mb-2 text-xs font-semibold text-red-500">Reembolsos aguardando decisão ({reviews.length})</h4>
      <ul className="space-y-2">
        {reviews.map((review) => (
          <RefundReviewRow key={review.id} review={review} canManage={canManage} onChanged={onChanged} />
        ))}
      </ul>
      <p className={hintClass}>
        &quot;Manter&quot; não altera nenhum voucher. &quot;Cancelar ativos&quot; cancela só os vouchers ainda ativos das unidades propostas; um voucher já usado nunca é desfeito.
      </p>
    </section>
  );
}

function RefundReviewRow({ review, canManage, onChanged }: { review: ValePassCapacityRefundReview; canManage: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function decide(action: 'KEEP_VOUCHERS' | 'CANCEL_ACTIVE_VOUCHERS') {
    setPending(true);
    setError(null);
    const result = await resolveValePassRefundReviewAction(review.id, action, note);
    setPending(false);
    if (result.error) return setError(result.error);
    setNote('');
    if (result.notice) return setNotice(result.notice); // fica na tela até a pessoa confirmar que leu
    setOpen(false);
    onChanged();
  }

  if (notice) {
    return (
      <li role="status" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-ink dark:text-dark-text">
        <p className="font-semibold">{review.shopifyOrderName ?? 'Pedido'}: atenção operacional</p>
        <p className="mt-1">{notice}</p>
        <button type="button" className={`${secondaryButton} mt-2`} onClick={onChanged}>Entendi</button>
      </li>
    );
  }

  return (
    <li className="rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-xs text-ink dark:text-dark-text">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <strong>{review.shopifyOrderName ?? 'Pedido'}</strong> · {review.refundedUnits} unidade(s) devolvida(s), {review.unitsNeedingReview} sem tratamento automático · {formatDateTime(review.createdAt)}
        </span>
        {canManage ? (
          <button type="button" className={secondaryButton} onClick={() => setOpen((value) => !value)}>
            {open ? 'Fechar' : 'Decidir'}
          </button>
        ) : null}
      </div>
      <p className={hintClass}>{review.reasons.map((reason) => REFUND_REASON_LABELS[reason] ?? reason).join('; ')}</p>
      {open ? (
        <div className="mt-2 space-y-2">
          <textarea className={inputClass} rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Justificativa (mínimo de 10 caracteres)" />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={secondaryButton} disabled={pending} onClick={() => decide('KEEP_VOUCHERS')}>Manter vouchers</button>
            <button type="button" className={secondaryButton} disabled={pending} onClick={() => decide('CANCEL_ACTIVE_VOUCHERS')}>Cancelar ativos</button>
          </div>
          {error ? <p role="alert" className="text-red-500">{error}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

/** Retomada em lote das retenções feitas com a integração desligada. Só funciona com a integração ligada no servidor; a API recusa com explicação se não estiver. */
function ResumeHeldPayments({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setError(null);
    const result = await resumeHeldPaymentsAction(note);
    setPending(false);
    if (result.error || !result.report) return setError(result.error ?? 'Não foi possível retomar.');
    const { issued, reclassified, skipped } = result.report;
    setMessage(`Retomada concluída: ${issued} emitido(s), ${reclassified} ainda retido(s) com os motivos reais, ${skipped.length} pulado(s).`);
    setNote('');
    onChanged();
  }

  return (
    <div role="group" aria-label="Retomada das retenções" className="mb-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-ink dark:text-dark-text">
      <p>Há pagamentos retidos que a retomada pode reprocessar (integração desligada na hora do pagamento, instante do pagamento que chegou depois ou compra que aumentou). Depois de LIGAR a integração, retome-os aqui (mais antigos primeiro, em lotes; cada pedido é revalidado).</p>
      <button type="button" className={`${secondaryButton} mt-2`} onClick={() => setOpen((value) => !value)}>
        {open ? 'Fechar' : 'Retomar retenções'}
      </button>
      {open ? (
        <div className="mt-2 space-y-2">
          <textarea className={inputClass} rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Justificativa (mínimo de 10 caracteres)" />
          <button type="button" className={secondaryButton} disabled={pending} onClick={run}>Retomar agora</button>
          {error ? <p role="alert" className="text-red-500">{error}</p> : null}
          {message ? <p role="status">{message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
