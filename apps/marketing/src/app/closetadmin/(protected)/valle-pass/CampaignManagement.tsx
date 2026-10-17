'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Layers, Pencil, Plus, RefreshCw } from 'lucide-react';
import type { ValePassCampaign, ValePassCapacity, ValePassCapacityAlert, ValePassLot, ValePassLotAction, ValePassLotStatus } from '@/lib/admin-data';
import { ConfirmDialog } from '@/components/closetadmin/ConfirmDialog';
import {
  actOnValePassLotAction,
  createValePassLotAction,
  getValePassCapacityAction,
  updateValePassCampaignAction,
  updateValePassLotAction,
} from './actions';

/**
 * Capacidade, lotes e edição da campanha do Valle Pass (ClosetAdmin).
 *
 * O painel é um registro de CONTROLE: abrir/encerrar lote e o limite global NÃO alteram a Shopify nem a emissão de vales
 * nesta versão. O bloqueio real da venda continua sendo o estoque da variante na Shopify — por isso o painel mostra o
 * número recomendado para a equipe ajustar à mão. Quem não é ADMIN vê tudo, mas sem botões de escrita.
 */

const inputClass =
  'w-full rounded-lg border border-ink/15 bg-white px-3 py-2.5 text-sm text-ink outline-none transition focus:border-marsala focus:ring-2 focus:ring-marsala/20 dark:border-white/15 dark:bg-dark-surface dark:text-dark-text dark:focus:border-gold dark:focus:ring-gold/20';
const labelClass = 'text-xs font-medium text-ink/60 dark:text-dark-muted';
const hintClass = 'mt-1 text-[0.7rem] leading-snug text-ink/45 dark:text-dark-subtle';
const secondaryButton =
  'inline-flex items-center gap-1.5 rounded-lg border border-ink/15 px-2.5 py-1.5 text-xs font-medium text-ink/75 transition hover:bg-ink/[0.04] disabled:opacity-50 dark:border-white/15 dark:text-dark-text dark:hover:bg-white/5';
const primaryButton =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-marsala px-3.5 py-2 text-sm font-medium text-cream shadow-sm transition hover:bg-marsala/90 disabled:opacity-50 dark:bg-marsala-light dark:text-sand dark:hover:bg-marsala-glow';

const LOT_STATUS_LABELS: Record<ValePassLotStatus, string> = { PLANNED: 'Planejado', OPEN: 'Aberto', CLOSED: 'Encerrado', CANCELLED: 'Cancelado' };
const LOT_STATUS_STYLES: Record<ValePassLotStatus, string> = {
  PLANNED: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
  OPEN: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
  CLOSED: 'bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400',
  CANCELLED: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
};
const ALERT_STYLES: Record<ValePassCapacityAlert['severity'], string> = {
  critical: 'border-red-500/30 bg-red-500/[0.08] text-red-500',
  warning: 'border-amber-500/30 bg-amber-500/[0.08] text-amber-600 dark:text-amber-400',
  info: 'border-sky-500/25 bg-sky-500/[0.07] text-sky-700 dark:text-sky-300',
};

const formatCurrency = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const formatDateTime = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const formatDay = (day: string) => day.split('-').reverse().join('/');

export function CampaignManagement({
  campaign,
  canManage,
  onCampaignChanged,
}: {
  campaign: ValePassCampaign;
  canManage: boolean;
  onCampaignChanged: (updated: ValePassCampaign) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [capacity, setCapacity] = useState<ValePassCapacity | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await getValePassCapacityAction(campaign.id);
    setLoading(false);
    if (result.error || !result.capacity) {
      setError(result.error ?? 'Não foi possível carregar a capacidade.');
      return;
    }
    setError(null);
    setCapacity(result.capacity);
  }, [campaign.id]);

  useEffect(() => {
    if (expanded && !capacity && !loading) void refresh();
  }, [expanded, capacity, loading, refresh]);

  return (
    <div className="mt-4 border-t border-ink/10 pt-3 dark:border-white/10">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 text-left text-xs font-semibold uppercase tracking-wide text-marsala dark:text-gold"
      >
        <span className="inline-flex items-center gap-1.5">
          <Layers size={14} /> Capacidade, lotes e configuração
        </span>
        {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>

      {expanded ? (
        <div className="mt-3 space-y-4">
          {error ? (
            <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3.5 py-2.5 text-sm text-red-400">
              {error}
            </p>
          ) : null}
          {loading && !capacity ? <p className="text-xs text-ink/45 dark:text-dark-subtle">Carregando…</p> : null}

          {capacity ? (
            <>
              <CapacitySummary capacity={capacity} onRefresh={refresh} loading={loading} />
              {capacity.alerts.length > 0 ? <AlertList alerts={capacity.alerts} /> : null}
              {capacity.paidOrdersWithoutVoucher.length > 0 ? <ShortfallList capacity={capacity} /> : null}
              <LotsPanel campaignId={campaign.id} capacity={capacity} canManage={canManage} onChanged={refresh} />
            </>
          ) : null}

          {canManage ? (
            editing ? (
              <CampaignEditForm
                campaign={campaign}
                onSaved={(updated) => {
                  setEditing(false);
                  onCampaignChanged(updated);
                  void refresh();
                }}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <button type="button" onClick={() => setEditing(true)} className={secondaryButton}>
                <Pencil size={13} /> Editar configuração
              </button>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-ink/10 px-3 py-2 dark:border-white/10">
      <p className="text-[0.7rem] text-ink/45 dark:text-dark-subtle">{label}</p>
      <p className="text-base font-semibold text-ink dark:text-dark-text">{value}</p>
      {hint ? <p className="mt-0.5 text-[0.65rem] leading-snug text-ink/40 dark:text-dark-subtle">{hint}</p> : null}
    </div>
  );
}

function CapacitySummary({ capacity, onRefresh, loading }: { capacity: ValePassCapacity; onRefresh: () => void; loading: boolean }) {
  const { totals, globalRemaining, openLot } = capacity;
  return (
    <section aria-label="Capacidade da campanha">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-ink dark:text-dark-text">Capacidade</h4>
        <button type="button" onClick={onRefresh} disabled={loading} className={secondaryButton}>
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Atualizar
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile
          label="Vendidos (não cancelados)"
          value={String(totals.consumed)}
          hint={`${totals.issued} emitidos, ${totals.cancelled} cancelados${totals.pending > 0 ? `, ${totals.pending} pagos aguardando emissão (já contam)` : ''}`}
        />
        <Tile label="Limite global" value={capacity.campaign.globalLimit === null ? 'Sem limite' : String(capacity.campaign.globalLimit)} hint="Soma de todos os lotes" />
        <Tile label="Saldo do limite global" value={globalRemaining === null ? '—' : String(globalRemaining)} />
        <Tile
          label="Lote aberto"
          value={openLot ? `${openLot.sold + openLot.pending}/${openLot.quantity}` : 'Nenhum'}
          hint={openLot ? `${openLot.name} — restam ${openLot.remaining}` : 'Sem lote aberto, a venda deveria estar fechada'}
        />
      </div>
      <p className="mt-2 rounded-lg bg-ink/[0.04] px-3 py-2 text-xs leading-snug text-ink/65 dark:bg-white/5 dark:text-dark-muted">
        Estoque recomendado na Shopify agora: <strong>{capacity.recommendedShopifyStock}</strong>. O painel só mostra o número — o estoque da Shopify é ajustado à mão e é ele que realmente bloqueia a venda.
      </p>
    </section>
  );
}

function AlertList({ alerts }: { alerts: readonly ValePassCapacityAlert[] }) {
  return (
    <ul className="space-y-2" aria-label="Alertas">
      {alerts.map((alert) => (
        <li key={alert.code} className={`rounded-lg border px-3 py-2 text-xs leading-snug ${ALERT_STYLES[alert.severity]}`}>
          <strong className="mr-1 uppercase">{alert.severity === 'critical' ? 'Crítico' : alert.severity === 'warning' ? 'Atenção' : 'Info'}:</strong>
          {alert.message}
        </li>
      ))}
    </ul>
  );
}

function ShortfallList({ capacity }: { capacity: ValePassCapacity }) {
  return (
    <section aria-label="Pedidos pagos sem todos os passes">
      <h4 className="mb-2 text-xs font-semibold text-red-500">Pedidos pagos com menos passes do que o comprado</h4>
      <ul className="space-y-1.5">
        {capacity.paidOrdersWithoutVoucher.map((order) => (
          <li key={order.orderId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/20 px-3 py-2 text-xs text-ink dark:text-dark-text">
            <span>
              Pedido {order.orderName ?? order.orderId}: comprou {order.quantity}, emitidos {order.issued}
            </span>
            <strong className="text-red-500">faltam {order.missing}</strong>
          </li>
        ))}
      </ul>
      <p className={hintClass}>A emissão dos passes que faltam é uma ação administrativa da próxima etapa; por ora, identifique o pedido pelo número na Shopify.</p>
    </section>
  );
}

function LotsPanel({ campaignId, capacity, canManage, onChanged }: { campaignId: string; capacity: ValePassCapacity; canManage: boolean; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [pending, setPending] = useState(false);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    const parsed = Number(quantity);
    if (!name.trim()) return setError('Dê um nome ao lote (ex.: Lote 1).');
    if (!Number.isInteger(parsed) || parsed < 1) return setError('Informe a quantidade de passes do lote.');
    setPending(true);
    setError(null);
    const result = await createValePassLotAction(campaignId, { name: name.trim(), quantity: parsed });
    setPending(false);
    if (result.error) return setError(result.error);
    setName('');
    setQuantity('');
    onChanged();
  }

  return (
    <section aria-label="Lotes">
      <h4 className="mb-2 text-xs font-semibold text-ink dark:text-dark-text">Lotes</h4>
      {capacity.lots.length === 0 ? (
        <p className="text-xs text-ink/45 dark:text-dark-subtle">Nenhum lote criado. O limite de um lote nunca é o limite global: o lote só abre se couber no saldo global.</p>
      ) : (
        <ul className="space-y-2">
          {capacity.lots.map((lot) => (
            <LotRow key={lot.id} campaignId={campaignId} lot={lot} canManage={canManage} onChanged={onChanged} onError={setError} />
          ))}
        </ul>
      )}

      {canManage ? (
        <form onSubmit={create} className="mt-3 grid gap-2 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
          <label>
            <span className={labelClass}>Novo lote — nome</span>
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="Lote 1" className={`${inputClass} mt-1`} />
          </label>
          <label>
            <span className={labelClass}>Quantidade</span>
            <input value={quantity} onChange={(event) => setQuantity(event.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="100" className={`${inputClass} mt-1`} />
          </label>
          <button type="submit" disabled={pending} className={primaryButton}>
            <Plus size={14} /> {pending ? 'Criando…' : 'Criar lote'}
          </button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3.5 py-2.5 text-xs text-red-400">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function LotRow({ campaignId, lot, canManage, onChanged, onError }: { campaignId: string; lot: ValePassLot; canManage: boolean; onChanged: () => void; onError: (message: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [quantity, setQuantity] = useState(String(lot.quantity));
  const [name, setName] = useState(lot.name);
  const [pending, setPending] = useState(false);

  async function act(action: ValePassLotAction) {
    onError(null);
    const result = await actOnValePassLotAction(campaignId, lot.id, action, lot.updatedAt);
    if (result.error) {
      onError(result.error);
      throw new Error(result.error);
    }
    onChanged();
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const parsed = Number(quantity);
    if (!Number.isInteger(parsed) || parsed < 1) return onError('Informe uma quantidade válida.');
    setPending(true);
    onError(null);
    const result = await updateValePassLotAction(campaignId, lot.id, {
      expectedUpdatedAt: lot.updatedAt,
      ...(lot.status === 'PLANNED' && name.trim() !== lot.name ? { name: name.trim() } : {}),
      ...(parsed !== lot.quantity ? { quantity: parsed } : {}),
    });
    setPending(false);
    if (result.error) return onError(result.error);
    setEditing(false);
    onChanged();
  }

  const editable = canManage && (lot.status === 'PLANNED' || lot.status === 'OPEN');
  return (
    <li className="rounded-lg border border-ink/10 px-3 py-2.5 dark:border-white/10">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink dark:text-dark-text">{lot.name}</p>
          <p className="text-xs text-ink/50 dark:text-dark-subtle">
            {lot.sold + lot.pending}/{lot.quantity} vendidos · restam {lot.remaining}
            {lot.pending > 0 ? ` · ${lot.pending} pago(s) aguardando emissão já contam` : ''}
            {lot.soldOut && lot.status === 'OPEN' ? ' · esgotado' : ''}
          </p>
          {lot.openedAt ? (
            <p className="text-[0.7rem] text-ink/40 dark:text-dark-subtle">
              Aberto em {formatDateTime(lot.openedAt)}
              {lot.closedAt ? ` · encerrado em ${formatDateTime(lot.closedAt)}` : ''}
            </p>
          ) : null}
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${LOT_STATUS_STYLES[lot.status]}`}>{LOT_STATUS_LABELS[lot.status]}</span>
      </div>

      {editable ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {lot.status === 'PLANNED' ? (
            <ConfirmDialog
              trigger={<button type="button" className={secondaryButton}>Abrir lote</button>}
              title={`Abrir "${lot.name}"?`}
              description="O lote passa a contar as vendas a partir de agora. Isso não altera o estoque da Shopify: ajuste-o à mão para o saldo do lote."
              confirmLabel="Abrir"
              onConfirm={() => act('open')}
            />
          ) : null}
          {lot.status === 'OPEN' ? (
            <ConfirmDialog
              trigger={<button type="button" className={secondaryButton}>Encerrar lote</button>}
              title={`Encerrar "${lot.name}"?`}
              description="Um lote encerrado nunca é reaberto: para continuar vendendo, crie e abra outro lote. Os passes vendidos continuam válidos."
              confirmLabel="Encerrar"
              danger
              onConfirm={() => act('close')}
            />
          ) : null}
          <button type="button" onClick={() => setEditing((value) => !value)} className={secondaryButton}>
            <Pencil size={12} /> {lot.status === 'OPEN' ? 'Alterar quantidade' : 'Editar'}
          </button>
          {lot.status === 'PLANNED' ? (
            <ConfirmDialog
              trigger={<button type="button" className={secondaryButton}>Cancelar lote</button>}
              title={`Cancelar "${lot.name}"?`}
              description="O lote nunca foi aberto; ele fica no histórico como cancelado."
              confirmLabel="Cancelar lote"
              danger
              onConfirm={() => act('cancel')}
            />
          ) : null}
        </div>
      ) : null}

      {editing ? (
        <form onSubmit={save} className="mt-2 grid gap-2 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
          <label>
            <span className={labelClass}>Nome</span>
            <input value={name} onChange={(event) => setName(event.target.value)} disabled={lot.status !== 'PLANNED'} maxLength={80} className={`${inputClass} mt-1`} />
          </label>
          <label>
            <span className={labelClass}>Quantidade</span>
            <input value={quantity} onChange={(event) => setQuantity(event.target.value.replace(/\D/g, ''))} inputMode="numeric" className={`${inputClass} mt-1`} />
          </label>
          <button type="submit" disabled={pending} className={primaryButton}>
            {pending ? 'Salvando…' : 'Salvar'}
          </button>
        </form>
      ) : null}
    </li>
  );
}

function CampaignEditForm({ campaign, onSaved, onCancel }: { campaign: ValePassCampaign; onSaved: (updated: ValePassCampaign) => void; onCancel: () => void }) {
  const [name, setName] = useState(campaign.name);
  const [amount, setAmount] = useState((campaign.amountCents / 100).toFixed(2).replace('.', ','));
  const [validityDays, setValidityDays] = useState(String(campaign.validityDays));
  const [globalLimit, setGlobalLimit] = useState(campaign.globalLimit === null ? '' : String(campaign.globalLimit));
  const [quantityLimit, setQuantityLimit] = useState(campaign.quantityLimit === null ? '' : String(campaign.quantityLimit));
  const [validFrom, setValidFrom] = useState(campaign.voucherValidFrom ?? '');
  const [validUntil, setValidUntil] = useState(campaign.voucherValidUntil ?? '');
  const [salesEnd, setSalesEnd] = useState(campaign.salesEndDate ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const amountCents = Math.round(Number(amount.replace(/\./g, '').replace(',', '.')) * 100);
    const days = Number(validityDays);
    if (!name.trim()) return setError('Preencha o nome da campanha.');
    if (!Number.isFinite(amountCents) || amountCents <= 0) return setError('Informe um valor válido.');
    if (!Number.isInteger(days) || days < 1) return setError('Informe uma validade em dias válida.');
    if (Boolean(validFrom) !== Boolean(validUntil)) return setError('Informe as duas datas da validade dos vouchers (início e fim), ou nenhuma.');

    setPending(true);
    setError(null);
    const result = await updateValePassCampaignAction(campaign.id, {
      expectedUpdatedAt: campaign.updatedAt,
      name: name.trim(),
      amountCents,
      validityDays: days,
      globalLimit: globalLimit.trim() ? Number(globalLimit) : null,
      quantityLimit: quantityLimit.trim() ? Number(quantityLimit) : null,
      voucherValidFrom: validFrom || null,
      voucherValidUntil: validUntil || null,
      salesEndDate: salesEnd || null,
    });
    setPending(false);
    if (result.error || !result.campaign) return setError(result.error ?? 'Não foi possível salvar.');
    onSaved(result.campaign);
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-ink/10 p-3 dark:border-white/10">
      <h4 className="text-xs font-semibold text-ink dark:text-dark-text">Editar configuração</h4>
      <p className={hintClass}>
        Vale só para passes emitidos DEPOIS de salvar: os já emitidos mantêm o valor, a validade e o código. Toda alteração fica registrada na auditoria.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className={labelClass}>Nome da campanha</span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} className={`${inputClass} mt-1`} />
        </label>
        <label>
          <span className={labelClass}>Valor do crédito (R$) — usado na emissão atual</span>
          <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" className={`${inputClass} mt-1`} />
        </label>
        <label>
          <span className={labelClass}>Validade em dias — usada na emissão atual</span>
          <input value={validityDays} onChange={(event) => setValidityDays(event.target.value.replace(/\D/g, ''))} inputMode="numeric" className={`${inputClass} mt-1`} />
        </label>
        <label>
          <span className={labelClass}>Limite GLOBAL de passes (todos os lotes)</span>
          <input value={globalLimit} onChange={(event) => setGlobalLimit(event.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="1000" className={`${inputClass} mt-1`} />
          <p className={hintClass}>Teto de passes vendidos em todos os lotes. Passes cancelados deixam de contar.</p>
        </label>
        <label>
          <span className={labelClass}>Limite de emissão (LEGADO)</span>
          <input value={quantityLimit} onChange={(event) => setQuantityLimit(event.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="Vazio = sem bloqueio" className={`${inputClass} mt-1`} />
          <p className={`${hintClass} text-amber-600 dark:text-amber-400`}>Atenção: este limite BLOQUEIA a emissão — depois dele, um pedido pago fica sem passe. Recomendado: deixar vazio e usar o limite global.</p>
        </label>
        <label>
          <span className={labelClass}>Vouchers válidos de</span>
          <input type="date" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} className={`${inputClass} mt-1`} />
        </label>
        <label>
          <span className={labelClass}>até</span>
          <input type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} className={`${inputClass} mt-1`} />
        </label>
        <p className={`${hintClass} sm:col-span-2`}>A validade fixa fica registrada para a próxima etapa; nesta versão a emissão ainda usa a &quot;validade em dias&quot;.</p>
        <label className="sm:col-span-2">
          <span className={labelClass}>Fim das vendas (informativo)</span>
          <input type="date" value={salesEnd} onChange={(event) => setSalesEnd(event.target.value)} className={`${inputClass} mt-1 sm:max-w-xs`} />
          <p className={hintClass}>Não encerra nada sozinho: encerre a campanha e os lotes manualmente.</p>
        </label>
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} className={secondaryButton}>
          Cancelar
        </button>
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? 'Salvando…' : 'Salvar configuração'}
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-3 rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3.5 py-2.5 text-xs text-red-400">
          {error}
        </p>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {pending ? 'Salvando' : ''}
      </p>
      <p className="mt-2 text-[0.65rem] text-ink/35 dark:text-dark-subtle">
        Hoje: {formatCurrency(campaign.amountCents)}, {campaign.validityDays} dias
        {campaign.salesEndDate ? `, vendas até ${formatDay(campaign.salesEndDate)}` : ''}.
      </p>
    </form>
  );
}
