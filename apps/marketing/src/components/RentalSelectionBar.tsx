'use client';

import Link from 'next/link';
import { X } from 'lucide-react';
import { formatPrice } from '@/lib/shopify';
import { fromISO } from '@/lib/rental-rules';
import { removePiece, totalPrice } from '@/lib/rental-draft';
import { useRentalDraft } from './useRentalDraft';

/**
 * Catálogo durante "Adicionar outra peça": mostra a reserva em montagem (peças,
 * retirada, total), permite remover peças e voltar ao calendário sem perder
 * nada. Fica no fluxo da página (não fixa), então nunca cobre fotos no celular.
 */
export function RentalSelectionBar({ locale = 'pt-BR', initialRaw = null }: { locale?: string; initialRaw?: string | null }) {
  const { draft, write } = useRentalDraft(initialRaw);
  if (draft.pieces.length === 0) return null;

  const total = totalPrice(draft.pieces);
  const last = draft.pieces[draft.pieces.length - 1];
  return (
    <section aria-labelledby="rental-selection-title" data-testid="rental-selection-bar" className="mb-8 rounded-2xl border border-marsala/20 bg-marsala/[0.04] p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="rental-selection-title" className="text-[0.8rem] font-semibold uppercase tracking-[0.14em] text-marsala">
          Sua reserva em montagem
        </h2>
        <p className="text-[0.78rem] text-ink/60">
          {draft.pieces.length} {draft.pieces.length === 1 ? 'peça' : 'peças'}
          {draft.pickup ? ` · retirada ${fromISO(draft.pickup).toLocaleDateString(locale)}` : ' · retirada ainda não escolhida'}
          {total ? ` · ${formatPrice(total.amount, total.currencyCode, locale)}` : ''}
        </p>
      </div>
      <ul className="mt-3 flex flex-wrap gap-2">
        {draft.pieces.map((piece) => (
          <li key={piece.variantId} className="flex items-center gap-1 rounded-full border border-ink/15 bg-cream py-1 pl-3 pr-1 text-[0.78rem]">
            <Link href={`/pecas/${piece.handle}`} className="hover:text-marsala focus-visible:underline focus-visible:outline-none">
              {piece.title}
            </Link>
            <button
              type="button"
              onClick={() => write(removePiece(draft, piece.variantId))}
              aria-label={`Remover ${piece.title} da reserva`}
              className="rounded-full p-1 text-ink/50 transition-colors hover:bg-marsala/10 hover:text-marsala focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-marsala/40"
            >
              <X size={14} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[0.75rem] text-ink/55">Escolha outra peça abaixo ou volte ao calendário para alugar todas juntas.</p>
      <Link
        href={`/pecas/${last.handle}#rental-calendar`}
        className="mt-3 inline-flex items-center rounded-xl bg-marsala px-4 py-2.5 text-[0.75rem] font-semibold uppercase tracking-[0.12em] text-cream transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-marsala/40 focus-visible:ring-offset-2"
      >
        Voltar ao calendário
      </Link>
    </section>
  );
}

/** Marca discreta no card da peça que já está na reserva em montagem. */
export function SelectionFlag({ handle, initialRaw = null }: { handle: string; initialRaw?: string | null }) {
  const { draft } = useRentalDraft(initialRaw);
  if (!draft.pieces.some((piece) => piece.handle === handle)) return null;
  return (
    <span data-testid="selection-flag" className="absolute left-2 top-2 z-[1] rounded-full bg-marsala px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.1em] text-cream">
      Na sua seleção
    </span>
  );
}
