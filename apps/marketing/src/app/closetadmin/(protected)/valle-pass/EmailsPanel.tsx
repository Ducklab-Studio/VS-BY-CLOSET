'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Mail, RefreshCw } from 'lucide-react';
import type { ValePassEmailItem, ValePassEmailStatus, ValePassEmailSummary } from '@/lib/admin-data';
import { loadValePassEmailEventsAction, loadValePassEmailsAction, resendValePassEmailAction } from './actions';

/**
 * Acompanhamento dos e-mails com os códigos do Valle Pass (ClosetAdmin).
 *
 * Mostra a fila, o que a Resend aceitou e entregou, falhas, tentativas e o prazo de 3 dias após o pagamento. E-mails e códigos chegam
 * MASCARADOS da API e assim ficam. Reenviar é ação sensível: só ADMIN, com justificativa e confirmação; a API revalida tudo e audita.
 * Nada aqui liga o envio — isso é decisão de configuração do servidor (VALE_PASS_EMAIL_MODE e credenciais).
 */

const secondaryButton =
  'inline-flex items-center gap-1.5 rounded-lg border border-ink/15 px-2.5 py-1.5 text-xs font-medium text-ink/75 transition hover:bg-ink/[0.04] disabled:opacity-50 dark:border-white/15 dark:text-dark-text dark:hover:bg-white/5';
const inputClass =
  'w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink outline-none transition focus:border-marsala focus:ring-2 focus:ring-marsala/20 dark:border-white/15 dark:bg-dark-surface dark:text-dark-text dark:focus:border-gold dark:focus:ring-gold/20';
const hintClass = 'mt-1 text-[0.7rem] leading-snug text-ink/45 dark:text-dark-subtle';

const STATUS_LABELS: Record<ValePassEmailStatus, string> = {
  QUEUED: 'Na fila',
  SENDING: 'Enviando',
  UNKNOWN: 'Resultado desconhecido',
  ACCEPTED: 'Aceito pela Resend',
  DELIVERED: 'Entregue',
  FAILED: 'Falhou',
  NEEDS_ATTENTION: 'Precisa de atenção',
  CANCELLED: 'Cancelado',
};
const STATUS_STYLES: Record<ValePassEmailStatus, string> = {
  QUEUED: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
  SENDING: 'bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300',
  UNKNOWN: 'bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300',
  ACCEPTED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
  DELIVERED: 'bg-emerald-200 text-emerald-900 dark:bg-emerald-900/60 dark:text-emerald-200',
  FAILED: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
  NEEDS_ATTENTION: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
  CANCELLED: 'bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400',
};
const ALERT_STYLES = {
  critical: 'border-red-500/30 bg-red-500/[0.08] text-red-500',
  warning: 'border-amber-500/30 bg-amber-500/[0.08] text-amber-600 dark:text-amber-400',
  info: 'border-sky-500/25 bg-sky-500/[0.07] text-sky-700 dark:text-sky-300',
} as const;
const MODE_LABELS = { off: 'Desligado', 'dry-run': 'Teste (não envia)', live: 'Ativo' } as const;
const FILTERS: readonly (ValePassEmailStatus | 'ALL')[] = ['ALL', 'QUEUED', 'UNKNOWN', 'ACCEPTED', 'DELIVERED', 'FAILED', 'NEEDS_ATTENTION', 'CANCELLED'];
/** Em andamento: a API recusa reenviar enquanto a mensagem está na fila ou sendo enviada. */
const RESENDABLE: readonly ValePassEmailStatus[] = ['ACCEPTED', 'DELIVERED', 'FAILED', 'NEEDS_ATTENTION'];

const formatDateTime = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function EmailsPanel({ canManage }: { canManage: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<ValePassEmailStatus | 'ALL'>('ALL');
  const [summary, setSummary] = useState<ValePassEmailSummary | null>(null);
  const [items, setItems] = useState<ValePassEmailItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await loadValePassEmailsAction(filter === 'ALL' ? undefined : filter);
    setLoading(false);
    setError(result.error);
    if (!result.error) {
      setSummary(result.summary);
      setItems(result.items);
    }
  }, [filter]);

  useEffect(() => {
    if (expanded) void refresh();
  }, [expanded, refresh]);

  const needsEyes = (summary?.alerts ?? []).some((alert) => alert.severity === 'critical');

  return (
    <section className="space-y-4" aria-label="E-mails dos vouchers">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-2">
          <Mail size={18} className="text-marsala dark:text-gold" />
          <h2 className="font-heading text-lg font-semibold text-ink dark:text-dark-text">E-mails dos vouchers</h2>
          {needsEyes ? <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[0.7rem] font-semibold text-red-500">atenção</span> : null}
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
          {summary ? <SummaryView summary={summary} /> : loading ? <p className="text-xs text-ink/45 dark:text-dark-subtle">Carregando…</p> : null}

          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                aria-pressed={filter === value}
                className={`rounded-full border px-2.5 py-1 text-xs ${filter === value ? 'border-marsala bg-marsala/10 font-semibold text-marsala dark:border-gold dark:bg-gold/10 dark:text-gold' : 'border-ink/15 text-ink/60 dark:border-white/15 dark:text-dark-muted'}`}
              >
                {value === 'ALL' ? 'Todos' : STATUS_LABELS[value]}
                {summary && value !== 'ALL' ? ` (${summary.counts[value]})` : ''}
              </button>
            ))}
            <button type="button" className={secondaryButton} onClick={() => void refresh()} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Atualizar
            </button>
          </div>

          {items.length === 0 && !loading ? (
            <p className="text-xs text-ink/55 dark:text-dark-muted">Nenhum e-mail neste filtro. Enquanto a emissão dos dois vouchers não estiver ligada ao pagamento, esta lista fica vazia.</p>
          ) : (
            <ul className="space-y-2">
              {items.map((item) => (
                <EmailRow key={item.id} item={item} canManage={canManage} onChanged={() => void refresh()} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

function SummaryView({ summary }: { summary: ValePassEmailSummary }) {
  const { config } = summary;
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-ink dark:text-dark-text sm:grid-cols-4">
        <div>
          <dt className="text-ink/50 dark:text-dark-subtle">Envio</dt>
          <dd className="font-semibold">{MODE_LABELS[config.mode]}</dd>
        </div>
        <div>
          <dt className="text-ink/50 dark:text-dark-subtle">Resend</dt>
          <dd className="font-semibold">{config.providerConfigured ? 'chave configurada' : 'sem chave'} · {config.domainVerified ? 'domínio verificado' : 'domínio não verificado'}</dd>
        </div>
        <div>
          <dt className="text-ink/50 dark:text-dark-subtle">Últimas 24 h</dt>
          <dd className="font-semibold">
            {summary.acceptedLast24h} de {summary.dailyLimit} envios
          </dd>
        </div>
        <div>
          <dt className="text-ink/50 dark:text-dark-subtle">Prazo de 3 dias</dt>
          <dd className="font-semibold">
            {summary.overdue} vencido(s) · {summary.atRisk} em risco
          </dd>
        </div>
      </dl>
      {!config.canSend ? (
        <p className={hintClass}>
          Envio real bloqueado: {config.blockers.join('; ')}. Isso é configurado no servidor, não aqui.
        </p>
      ) : null}
      {summary.alerts.length > 0 ? (
        <ul className="space-y-1.5" aria-label="Alertas dos e-mails">
          {summary.alerts.map((alert) => (
            <li key={alert.code} role={alert.severity === 'critical' ? 'alert' : undefined} className={`rounded-lg border px-3 py-2 text-xs ${ALERT_STYLES[alert.severity]}`}>
              {alert.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function EmailRow({ item, canManage, onChanged }: { item: ValePassEmailItem; canManage: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<{ type: string; createdAt: string }[] | null>(null);
  const [resending, setResending] = useState(false);
  const [note, setNote] = useState('');
  const [toEmail, setToEmail] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function toggleHistory() {
    const next = !open;
    setOpen(next);
    if (next && events === null) {
      const result = await loadValePassEmailEventsAction(item.id);
      setEvents(result.events);
      if (result.error) setError(result.error);
    }
  }

  async function resend() {
    setPending(true);
    setError(null);
    const result = await resendValePassEmailAction(item.id, { note, toEmail });
    setPending(false);
    if (result.error) return setError(result.error);
    setNotice(result.mayDuplicate ? 'Reenvio registrado. Atenção: como o resultado da mensagem original era desconhecido, o cliente pode receber duas mensagens.' : 'Reenvio registrado e auditado. Ele sai na próxima rodada do envio, se o envio estiver ativo.');
    setResending(false);
    setNote('');
    setToEmail('');
    setConfirmed(false);
    onChanged();
  }

  const canResend = canManage && RESENDABLE.includes(item.status) && item.status !== 'CANCELLED';

  return (
    <li className={`rounded-lg border px-3 py-2.5 text-xs text-ink dark:text-dark-text ${item.overdue ? 'border-red-500/40' : 'border-ink/10 dark:border-white/10'}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="font-semibold">
            Pedido {item.orderName ?? item.orderId} · {item.toMasked}
            {item.kind === 'RESEND' ? ' · reenvio' : ''}
          </p>
          <p className="break-words font-mono text-[0.7rem] text-ink/55 dark:text-dark-muted">{item.codesMasked.join(' · ') || '—'}</p>
          <p className="text-ink/55 dark:text-dark-muted">
            Criado em {formatDateTime(item.createdAt)} · prazo {formatDateTime(item.deadlineAt)}
            {item.overdue ? ' · PRAZO VENCIDO' : ''}
          </p>
          {item.acceptedAt ? <p className="text-ink/55 dark:text-dark-muted">Aceito pela Resend em {formatDateTime(item.acceptedAt)}{item.deliveredAt ? ` · entregue em ${formatDateTime(item.deliveredAt)}` : ''}</p> : null}
          {item.status === 'QUEUED' || item.status === 'UNKNOWN' ? <p className="text-ink/55 dark:text-dark-muted">Próxima tentativa: {formatDateTime(item.nextAttemptAt)}</p> : null}
          <p className="text-ink/55 dark:text-dark-muted">
            Tentativas: {item.attempts} de {item.maxAttempts}
            {item.lastError ? ` · último problema: ${item.lastError}` : ''}
          </p>
        </div>
        <span className={`inline-flex shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[item.status]}`}>{STATUS_LABELS[item.status]}</span>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={secondaryButton} onClick={() => void toggleHistory()} aria-expanded={open}>
          {open ? 'Ocultar histórico' : 'Ver histórico'}
        </button>
        {canResend ? (
          <button type="button" className={secondaryButton} onClick={() => setResending((value) => !value)} aria-expanded={resending}>
            Reenviar
          </button>
        ) : null}
      </div>

      {notice ? <p className="mt-2 text-emerald-600 dark:text-emerald-400">{notice}</p> : null}
      {open ? (
        <ol className="mt-2 space-y-0.5 border-l border-ink/10 pl-3 dark:border-white/10" aria-label="Histórico da mensagem">
          {events === null ? <li>Carregando…</li> : events.map((event, index) => (
            <li key={`${event.type}-${index}`}>
              {formatDateTime(event.createdAt)} — {event.type}
            </li>
          ))}
        </ol>
      ) : null}

      {resending ? (
        <div className="mt-2 space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3">
          <p>
            Reenviar os códigos deste pedido ao cliente. Só é possível se o pedido continuar pago e a unidade completa; a API confere de novo. Fica
            registrado na auditoria com a sua justificativa.
          </p>
          <label className="block font-medium text-ink/60 dark:text-dark-muted">
            Justificativa (mínimo de 10 caracteres)
            <input className={`${inputClass} mt-1`} value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
          </label>
          <label className="block font-medium text-ink/60 dark:text-dark-muted">
            E-mail corrigido do cliente (opcional)
            <input className={`${inputClass} mt-1`} type="email" value={toEmail} onChange={(event) => setToEmail(event.target.value)} maxLength={320} />
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-0.5" />
            <span>Confirmo que quero reenviar os códigos deste pedido{toEmail.trim() ? ' para o novo endereço' : ''}.</span>
          </label>
          {error ? (
            <p role="alert" className="text-red-500">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={secondaryButton} disabled={pending || !confirmed || note.trim().length < 10} onClick={() => void resend()}>
              Confirmar reenvio
            </button>
            <button type="button" className={secondaryButton} disabled={pending} onClick={() => setResending(false)}>
              Cancelar
            </button>
          </div>
        </div>
      ) : error && !resending ? (
        <p role="alert" className="mt-2 text-red-500">
          {error}
        </p>
      ) : null}
    </li>
  );
}
