'use client';

import { useState } from 'react';
import { RentalCalendar } from './RentalCalendar';
import { formatPrice, type StorefrontVariant } from '@/lib/shopify';
import { initialVariantId, isDefaultVariantTitle, needsVariantPicker } from '@/lib/variant-selection';

/**
 * Seletor de tamanho + calendário. Com uma variante só, é exatamente o
 * calendário de antes (nenhum controle novo). Com várias, cada tamanho tem a
 * própria disponibilidade (a peça física é ligada pelo ID da variante) e o
 * `key` reinicia o calendário ao trocar, para nunca reaproveitar datas de
 * outro tamanho.
 */
export function RentalVariantPicker({
  variants,
  productTitle,
  productHandle,
  whatsapp,
}: {
  variants: StorefrontVariant[];
  productTitle: string;
  productHandle: string;
  whatsapp?: string;
}) {
  const [selectedId, setSelectedId] = useState(() => initialVariantId(variants));
  const selected = variants.find((variant) => variant.id === selectedId) ?? variants[0];
  if (!selected) return null;
  const picker = needsVariantPicker(variants);

  return (
    <div>
      {picker && (
        <fieldset className="mb-6">
          <legend className="mb-2 text-[0.75rem] font-medium uppercase tracking-widest text-ink/50">Tamanho</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Tamanho da peça">
            {variants.map((variant) => {
              const active = variant.id === selected.id;
              return (
                <button
                  key={variant.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-variant-option={variant.id}
                  onClick={() => setSelectedId(variant.id)}
                  className={[
                    'min-h-11 min-w-11 rounded-full border px-4 text-sm font-medium transition-colors',
                    active ? 'border-marsala bg-marsala text-cream' : 'border-ink/15 text-ink/70 hover:border-marsala/40 hover:text-marsala',
                  ].join(' ')}
                >
                  {isDefaultVariantTitle(variant.title) ? 'Único' : variant.title}
                </button>
              );
            })}
          </div>
          <p className="mt-3 font-mono text-2xl tabular-nums text-marsala" data-selected-price>
            {formatPrice(selected.price.amount, selected.price.currencyCode)}
          </p>
        </fieldset>
      )}
      <RentalCalendar key={selected.id} variant={selected} productTitle={productTitle} productHandle={productHandle} whatsapp={whatsapp} />
    </div>
  );
}
