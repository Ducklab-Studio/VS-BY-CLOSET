'use client';

import Link from 'next/link';
import { X } from 'lucide-react';
import { formatPrice } from '@/lib/shopify';
import { fromISO } from '@/lib/rental-rules';
import { draftReturnDate, removePiece } from '@/lib/rental-draft';
import { selectionTotal } from '@/lib/rental-price';
import { useRentalDraft } from './useRentalDraft';

/**
 * Catálogo durante "Adicionar outra peça": mostra a reserva em montagem (peças
 * com o preço de cada uma, retirada, opção de devolução e o total estimado —
 * a soma de TODAS as peças), permite remover peças e voltar ao calendário sem
 * perder nada. Fica no fluxo da página (não fixa), então nunca cobre fotos no
 * celular. O valor oficial é o do carrinho da Shopify, depois do "Alugar agora".
 */
export function RentalSelectionBar({
  locale = 'pt-BR',
  initialRaw = null,
}: {
  locale?: string;
  initialRaw?: string | null;
}) {
  const { draft, write } = useRentalDraft(initialRaw);
  if (draft.pieces.length === 0) return null;

  const total = selectionTotal(draft.pieces);
  const last = draft.pieces[draft.pieces.length - 1];
  const returnDate = draftReturnDate(draft);
  const optionLabel =
    draft.returnOption === 'saturday'
      ? ' (sábado à noite)'
      : draft.returnOption === 'mondayMorning'
        ? ' (segunda-feira)'
        : '';
  // A devolução depende da quantidade de peças: só mostra a data calculada para esta quantidade.
  const returnLabel = returnDate
    ? `devolução ${fromISO(returnDate).toLocaleDateString(locale)}${optionLabel}`
    : draft.pickup
      ? 'devolução recalculada no calendário'
      : null;
  return (
    <section
      aria-labelledby="rental-selection-title"
      data-testid="rental-selection-bar"
      data-pieces={draft.pieces.length}
      data-total={total.status === 'ok' ? total.amount : undefined}
      className="mb-10 rounded-3xl border border-marsala/15 bg-white p-6 shadow-[0_8px_30px_rgb(0,0,0,0.04)] relative overflow-hidden"
    >
      <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-marsala to-marsala-glow" />

      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div>
          <h2
            id="rental-selection-title"
            className="text-[0.7rem] font-bold uppercase tracking-[0.2em] text-marsala mb-1"
          >
            Sua reserva em montagem
          </h2>
          <p className="text-[0.8rem] font-medium text-ink/60 flex flex-wrap items-center gap-1.5">
            <span className="bg-marsala/10 text-marsala px-2 py-0.5 rounded-full text-[0.7rem] font-bold">
              {draft.pieces.length} {draft.pieces.length === 1 ? 'peça' : 'peças'}
            </span>
            {draft.pickup ? (
              <span className="flex items-center gap-1.5">
                <span className="text-ink/30">•</span>
                <span>Retirada {fromISO(draft.pickup).toLocaleDateString(locale)}</span>
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <span className="text-ink/30">•</span>
                <span>Retirada a definir</span>
              </span>
            )}
            {returnLabel && (
              <span className="flex items-center gap-1.5">
                <span className="text-ink/30">•</span>
                <span>{returnLabel}</span>
              </span>
            )}
          </p>
        </div>
      </div>
      <ul className="mb-6 flex flex-wrap gap-2.5">
        {draft.pieces.map((piece) => (
          <li
            key={piece.variantId}
            className="group flex items-center gap-2 rounded-full border border-ink/10 bg-cream/50 py-1.5 pl-4 pr-1.5 text-[0.8rem] shadow-sm transition hover:border-marsala/30 hover:bg-white"
          >
            <Link
              href={`/pecas/${piece.handle}`}
              className="font-medium text-ink/80 transition-colors hover:text-marsala focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-marsala/40 rounded-sm"
            >
              {piece.title}
            </Link>
            <span className="tabular-nums text-ink/40 font-mono text-[0.75rem]">
              {piece.priceAmount !== null && piece.currencyCode
                ? formatPrice(piece.priceAmount, piece.currencyCode, locale)
                : 'a confirmar'}
            </span>
            <button
              type="button"
              onClick={() => write(removePiece(draft, piece.variantId))}
              aria-label={`Remover ${piece.title} da reserva`}
              className="ml-1 rounded-full p-1 text-ink/40 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40"
            >
              <X size={14} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-5 border-t border-ink/5 pt-5">
        <div>
          <p className="text-[0.75rem] uppercase tracking-widest text-ink/40 font-semibold mb-1">
            Total Estimado
          </p>
          <p className="text-2xl font-mono font-bold text-marsala leading-none">
            {total.status === 'ok' ? (
              formatPrice(total.amount, total.currencyCode, locale)
            ) : (
              <span className="text-lg">Confirmado no carrinho</span>
            )}
          </p>
          <p className="mt-2 text-[0.7rem] text-ink/40 max-w-sm">
            Selecionadas, ainda fora do carrinho: as peças só entram no carrinho em &quot;Alugar
            agora&quot;, todas juntas.
          </p>
        </div>

        <div className="flex flex-wrap sm:flex-nowrap gap-3 shrink-0">
          <a
            href="#catalogo-pecas"
            className="flex-1 sm:flex-none inline-flex items-center justify-center rounded-xl border border-marsala/20 bg-white px-5 py-3 text-[0.7rem] font-bold uppercase tracking-[0.12em] text-marsala transition-all hover:bg-marsala/5 hover:border-marsala focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-marsala/40 focus-visible:ring-offset-2 active:scale-95"
          >
            Continuar escolhendo
          </a>
          <Link
            href={`/pecas/${last.handle}#rental-calendar`}
            className="flex-1 sm:flex-none inline-flex items-center justify-center rounded-xl bg-marsala px-6 py-3 text-[0.7rem] font-bold uppercase tracking-[0.12em] text-cream transition-all hover:bg-marsala-glow hover:shadow-[0_0_20px_rgba(83,19,30,0.3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-marsala/40 focus-visible:ring-offset-2 active:scale-95"
          >
            Alugar agora
          </Link>
        </div>
      </div>
    </section>
  );
}

/** Marca discreta no card da peça que já está na reserva em montagem. */
export function SelectionFlag({
  handle,
  initialRaw = null,
}: {
  handle: string;
  initialRaw?: string | null;
}) {
  const { draft } = useRentalDraft(initialRaw);
  if (!draft.pieces.some((piece) => piece.handle === handle)) return null;
  return (
    <span
      data-testid="selection-flag"
      className="absolute left-2 top-2 z-[1] rounded-full bg-marsala px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.1em] text-cream"
    >
      Selecionada
    </span>
  );
}
