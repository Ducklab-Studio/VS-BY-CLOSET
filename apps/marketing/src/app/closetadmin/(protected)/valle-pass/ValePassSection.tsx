'use client';

import { useMemo, useState } from 'react';
import { Ban, CheckCircle2, Gift, Plus, Power, PowerOff, RotateCcw, Search, ShieldAlert, Ticket, XCircle } from 'lucide-react';
import type { ValePassCampaign, ValePassStatus, ValePassVoucher } from '@/lib/admin-data';
import { ConfirmDialog } from '@/components/closetadmin/ConfirmDialog';
import { EmptyState } from '@/components/closetadmin/ui';
import {
  cancelValePassVoucherAction,
  createValePassCampaignAction,
  listValePassVouchersAction,
  markValePassVoucherUsedAction,
  restoreValePassVoucherAction,
  toggleValePassCampaignAction,
} from './actions';

const inputClass =
  'w-full rounded-lg border border-ink/15 bg-white px-3 py-2.5 text-sm text-ink outline-none transition focus:border-marsala focus:ring-2 focus:ring-marsala/20 dark:border-white/15 dark:bg-dark-surface dark:text-dark-text dark:focus:border-gold dark:focus:ring-gold/20';

const STATUS_LABELS: Record<ValePassStatus, string> = { ACTIVE: 'Ativo', USED: 'Utilizado', EXPIRED: 'Expirado', CANCELLED: 'Cancelado' };
const STATUS_STYLES: Record<ValePassStatus, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
  USED: 'bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300',
  EXPIRED: 'bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400',
  CANCELLED: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
};

function formatCurrency(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function formatDatePt(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR');
}

export function ValePassSection({
  initialCampaigns,
  initialVouchers,
  canManageCampaigns,
}: {
  initialCampaigns: ValePassCampaign[];
  initialVouchers: ValePassVoucher[];
  canManageCampaigns: boolean;
}) {
  const [campaigns, setCampaigns] = useState(initialCampaigns);
  const [vouchers, setVouchers] = useState(initialVouchers);
  const [statusFilter, setStatusFilter] = useState<ValePassStatus | ''>('');
  const [search, setSearch] = useState('');
  // Item novo — "Restauráveis": recorte client-side sobre CANCELLED (o
  // backend já manda `canBeRestored` calculado; não é um ValePassStatus
  // novo, então não vira um parâmetro de /admin/vale-pass/vouchers).
  const [restorableOnly, setRestorableOnly] = useState(false);
  const [vouchersError, setVouchersError] = useState<string | null>(null);

  const visibleVouchers = useMemo(
    () => (restorableOnly ? vouchers.filter((v) => v.status === 'CANCELLED' && v.canBeRestored) : vouchers),
    [vouchers, restorableOnly],
  );

  async function refreshVouchers(nextStatus: ValePassStatus | '' = statusFilter, nextSearch: string = search) {
    const { vouchers: fresh, error } = await listValePassVouchersAction({ status: nextStatus || undefined, search: nextSearch || undefined });
    if (error || !fresh) {
      setVouchersError(error ?? 'Não foi possível atualizar os vales.');
      return;
    }
    setVouchersError(null);
    setVouchers(fresh);
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Gift size={18} className="text-marsala dark:text-gold" />
          <h2 className="font-heading text-lg font-semibold text-ink dark:text-dark-text">Campanhas</h2>
        </div>
        {canManageCampaigns ? <CreateCampaignForm onCreated={(c) => setCampaigns((prev) => [c, ...prev])} /> : null}
        {campaigns.length === 0 ? (
          <EmptyState title="Nenhuma campanha cadastrada ainda" description={canManageCampaigns ? 'Use o formulário acima para criar a primeira.' : undefined} />
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {campaigns.map((campaign) => (
              <CampaignCard
                key={campaign.id}
                campaign={campaign}
                canManage={canManageCampaigns}
                onToggled={(updated) => setCampaigns((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Ticket size={18} className="text-marsala dark:text-gold" />
          <h2 className="font-heading text-lg font-semibold text-ink dark:text-dark-text">Vales — listar, buscar, validar e marcar como utilizado</h2>
        </div>

        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-[240px] flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/35 dark:text-dark-subtle" />
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                refreshVouchers(statusFilter, event.target.value);
              }}
              placeholder="Buscar por código, nome, telefone, e-mail ou nº do pedido"
              className={`${inputClass} pl-9`}
            />
          </div>
          <select
            value={statusFilter}
            onChange={(event) => {
              const next = event.target.value as ValePassStatus | '';
              setStatusFilter(next);
              refreshVouchers(next, search);
            }}
            className={`${inputClass} w-auto`}
          >
            <option value="" className="bg-white text-ink dark:bg-dark-popover dark:text-dark-text">Todos os status</option>
            {(Object.keys(STATUS_LABELS) as ValePassStatus[]).map((status) => (
              <option key={status} value={status} className="bg-white text-ink dark:bg-dark-popover dark:text-dark-text">
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </div>

        {/* Filtros rápidos (item novo: "Cancelados" e "Restauráveis") —
            somam ao select acima, não o substituem. "Restauráveis" também
            fixa o status em CANCELLED: só faz sentido dentro dele. */}
        <div className="flex flex-wrap gap-2">
          <FilterPill
            active={statusFilter === ''}
            onClick={() => {
              setStatusFilter('');
              setRestorableOnly(false);
              refreshVouchers('', search);
            }}
          >
            Todos
          </FilterPill>
          <FilterPill
            active={statusFilter === 'CANCELLED' && !restorableOnly}
            onClick={() => {
              setStatusFilter('CANCELLED');
              setRestorableOnly(false);
              refreshVouchers('CANCELLED', search);
            }}
          >
            Cancelados
          </FilterPill>
          <FilterPill
            active={restorableOnly}
            icon={<RotateCcw size={12} />}
            onClick={() => {
              setStatusFilter('CANCELLED');
              setRestorableOnly(true);
              refreshVouchers('CANCELLED', search);
            }}
          >
            Restauráveis
          </FilterPill>
        </div>

        {vouchersError ? <p className="rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3.5 py-2.5 text-sm text-red-400">{vouchersError}</p> : null}

        {visibleVouchers.length === 0 ? (
          <EmptyState
            title={restorableOnly ? 'Nenhum vale cancelado restaurável agora' : 'Nenhum vale encontrado'}
            description={restorableOnly ? 'Vales já utilizados, expirados, cancelados pela Shopify ou com o pedido cancelado não aparecem aqui.' : undefined}
          />
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {visibleVouchers.map((voucher) => (
              <VoucherCard key={voucher.id} voucher={voucher} canManage={canManageCampaigns} onChanged={() => refreshVouchers()} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function CreateCampaignForm({ onCreated }: { onCreated: (campaign: ValePassCampaign) => void }) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [validityDays, setValidityDays] = useState('90');
  const [quantityLimit, setQuantityLimit] = useState('');
  const [shopifyVariantId, setShopifyVariantId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    const amountCents = Math.round(Number(amount.replace(',', '.')) * 100);
    const validity = Number(validityDays);
    if (name.trim().length < 1) return setError('Preencha o nome da campanha.');
    if (!Number.isFinite(amountCents) || amountCents <= 0) return setError('Informe um valor válido.');
    if (!Number.isFinite(validity) || validity <= 0) return setError('Informe uma validade (em dias) válida.');
    if (shopifyVariantId.trim().length < 1) return setError('Informe o ID da variante da Shopify já criada para este produto.');

    setPending(true);
    setError(null);
    const { campaign, error: createError } = await createValePassCampaignAction({
      name: name.trim(),
      amountCents,
      validityDays: validity,
      quantityLimit: quantityLimit.trim() ? Number(quantityLimit) : undefined,
      shopifyVariantId: shopifyVariantId.trim(),
    });
    setPending(false);

    if (createError || !campaign) {
      setError(createError ?? 'Não foi possível criar a campanha.');
      return;
    }
    setName('');
    setAmount('');
    setValidityDays('90');
    setQuantityLimit('');
    setShopifyVariantId('');
    onCreated(campaign);
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-ink/10 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-dark-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink dark:text-dark-text">Criar nova campanha</h3>
          <p className="mt-1 text-xs text-ink/45 dark:text-dark-subtle">
            Referencia uma variante já criada manualmente na Shopify — este painel nunca cria produto lá, só configura valor/validade/quantidade do lado de cá.
          </p>
        </div>
        <div className="rounded-lg bg-marsala/10 p-2 text-marsala dark:bg-gold/10 dark:text-gold">
          <Plus size={18} />
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-12">
        <label className="lg:col-span-4">
          <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">Nome da campanha</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Valle Pass Verão" className={`${inputClass} mt-1.5`} />
        </label>
        <label className="lg:col-span-2">
          <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">Valor (R$)</span>
          <input value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="150,00" className={`${inputClass} mt-1.5`} />
        </label>
        <label className="lg:col-span-2">
          <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">Validade (dias)</span>
          <input value={validityDays} onChange={(event) => setValidityDays(event.target.value.replace(/\D/g, ''))} inputMode="numeric" className={`${inputClass} mt-1.5`} />
        </label>
        <label className="lg:col-span-2">
          <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">Limite de vendas (opcional)</span>
          <input
            value={quantityLimit}
            onChange={(event) => setQuantityLimit(event.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            placeholder="Sem limite"
            className={`${inputClass} mt-1.5`}
          />
        </label>
        <label className="lg:col-span-2">
          <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">Variante Shopify (ID)</span>
          <input value={shopifyVariantId} onChange={(event) => setShopifyVariantId(event.target.value)} placeholder="447654529" className={`${inputClass} mt-1.5`} />
        </label>
      </div>

      <div className="mt-4 flex justify-end">
        <button type="submit" disabled={pending} className="inline-flex items-center justify-center gap-2 rounded-lg bg-marsala px-4 py-2.5 text-sm font-medium text-cream shadow-sm transition hover:bg-marsala/90 disabled:opacity-50 dark:bg-marsala-light dark:text-sand dark:hover:bg-marsala-glow">
          <Plus size={15} />
          {pending ? 'Criando…' : 'Criar campanha'}
        </button>
      </div>

      {error ? <p className="mt-3 rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3.5 py-2.5 text-sm text-red-400">{error}</p> : null}
    </form>
  );
}

function CampaignCard({ campaign, canManage, onToggled }: { campaign: ValePassCampaign; canManage: boolean; onToggled: (updated: ValePassCampaign) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setPending(true);
    setError(null);
    const { error: toggleError } = await toggleValePassCampaignAction(campaign.id, !campaign.active);
    setPending(false);
    if (toggleError) {
      setError(toggleError);
      return;
    }
    onToggled({ ...campaign, active: !campaign.active });
  }

  return (
    <article className="rounded-xl border border-ink/10 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-dark-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-ink dark:text-dark-text">{campaign.name}</h3>
          <p className="mt-0.5 text-xs text-ink/45 dark:text-dark-subtle">Variante Shopify: {campaign.shopifyVariantId}</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${campaign.active ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300' : 'bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400'}`}>
          {campaign.active ? 'Ativa' : 'Encerrada'}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div>
          <p className="text-ink/40 dark:text-dark-subtle">Valor</p>
          <p className="font-semibold text-ink dark:text-dark-text">{formatCurrency(campaign.amountCents)}</p>
        </div>
        <div>
          <p className="text-ink/40 dark:text-dark-subtle">Validade</p>
          <p className="font-semibold text-ink dark:text-dark-text">{campaign.validityDays} dias</p>
        </div>
        <div>
          <p className="text-ink/40 dark:text-dark-subtle">Vendidos</p>
          <p className="font-semibold text-ink dark:text-dark-text">
            {campaign.soldCount}
            {campaign.quantityLimit ? ` / ${campaign.quantityLimit}` : ''}
          </p>
        </div>
      </div>

      {canManage ? (
        <div className="mt-4">
          <ConfirmDialog
            trigger={
              <button
                type="button"
                disabled={pending}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                  campaign.active
                    ? 'border-amber-500/20 bg-amber-500/[0.05] text-amber-500 hover:bg-amber-500/10'
                    : 'border-emerald-500/20 bg-emerald-500/[0.05] text-emerald-500 hover:bg-emerald-500/10'
                }`}
              >
                {campaign.active ? <PowerOff size={13} /> : <Power size={13} />}
                {campaign.active ? 'Encerrar campanha' : 'Reativar campanha'}
              </button>
            }
            title={campaign.active ? `Encerrar "${campaign.name}"?` : `Reativar "${campaign.name}"?`}
            description={
              campaign.active
                ? 'A venda fica oculta/desativada (o produto continua na Shopify — desligar a venda de lá também é necessário). Os vales já vendidos continuam válidos e no histórico, nada é apagado.'
                : 'A campanha volta a ficar disponível para novas vendas.'
            }
            confirmLabel={campaign.active ? 'Encerrar' : 'Reativar'}
            danger={campaign.active}
            onConfirm={toggle}
          />
        </div>
      ) : null}

      {error ? <p className="mt-3 rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3.5 py-2.5 text-sm text-red-400">{error}</p> : null}
    </article>
  );
}

function VoucherCard({ voucher, canManage, onChanged }: { voucher: ValePassVoucher; canManage: boolean; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);

  async function handleMarkUsed() {
    setError(null);
    const { error: useError } = await markValePassVoucherUsedAction(voucher.code);
    if (useError) {
      setError(useError);
      throw new Error(useError);
    }
    onChanged();
  }

  async function handleCancel(reason?: string) {
    setError(null);
    const { error: cancelError } = await cancelValePassVoucherAction(voucher.code, reason ?? '');
    if (cancelError) {
      setError(cancelError);
      throw new Error(cancelError);
    }
    onChanged();
  }

  async function handleRestore(reason?: string) {
    setError(null);
    const { error: restoreError } = await restoreValePassVoucherAction(voucher.code, reason ?? '');
    if (restoreError) {
      setError(restoreError);
      throw new Error(restoreError);
    }
    onChanged();
  }

  return (
    <article className="rounded-xl border border-ink/10 bg-white p-4 shadow-sm transition-colors dark:border-white/10 dark:bg-dark-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-sm font-semibold text-ink dark:text-dark-text">{voucher.code}</p>
          <p className="mt-0.5 text-xs text-ink/45 dark:text-dark-subtle">{voucher.campaignName} · {formatCurrency(voucher.amountCents)}</p>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[voucher.status]}`}>
          {voucher.status === 'CANCELLED' && voucher.canBeRestored ? <RotateCcw size={11} aria-hidden /> : null}
          {STATUS_LABELS[voucher.status]}
        </span>
      </div>

      <div className="mt-3.5 space-y-1 border-t border-ink/5 pt-3 text-xs text-ink/60 dark:border-white/5 dark:text-dark-muted">
        <p>{voucher.customerName ?? 'Cliente não informado'} {voucher.customerPhone ? `· ${voucher.customerPhone}` : ''}</p>
        {voucher.customerEmail ? <p>{voucher.customerEmail}</p> : null}
        <p>Pedido Shopify: {voucher.shopifyOrderName ?? voucher.shopifyOrderId ?? '—'}</p>
        <p>Comprado em {formatDatePt(voucher.purchasedAt)} · Válido até {formatDatePt(voucher.expiresAt)}</p>
        {voucher.status === 'CANCELLED' && voucher.cancelReason ? (
          <p className="text-red-500 dark:text-red-400">Motivo do cancelamento: {voucher.cancelReason}</p>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-ink/5 pt-3.5 dark:border-white/5">
        {voucher.status === 'ACTIVE' ? (
          <>
            <ConfirmDialog
              trigger={
                <button type="button" className="inline-flex items-center gap-1.5 rounded-lg bg-marsala px-2.5 py-1.5 text-xs font-medium text-cream shadow-sm transition hover:bg-marsala/90 dark:bg-marsala-light dark:text-sand dark:hover:bg-marsala-glow">
                  <CheckCircle2 size={13} /> Marcar como utilizado
                </button>
              }
              title="Marcar este Valle Pass como utilizado?"
              description="O crédito é considerado consumido — esta ação não pode ser desfeita pelo painel."
              confirmLabel="Marcar como utilizado"
              onConfirm={handleMarkUsed}
            />
            {canManage ? (
              <ConfirmDialog
                trigger={
                  <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/[0.05] px-2.5 py-1.5 text-xs font-medium text-red-400 transition hover:bg-red-500/10">
                    <Ban size={13} /> Cancelar
                  </button>
                }
                title="Cancelar este Valle Pass?"
                description="O crédito deixa de poder ser utilizado. O registro nunca é apagado — continua no histórico como cancelado."
                confirmLabel="Cancelar vale"
                requireReason
                danger
                onConfirm={(reason) => handleCancel(reason)}
              />
            ) : null}
          </>
        ) : voucher.status === 'CANCELLED' && canManage && voucher.canBeRestored ? (
          <ConfirmDialog
            trigger={
              <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.06] px-2.5 py-1.5 text-xs font-medium text-emerald-600 transition hover:bg-emerald-500/15 dark:text-emerald-300">
                <RotateCcw size={13} /> Restaurar vale
              </button>
            }
            title="Restaurar este Valle Pass?"
            description={
              <>
                O vale volta a ficar <strong>ativo e disponível</strong> para uso — status atual: cancelado
                {voucher.cancelReason ? <> (motivo: “{voucher.cancelReason}”)</> : null}. Nada do histórico de
                cancelamento é apagado.
              </>
            }
            confirmLabel="Restaurar"
            requireReason
            onConfirm={(reason) => handleRestore(reason)}
          />
        ) : voucher.status === 'CANCELLED' && !voucher.canBeRestored ? (
          <span className="inline-flex items-start gap-1.5 text-xs text-ink/40 dark:text-dark-subtle">
            <ShieldAlert size={13} className="mt-0.5 shrink-0" aria-hidden />
            Não pode ser restaurado{voucher.restoreBlockedReason ? ` — ${voucher.restoreBlockedReason}` : ''}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-ink/40 dark:text-dark-subtle">
            {voucher.status === 'USED' ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
            Nenhuma ação disponível — vale {STATUS_LABELS[voucher.status].toLowerCase()}
          </span>
        )}
      </div>

      {error ? <p className="mt-3 rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3.5 py-2.5 text-sm text-red-400">{error}</p> : null}
    </article>
  );
}

function FilterPill({ active, icon, onClick, children }: { active: boolean; icon?: React.ReactNode; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
        active
          ? 'border-marsala bg-marsala text-cream dark:border-gold dark:bg-gold dark:text-neutral-950'
          : 'border-ink/15 text-ink/60 hover:border-marsala/40 hover:text-marsala dark:border-white/15 dark:text-dark-muted dark:hover:border-gold/40 dark:hover:text-gold'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}
