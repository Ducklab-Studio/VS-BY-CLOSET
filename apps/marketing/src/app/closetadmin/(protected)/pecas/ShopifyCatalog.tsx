'use client';

import { useId, useState, useTransition } from 'react';
import { AlertTriangle, CheckCircle2, Globe, Loader2, Package, PackagePlus, PackageX, Tag, Warehouse } from 'lucide-react';
import { importShopifyUnitsAction } from './actions';

interface CatalogItem {
  readonly id: string;
  readonly title: string;
  readonly sku: string | null;
  readonly inventoryQuantity: number | null;
  readonly selectedOptions: readonly { name: string; value: string }[];
  readonly product: {
    readonly id: string;
    readonly title: string;
    readonly productType: string;
    readonly status: string;
  };
  readonly mappedUnits: readonly { id: string; code: string; active: boolean; reservableOnline: boolean }[];
  readonly physicalUnitsTotal: number;
  readonly physicalUnitsActive: number;
  readonly physicalUnitsReservableOnline: number;
}

export function ShopifyCatalog({ items, isAdmin }: { items: readonly CatalogItem[]; isAdmin: boolean }) {
  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-ink/15 bg-white p-6 text-sm text-ink/60 dark:border-white/10 dark:bg-dark-card dark:text-dark-muted">
        Nenhuma variante encontrada no catálogo da Shopify.
      </div>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {items.map((item) => (
        <CatalogCard key={item.id} item={item} isAdmin={isAdmin} />
      ))}
    </div>
  );
}

/**
 * Um card, quatro zonas visuais bem separadas (mesma ordem do pedido):
 * 1) resumo da variante (título, status, métricas) — 2) peças vinculadas
 * — 3) cadastro de códigos — 4) configurações de reserva. Cada zona é um
 * bloco com padding próprio, separado por uma borda fina (`divide-y`) em
 * vez do amontoado de `mt-*`/`border-t` de antes.
 */
function CatalogCard({ item, isAdmin }: { item: CatalogItem; isAdmin: boolean }) {
  const isActive = item.product.status === 'ACTIVE';
  const [codes, setCodes] = useState('');
  const [reservableOnline, setReservableOnline] = useState(isActive);
  const [countsTowardRentalDuration, setCountsTowardRentalDuration] = useState(true);
  const [message, setMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const variantLabel = item.title === 'Default Title' ? null : item.title;
  const codesInputId = useId();

  function submit() {
    setMessage(null);
    startTransition(async () => {
      const result = await importShopifyUnitsAction(item.id, codes, {
        reservableOnline,
        countsTowardRentalDuration,
      });
      if (result.error) {
        setMessage({ type: 'error', text: result.error });
        return;
      }
      setCodes('');
      setMessage({ type: 'success', text: 'Peça(s) física(s) cadastrada(s).' });
    });
  }

  return (
    <article
      className={`overflow-hidden rounded-2xl border bg-white shadow-sm transition-colors dark:bg-dark-card ${
        isActive ? 'border-ink/10 dark:border-white/10' : 'border-amber-300/50 dark:border-amber-700/40'
      }`}
    >
      <div className="divide-y divide-ink/[0.06] dark:divide-white/[0.06]">
        {/* 1) Resumo da variante */}
        <div className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate font-heading text-[15px] font-semibold tracking-wide text-ink dark:text-dark-text">{item.product.title}</h3>
                <StatusPill isActive={isActive} status={item.product.status} />
              </div>
              {variantLabel ? <p className="mt-0.5 text-sm text-ink/60 dark:text-dark-muted">{variantLabel}</p> : null}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink/45 dark:text-dark-subtle">
                <span className="inline-flex items-center gap-1 font-mono">
                  <Tag size={12} aria-hidden />
                  {item.sku ?? '—'}
                </span>
                {item.product.productType ? <span>{item.product.productType}</span> : null}
              </div>
            </div>
          </div>

          {!isActive ? (
            <p className="mt-3 flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              <AlertTriangle size={13} className="shrink-0" aria-hidden />
              Produto fora do ar na Shopify — não conta como disponível para reserva online.
            </p>
          ) : null}

          <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Metric icon={Package} label="Peças físicas" value={item.physicalUnitsTotal} />
            <Metric icon={CheckCircle2} label="Ativas" value={item.physicalUnitsActive} />
            <Metric icon={Globe} label="Online" value={item.physicalUnitsReservableOnline} />
            <Metric icon={Warehouse} label="Estoque Shopify" value={item.inventoryQuantity ?? '—'} />
          </div>
        </div>

        {/* 2) Peças vinculadas */}
        <div className="p-4">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink/45 dark:text-dark-subtle">Peças vinculadas</p>
          {item.mappedUnits.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {item.mappedUnits.map((unit) => (
                <UnitChip key={unit.id} unit={unit} />
              ))}
            </ul>
          ) : (
            <p className="flex items-center gap-2 text-xs text-ink/45 dark:text-dark-subtle">
              <PackageX size={14} className="shrink-0" aria-hidden />
              Nenhuma peça física vinculada ainda.
            </p>
          )}
        </div>

        {isAdmin ? (
          <>
            {/* 3) Cadastro de códigos */}
            <div className="p-4">
              <label className="text-[11px] font-medium uppercase tracking-wide text-ink/45 dark:text-dark-subtle" htmlFor={codesInputId}>
                Cadastrar peças físicas
              </label>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                  id={codesInputId}
                  value={codes}
                  onChange={(event) => setCodes(event.target.value)}
                  placeholder="VS-SOB-001, VS-SOB-002"
                  className="min-w-0 flex-1 rounded-xl border border-ink/10 bg-transparent px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-marsala focus:ring-2 focus:ring-marsala/15 dark:border-white/10 dark:text-dark-text dark:focus:border-gold dark:focus:ring-gold/15"
                  disabled={pending}
                  aria-describedby={`${codesInputId}-hint`}
                />
                <button
                  type="button"
                  onClick={submit}
                  disabled={pending || !codes.trim()}
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-marsala px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gold dark:text-neutral-950"
                >
                  {pending ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <PackagePlus size={15} aria-hidden />}
                  Cadastrar
                </button>
              </div>
              <p id={`${codesInputId}-hint`} className="mt-2 text-[11px] text-ink/45 dark:text-dark-subtle">
                Separe vários códigos por vírgula. O estoque Shopify é apenas referência e não cria peças automaticamente.
              </p>
              {message ? (
                <p
                  role="status"
                  className={`mt-2.5 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs ${
                    message.type === 'error'
                      ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
                      : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                  }`}
                >
                  {message.type === 'success' ? <CheckCircle2 size={13} aria-hidden /> : <AlertTriangle size={13} aria-hidden />}
                  {message.text}
                </p>
              ) : null}
            </div>

            {/* 4) Configurações de reserva */}
            <div className="p-4">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink/45 dark:text-dark-subtle">Configurações de reserva</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <SwitchOption
                  icon={Globe}
                  label="Reservável online"
                  description="Entra na disponibilidade do site."
                  checked={reservableOnline}
                  disabled={pending || !isActive}
                  onChange={setReservableOnline}
                />
                <SwitchOption
                  icon={CheckCircle2}
                  label="Conta na duração"
                  description="Conta para calcular 2/3/4 dias."
                  checked={countsTowardRentalDuration}
                  disabled={pending}
                  onChange={setCountsTowardRentalDuration}
                />
              </div>
            </div>
          </>
        ) : null}
      </div>
    </article>
  );
}

function StatusPill({ isActive, status }: { isActive: boolean; status: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        isActive
          ? 'border-emerald-300/70 text-emerald-700 dark:border-emerald-700/50 dark:text-emerald-300'
          : 'border-ink/15 text-ink/45 dark:border-white/15 dark:text-dark-subtle'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${isActive ? 'bg-emerald-500' : 'bg-ink/25 dark:bg-white/25'}`} aria-hidden />
      {status}
    </span>
  );
}

function Metric({ icon: Icon, label, value }: { icon: typeof Package; label: string; value: number | string }) {
  return (
    <div className="rounded-xl bg-ink/[0.025] px-3 py-2.5 dark:bg-white/[0.03]">
      <Icon size={14} className="text-ink/35 dark:text-dark-subtle" aria-hidden />
      <p className="mt-1.5 text-lg font-semibold leading-none text-ink dark:text-dark-text">{value}</p>
      <p className="mt-1 text-[10px] uppercase tracking-wide text-ink/45 dark:text-dark-subtle">{label}</p>
    </div>
  );
}

/** Bolinha colorida = leitura rápida sem poluir com texto: verde (ativa e
 *  reservável online), âmbar (ativa, só na loja) ou apagada (inativa —
 *  reativação/motivo ficam na tabela de peças físicas, abaixo). */
function UnitChip({ unit }: { unit: { id: string; code: string; active: boolean; reservableOnline: boolean } }) {
  const dotClassName = !unit.active ? 'bg-red-400/70 dark:bg-red-500/60' : unit.reservableOnline ? 'bg-emerald-500' : 'bg-amber-500';
  const statusLabel = !unit.active ? 'inativa' : unit.reservableOnline ? 'ativa, reservável online' : 'ativa, só na loja';
  return (
    <li>
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-ink/10 bg-ink/[0.015] px-2.5 py-1 font-mono text-[11px] text-ink/75 dark:border-white/10 dark:bg-white/[0.02] dark:text-dark-muted"
        aria-label={`Peça ${unit.code}, ${statusLabel}`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClassName}`} aria-hidden />
        {unit.code}
      </span>
    </li>
  );
}

/** Mesma metáfora visual do switch usado no resto da tela de peças
 *  (PieceToggle/PieceActiveToggle) — só que aqui é rascunho local do
 *  formulário, nunca chama a API sozinho. Checkbox real por baixo (sr-only)
 *  pra manter semântica nativa, foco de teclado visível e leitor de tela. */
function SwitchOption({
  icon: Icon,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  icon: typeof Globe;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label
      className={`flex items-center justify-between gap-3 rounded-xl border border-ink/10 px-3.5 py-3 text-xs transition-colors dark:border-white/10 ${
        disabled ? 'opacity-50' : 'cursor-pointer hover:border-marsala/30 dark:hover:border-gold/30'
      }`}
    >
      <span className="flex items-start gap-2.5">
        <Icon size={15} className="mt-0.5 shrink-0 text-ink/35 dark:text-dark-subtle" aria-hidden />
        <span>
          <span className="block font-medium text-ink dark:text-dark-text">{label}</span>
          <span className="mt-0.5 block text-ink/45 dark:text-dark-subtle">{description}</span>
        </span>
      </span>
      <span className="relative inline-flex h-5 w-9 shrink-0 items-center">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="peer sr-only"
        />
        <span
          className={`h-5 w-9 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-marsala/40 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-gold/40 ${
            checked ? 'bg-marsala dark:bg-gold' : 'bg-ink/15 dark:bg-white/15'
          }`}
          aria-hidden
        />
        <span
          className={`absolute left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform dark:bg-dark-surface ${checked ? 'translate-x-4' : ''}`}
          aria-hidden
        />
      </span>
    </label>
  );
}
