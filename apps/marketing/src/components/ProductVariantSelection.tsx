'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { RentalCalendar } from './RentalCalendar';
import { fetchVariantStock, isCartConfigured } from '@/lib/cart';
import {
  findVariant,
  numericId,
  optionGroups,
  optionLabel,
  priceSummary,
  selectionFor,
  valueSellable,
  variantFromParam,
  variantStorageKey,
  type OptionGroup,
  type OptionSelection,
} from '@/lib/product-options';
import type { ShopifyStock } from '@/lib/shopify-stock';
import { formatPrice, type StorefrontVariant } from '@/lib/shopify';

/**
 * Escolha da variante da peça (tamanho etc.) — as opções e variantes vêm
 * direto da Shopify (lib/product-options.ts); nada é escrito à mão aqui.
 *
 *  - Uma variante só (ou nenhuma opção que varia): sem seletor, como sempre.
 *  - Várias: nenhuma vem escolhida. Só depois de escolher todas as opções
 *    aparece o calendário, sempre com a variante exata — preço, estoque, SKU
 *    e reserva são os dela, nunca os da primeira.
 *  - Variante sem estoque aparece riscada e não pode ser escolhida.
 *  - A escolha fica no endereço (?v=) e no navegador; ao abrir a peça de novo
 *    volta o mesmo tamanho (se ainda estiver à venda).
 *
 * Este componente não mexe em disponibilidade por data, HOLD nem checkout: só
 * decide QUAL variante o RentalCalendar (inalterado) recebe.
 */

interface SelectionState {
  groups: OptionGroup[];
  variants: StorefrontVariant[];
  /** Escolhas válidas (já sem as que perderam estoque). */
  selection: OptionSelection;
  variant: StorefrontVariant | null;
  restored: boolean;
  busy: boolean;
  note: string | null;
  choose: (groupKey: string, valueKey: string) => void;
  isSellable: (variant: StorefrontVariant) => boolean;
  setBusy: (busy: boolean) => void;
  productTitle: string;
  productHandle: string;
  whatsapp?: string;
}

const Ctx = createContext<SelectionState | null>(null);

function useSelection(): SelectionState {
  const value = useContext(Ctx);
  if (!value) throw new Error('ProductVariantSelection fora do ProductVariantProvider.');
  return value;
}

export function ProductVariantProvider({
  variants,
  productTitle,
  productHandle,
  whatsapp,
  children,
}: {
  variants: StorefrontVariant[];
  productTitle: string;
  productHandle: string;
  whatsapp?: string;
  children: ReactNode;
}) {
  const groups = useMemo(() => optionGroups(variants), [variants]);
  const [picked, setPicked] = useState<OptionSelection>({});
  const [stock, setStock] = useState<ReadonlyMap<string, ShopifyStock>>(() => new Map());
  const [restored, setRestored] = useState(groups.length === 0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  /**
   * À venda? A consulta FRESCA da Shopify manda; sem resposta, vale o que a
   * página trouxe (a página é cacheada: `false` sozinho já bloqueou peça com
   * estoque, por isso o dado fresco vence nos dois sentidos).
   */
  const isSellable = useCallback(
    (variant: StorefrontVariant) => {
      const fresh = stock.get(variant.id);
      if (fresh?.status === 'available') return true;
      if (fresh?.status === 'sold_out') return false;
      return variant.availableForSale !== false;
    },
    [stock],
  );

  // Escolhas que perderam o estoque (ou não combinam mais) saem sozinhas.
  const selection = useMemo<OptionSelection>(() => {
    const kept: Record<string, string> = {};
    for (const group of groups) {
      const value = picked[group.key];
      if (value && valueSellable(variants, groups, { ...picked, ...kept }, group.key, value, isSellable)) kept[group.key] = value;
    }
    return kept;
  }, [picked, groups, variants, isSellable]);

  const variant = useMemo<StorefrontVariant | null>(() => {
    if (groups.length === 0) return variants[0] ?? null;
    return findVariant(variants, groups, selection, isSellable);
  }, [groups, variants, selection, isSellable]);

  // Estoque fresco de TODAS as variantes (uma consulta): é ele que risca o tamanho esgotado.
  useEffect(() => {
    if (groups.length === 0 || !isCartConfigured) return;
    let cancelled = false;
    void fetchVariantStock(variants.map((v) => v.id)).then((fresh) => {
      if (!cancelled) setStock(fresh);
    });
    return () => {
      cancelled = true;
    };
  }, [groups, variants]);

  // Retoma a escolha: primeiro o endereço (?v=), depois a última deste navegador. Só variante desta peça e à venda.
  useEffect(() => {
    if (groups.length === 0) return;
    const fromUrl = variantFromParam(variants, new URLSearchParams(window.location.search).get('v'));
    let stored: StorefrontVariant | null = null;
    if (!fromUrl) {
      try {
        stored = variantFromParam(variants, window.localStorage.getItem(variantStorageKey(productHandle)));
      } catch {
        /* navegador sem armazenamento: segue sem retomar */
      }
    }
    const wanted = fromUrl ?? stored;
    if (wanted && wanted.availableForSale !== false) setPicked(selectionFor(wanted, groups));
    setRestored(true);
  }, [groups, variants, productHandle]);

  // Guarda a escolha completa (e só ela) no endereço e no navegador.
  useEffect(() => {
    if (groups.length === 0 || !restored) return;
    const id = variant ? numericId(variant.id) : null;
    try {
      const url = new URL(window.location.href);
      if (id) url.searchParams.set('v', id);
      else url.searchParams.delete('v');
      if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
    } catch {
      /* sem history: a escolha vale só nesta tela */
    }
    try {
      if (id) window.localStorage.setItem(variantStorageKey(productHandle), id);
      else window.localStorage.removeItem(variantStorageKey(productHandle));
    } catch {
      /* idem */
    }
  }, [variant, groups, restored, productHandle]);

  const choose = useCallback(
    (groupKey: string, valueKey: string) => {
      if (busy) return;
      setNote(null);
      setPicked((current) => {
        if (current[groupKey] === valueKey) return current;
        const next = { ...current, [groupKey]: valueKey };
        // Outra opção que não combina com o que acabou de ser escolhido volta a ser pedida.
        for (const group of groups) {
          if (group.key === groupKey || !next[group.key]) continue;
          const others = { ...next };
          delete others[group.key];
          if (!valueSellable(variants, groups, others, group.key, next[group.key], isSellable)) delete next[group.key];
        }
        return next;
      });
    },
    [busy, groups, variants, isSellable],
  );

  const value = useMemo<SelectionState>(
    () => ({ groups, variants, selection, variant, restored, busy, note, choose, isSellable, setBusy, productTitle, productHandle, whatsapp }),
    [groups, variants, selection, variant, restored, busy, note, choose, isSellable, productTitle, productHandle, whatsapp],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Preço da variante escolhida; sem escolha, o mesmo valor (se todas iguais) ou "a partir de" o menor. */
export function VariantPrice() {
  const { variant, variants, groups } = useSelection();
  if (variant) {
    return (
      <div className="mb-6 flex items-end gap-3">
        <p className="font-mono text-3xl font-medium leading-none tabular-nums text-marsala" data-testid="variant-price" data-variant-id={variant.id}>
          {formatPrice(variant.price.amount, variant.price.currencyCode)}
        </p>
        <span className="mb-1 text-[0.75rem] font-medium uppercase tracking-widest text-ink/40">O aluguel</span>
      </div>
    );
  }
  if (groups.length === 0) return null;
  const summary = priceSummary(variants);
  if (!summary) return null;
  return (
    <div className="mb-6 flex items-end gap-3">
      <p className="font-mono text-3xl font-medium leading-none tabular-nums text-marsala" data-testid="variant-price" data-variant-id="">
        {summary.kind === 'from' && (
          <>
            <span className="font-sans text-[0.8rem] uppercase tracking-[0.12em] text-ink/55">a partir de</span>{' '}
          </>
        )}
        {formatPrice(summary.amount, summary.currencyCode)}
      </p>
    </div>
  );
}

/** Link "Escolha seu período" — só quando há uma variante com SKU para alugar. */
export function VariantPeriodLink() {
  const { variant } = useSelection();
  if (!variant?.sku) return null;
  return (
    <a className="product-period-link" href="#rental-calendar">
      Escolha seu período <span aria-hidden="true">↓</span>
    </a>
  );
}

const sellableLabel = (name: string, label: string, sellable: boolean) => `${name}: ${label}${sellable ? '' : ' — indisponível'}`;

/** Seletor das opções que variam (tamanho etc.). Não aparece se não há o que escolher. */
export function VariantPicker() {
  const { groups, variants, selection, choose, isSellable, busy, variant, restored } = useSelection();
  const [announce, setAnnounce] = useState<string | null>(null);
  if (groups.length === 0) return null;
  const anyUnavailable = groups.some((group) =>
    group.values.some((value) => !valueSellable(variants, groups, selection, group.key, value.key, isSellable)),
  );

  function pick(group: OptionGroup, valueKey: string, label: string, sellable: boolean) {
    if (busy) return;
    if (!sellable) {
      setAnnounce(`${group.name} ${label} está indisponível.`);
      return;
    }
    setAnnounce(null);
    choose(group.key, valueKey);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, group: OptionGroup) {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const enabled = group.values.filter((value) => valueSellable(variants, groups, selection, group.key, value.key, isSellable));
    if (enabled.length === 0) return;
    // A seta parte da opção em FOCO (não da escolhida): sem nada escolhido, a primeira seta vai para a seguinte.
    const current = enabled.findIndex((value) => value.key === event.currentTarget.dataset.value);
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const index =
      event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (current + (forward ? 1 : -1) + enabled.length) % enabled.length;
    const target = enabled[index];
    choose(group.key, target.key);
    const container = event.currentTarget.closest('[role="radiogroup"]');
    window.requestAnimationFrame(() => container?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(target.key)}"]`)?.focus());
  }

  return (
    <div className="variant-picker" data-testid="variant-picker" data-complete={variant ? 'true' : 'false'} aria-busy={!restored}>
      {groups.map((group) => {
        const labelId = `variant-group-${group.key.replace(/[^a-z0-9]+/gi, '-')}`;
        const enabledKeys = group.values
          .filter((value) => valueSellable(variants, groups, selection, group.key, value.key, isSellable))
          .map((value) => value.key);
        const chosen = group.values.find((value) => value.key === selection[group.key]);
        // Quem recebe o Tab: o escolhido, ou o primeiro disponível.
        const tabStop = chosen ? chosen.key : enabledKeys[0];
        return (
          <div key={group.key} className="variant-group" data-option={group.name} data-size-like={group.sizeLike ? 'true' : undefined}>
            <p id={labelId} className="variant-legend">
              {group.name}
              {chosen && <span className="variant-chosen" data-testid="variant-chosen"> · {chosen.label}</span>}
            </p>
            <div role="radiogroup" aria-labelledby={labelId} className="variant-options">
              {group.values.map((value) => {
                const sellable = enabledKeys.includes(value.key);
                const checked = chosen?.key === value.key;
                return (
                  <button
                    key={value.key}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-disabled={!sellable || busy ? true : undefined}
                    aria-label={sellableLabel(group.name, value.label, sellable)}
                    tabIndex={value.key === tabStop ? 0 : -1}
                    data-value={value.key}
                    data-state={checked ? 'selected' : sellable ? 'available' : 'soldout'}
                    className="variant-option"
                    onClick={() => pick(group, value.key, value.label, sellable)}
                    onKeyDown={(event) => onKeyDown(event, group)}
                  >
                    <span aria-hidden="true">{value.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      {anyUnavailable && <p className="variant-hint">Opções riscadas estão indisponíveis.</p>}
      <p role="status" aria-live="polite" className="variant-hint" data-testid="variant-status">
        {announce}
      </p>
    </div>
  );
}

/** Calendário da variante escolhida; antes da escolha, só o convite para escolher. */
export function VariantRental() {
  const { variant, groups, productTitle, productHandle, whatsapp, setBusy, restored } = useSelection();
  if (!variant) {
    return (
      <div id="rental-calendar" className="rental-calendar rounded-xl border p-5" data-testid="rental-choose-variant" aria-busy={!restored}>
        <p className="text-sm text-ink/70">Escolha as opções acima para ver as datas disponíveis.</p>
      </div>
    );
  }
  return (
    <RentalCalendar
      key={variant.id}
      variant={variant}
      productTitle={productTitle}
      productHandle={productHandle}
      whatsapp={whatsapp}
      optionLabel={optionLabel(variant.selectedOptions)}
      onBusyChange={setBusy}
    />
  );
}
