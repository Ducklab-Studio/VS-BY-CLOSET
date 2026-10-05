'use client';

import { useState, useTransition } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Loader2, PackagePlus, RefreshCw } from 'lucide-react';
import { importShopifyUnitsAction } from './actions';

interface CatalogItem {
  readonly id: string;
  readonly title: string;
  readonly sku: string | null;
  readonly skuStatus: 'synced' | 'missing' | 'pending';
  readonly inventoryQuantity: number | null;
  readonly selectedOptions: readonly { name: string; value: string }[];
  readonly product: {
    readonly id: string;
    readonly title: string;
    readonly productType: string;
    readonly status: string;
  };
  readonly mappedUnits: readonly {
    id: string;
    code: string;
    active: boolean;
    reservableOnline: boolean;
  }[];
  readonly physicalUnitsTotal: number;
  readonly physicalUnitsActive: number;
  readonly physicalUnitsReservableOnline: number;
}

export function ShopifyCatalog({
  items,
  isAdmin,
}: {
  items: readonly CatalogItem[];
  isAdmin: boolean;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-ink/15 bg-white p-6 text-sm text-ink/60 dark:border-white/10 dark:bg-dark-card dark:text-dark-muted">
        Nenhuma variante encontrada no catálogo da Shopify.
      </div>
    );
  }

  return (
    <div className="grid gap-3 xl:grid-cols-2">
      {items.map((item) => (
        <CatalogCard key={item.id} item={item} isAdmin={isAdmin} />
      ))}
    </div>
  );
}

function CatalogCard({ item, isAdmin }: { item: CatalogItem; isAdmin: boolean }) {
  const isActive = item.product.status === 'ACTIVE';
  const [codes, setCodes] = useState('');
  const [reservableOnline, setReservableOnline] = useState(isActive);
  const [countsTowardRentalDuration, setCountsTowardRentalDuration] = useState(true);
  const [message, setMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const variantLabel = item.title === 'Default Title' ? null : item.title;

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
    <article className="rounded-xl border border-ink/10 bg-white p-4 shadow-sm transition-colors dark:border-white/10 dark:bg-dark-card">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium text-ink dark:text-dark-text">{item.product.title}</h3>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${isActive ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300' : 'bg-neutral-100 text-neutral-600 dark:bg-white/10 dark:text-dark-muted'}`}
            >
              {item.product.status}
            </span>
          </div>
          {variantLabel ? (
            <p className="mt-0.5 text-sm text-ink/70 dark:text-dark-muted">{variantLabel}</p>
          ) : null}
          <SkuLine sku={item.sku} status={item.skuStatus} />
          {item.product.productType ? (
            <p className="mt-1 text-xs text-ink/50 dark:text-dark-subtle">
              {item.product.productType}
            </p>
          ) : null}
        </div>

        <div className="shrink-0 text-right">
          <p className="text-2xl font-semibold text-ink dark:text-dark-text">
            {item.physicalUnitsTotal}
          </p>
          <p className="text-[10px] uppercase tracking-wide text-ink/50 dark:text-dark-subtle">
            peças físicas
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 rounded-lg bg-ink/[0.025] p-3 text-center dark:bg-white/[0.025]">
        <Metric label="Ativas" value={item.physicalUnitsActive} />
        <Metric label="Online" value={item.physicalUnitsReservableOnline} />
        <Metric label="Estoque Shopify" value={item.inventoryQuantity ?? '—'} />
      </div>

      {item.mappedUnits.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {item.mappedUnits.map((unit) => (
            <span
              key={unit.id}
              className="rounded-md border border-ink/10 px-2 py-1 font-mono text-[11px] text-ink/70 dark:border-white/10 dark:text-dark-muted"
            >
              {unit.code}
              {!unit.active ? ' · inativa' : !unit.reservableOnline ? ' · loja' : ''}
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
          Ainda não há peça física vinculada a esta variante.
        </p>
      )}

      {isAdmin ? (
        <div className="mt-4 border-t border-ink/5 pt-4 dark:border-white/5">
          <label
            className="text-xs font-medium text-ink/70 dark:text-dark-muted"
            htmlFor={`codes-${numericId(item.id)}`}
          >
            Códigos das peças físicas
          </label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              id={`codes-${numericId(item.id)}`}
              value={codes}
              onChange={(event) => setCodes(event.target.value)}
              placeholder="VS-SOB-001, VS-SOB-002"
              className="min-w-0 flex-1 rounded-lg border border-ink/10 bg-transparent px-3 py-2 text-sm text-ink outline-none transition focus:border-marsala dark:border-white/10 dark:text-dark-text dark:focus:border-gold"
              disabled={pending}
            />
            <button
              type="button"
              onClick={submit}
              disabled={pending || !codes.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-marsala px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gold dark:text-neutral-950"
            >
              {pending ? <Loader2 size={15} className="animate-spin" /> : <PackagePlus size={15} />}
              Cadastrar
            </button>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <OptionToggle
              label="Reservável online"
              description="Entra na disponibilidade do site."
              checked={reservableOnline}
              disabled={pending || !isActive}
              onChange={setReservableOnline}
            />
            <OptionToggle
              label="Conta na duração"
              description="Conta para calcular 2/3/4 dias."
              checked={countsTowardRentalDuration}
              disabled={pending}
              onChange={setCountsTowardRentalDuration}
            />
          </div>

          {!isActive ? (
            <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
              Produto inativo na Shopify: a nova peça será criada fora da reserva online.
            </p>
          ) : null}

          <p className="mt-2 text-[11px] text-ink/45 dark:text-dark-subtle">
            Separe vários códigos por vírgula. Com uma única peça nesta variante, o código passa a
            ser o SKU da Shopify automaticamente. O SKU e o estoque nunca criam peças físicas
            sozinhos.
          </p>
          {message ? (
            <p
              className={`mt-2 flex items-center gap-1.5 text-xs ${message.type === 'error' ? 'text-red-700 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300'}`}
            >
              {message.type === 'success' ? <CheckCircle2 size={13} /> : <RefreshCw size={13} />}
              {message.text}
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/** SKU atual da variante (lido da Shopify agora) + situação do vínculo com as
 *  peças físicas. O SKU é sincronizado sozinho pela variante — nunca é digitado aqui. */
function SkuLine({ sku, status }: { sku: string | null; status: CatalogItem['skuStatus'] }) {
  const badge =
    status === 'synced'
      ? {
          icon: <CheckCircle2 size={11} />,
          text: 'SKU sincronizado',
          className: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
        }
      : status === 'missing'
        ? {
            icon: <AlertTriangle size={11} />,
            text: 'SKU ausente',
            className: 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
          }
        : {
            icon: <Clock size={11} />,
            text: 'Sincronizando SKU',
            className: 'bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300',
          };
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <p className="font-mono text-xs text-ink/50 dark:text-dark-subtle">SKU {sku ?? '—'}</p>
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.className}`}
        title={
          status === 'pending'
            ? 'Alguma peça física ainda guarda o SKU anterior; a próxima sincronização corrige sozinha.'
            : 'O SKU vem da Shopify e é atualizado automaticamente pela variante.'
        }
      >
        {badge.icon}
        {badge.text}
      </span>
    </div>
  );
}

function OptionToggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label
      className={`flex items-start gap-2 rounded-lg border border-ink/10 px-3 py-2.5 text-xs dark:border-white/10 ${disabled ? 'opacity-55' : 'cursor-pointer'}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 accent-marsala dark:accent-gold"
      />
      <span>
        <span className="block font-medium text-ink dark:text-dark-text">{label}</span>
        <span className="mt-0.5 block text-ink/45 dark:text-dark-subtle">{description}</span>
      </span>
    </label>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <p className="font-medium text-ink dark:text-dark-text">{value}</p>
      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-ink/50 dark:text-dark-subtle">
        {label}
      </p>
    </div>
  );
}

function numericId(gid: string): string {
  return gid.split('/').pop() ?? gid;
}
