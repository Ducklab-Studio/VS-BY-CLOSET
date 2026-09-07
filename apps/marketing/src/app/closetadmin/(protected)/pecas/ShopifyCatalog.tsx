'use client';

import { useState, useTransition } from 'react';
import { CheckCircle2, Loader2, PackagePlus, RefreshCw } from 'lucide-react';
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
  const [codes, setCodes] = useState('');
  const [message, setMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const variantLabel = item.title === 'Default Title' ? null : item.title;
  const isActive = item.product.status === 'ACTIVE';

  function submit() {
    setMessage(null);
    startTransition(async () => {
      const result = await importShopifyUnitsAction(item.id, codes);
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
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${isActive ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300' : 'bg-neutral-100 text-neutral-600 dark:bg-white/10 dark:text-dark-muted'}`}>
              {item.product.status}
            </span>
          </div>
          {variantLabel ? <p className="mt-0.5 text-sm text-ink/70 dark:text-dark-muted">{variantLabel}</p> : null}
          <p className="mt-1 font-mono text-xs text-ink/50 dark:text-dark-subtle">SKU {item.sku ?? '—'}</p>
          {item.product.productType ? <p className="mt-1 text-xs text-ink/50 dark:text-dark-subtle">{item.product.productType}</p> : null}
        </div>

        <div className="shrink-0 text-right">
          <p className="text-2xl font-semibold text-ink dark:text-dark-text">{item.physicalUnitsTotal}</p>
          <p className="text-[10px] uppercase tracking-wide text-ink/50 dark:text-dark-subtle">peças físicas</p>
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
            <span key={unit.id} className="rounded-md border border-ink/10 px-2 py-1 font-mono text-[11px] text-ink/70 dark:border-white/10 dark:text-dark-muted">
              {unit.code}
              {!unit.active ? ' · inativa' : !unit.reservableOnline ? ' · loja' : ''}
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">Ainda não há peça física vinculada a esta variante.</p>
      )}

      {isAdmin ? (
        <div className="mt-4 border-t border-ink/5 pt-4 dark:border-white/5">
          <label className="text-xs font-medium text-ink/70 dark:text-dark-muted" htmlFor={`codes-${numericId(item.id)}`}>
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
          <p className="mt-1.5 text-[11px] text-ink/45 dark:text-dark-subtle">Separe vários códigos por vírgula. O estoque Shopify é apenas referência e não cria peças automaticamente.</p>
          {message ? (
            <p className={`mt-2 flex items-center gap-1.5 text-xs ${message.type === 'error' ? 'text-red-700 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
              {message.type === 'success' ? <CheckCircle2 size={13} /> : <RefreshCw size={13} />}
              {message.text}
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <p className="font-medium text-ink dark:text-dark-text">{value}</p>
      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-ink/50 dark:text-dark-subtle">{label}</p>
    </div>
  );
}

function numericId(gid: string): string {
  return gid.split('/').pop() ?? gid;
}
