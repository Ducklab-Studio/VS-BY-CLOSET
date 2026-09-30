'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { addDays, fromISO, sameDay, startOfDay, toISO } from '@/lib/rental-rules';
import { CartError, addRentalSelectionToCart, getCart, isCartConfigured, removeCartLine, type Cart } from '@/lib/cart';
import { resolveRentalSelection, type RentalSelection, type ReturnChoice } from '@/lib/rental-selection';
import { EMPTY_DRAFT, addPiece, atPieceLimit, removePiece, selectionWith, withDates, type DraftPiece } from '@/lib/rental-draft';
import { centsToAmount, reservationSummary, type ReservationSummary, type SummaryRow, type SummaryTotal } from '@/lib/rental-price';
import { formatPrice, type StorefrontVariant } from '@/lib/shopify';
import { isValePassProduct } from '@/lib/vale-pass-product';
import { RentalAction } from './RentalAction';
import { useRentalDraft } from './useRentalDraft';

/**
 * Calendário de aluguel.
 *
 * Toda a disponibilidade e as regras (antecedência, temporada, domingo,
 * duração por quantidade de peças, exceção de devolução no domingo) vêm
 * de GET /availability, no reservations-api — que usa o mesmo motor
 * testado em apps/reservations-api/src/rental-rules. Este componente
 * NÃO reimplementa nada disso: só lê o que o servidor já calculou.
 *
 * FAIL CLOSED: se a API falhar, o calendário mostra erro e não deixa
 * reservar. O fallback padrão é o proxy same-origin `/api/availability`;
 * nenhuma URL localhost é gravada no bundle de produção.
 */

const WEEKDAY_BASE = new Date(2024, 0, 7); // um domingo
/** Janela de reserva: dias a partir da primeira retirada possível — hoje, ou
 *  o início da operação configurado no ClosetAdmin, o que vier depois. */
const RANGE_DAYS = 120;

const monthIndex = (d: Date) => d.getFullYear() * 12 + d.getMonth();
const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

interface ReturnOption {
  type: ReturnChoice;
  date: string;
  window?: string;
  /** Disponibilidade da própria data desta opção (API). */
  available?: boolean;
}

interface AvailabilityDay {
  date: string;
  bookable: boolean;
  quantityAvailable: number;
  reason: string | null;
  durationDays?: number;
  calculatedReturnDate?: string;
  hasSundayReturnException?: boolean;
  returnOptions?: ReturnOption[];
}

interface AvailabilityResponse {
  shopifyVariantId: string;
  countedPieces: number;
  unitsTotal: number;
  /** YYYY-MM-DD da primeira retirada online aceita (configurada no painel), ou null. */
  operationStartDate?: string | null;
  /** Máximo de peças por reserva (painel → Regras). Ausente em API antiga. */
  maxPieces?: number;
  days: AvailabilityDay[];
}

export function RentalCalendar({
  variant,
  productTitle,
  productHandle,
  locale = 'pt-BR',
  whatsapp,
}: {
  variant: StorefrontVariant;
  productTitle: string;
  productHandle: string;
  locale?: string;
  whatsapp?: string;
}) {
  const sku = variant.sku ?? '';
  const today = useMemo(() => startOfDay(new Date()), []);
  const router = useRouter();
  // "Adicionar outra peça": peças já escolhidas, retirada e opção de devolução
  // guardadas entre páginas (lib/rental-draft.ts). Esta peça sempre entra.
  const { draft, loaded: draftLoaded, write: writeDraft } = useRentalDraft();
  // Preço ausente fica `null` (a confirmar), nunca 0 — "0.0" é preço válido.
  const priceAmount = variant.price?.amount ?? null;
  const priceCurrency = variant.price?.currencyCode ?? null;
  const currentPiece = useMemo<DraftPiece>(
    () => ({ variantId: variant.id, sku, title: productTitle, handle: productHandle, priceAmount, currencyCode: priceCurrency }),
    [variant.id, sku, productTitle, productHandle, priceAmount, priceCurrency],
  );
  const selectionPieces = useMemo(() => selectionWith(draft, currentPiece), [draft, currentPiece]);

  const [view, setView] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [selected, setSelected] = useState<Date | null>(null);
  const [sundayChoice, setSundayChoice] = useState<ReturnChoice | null>(null);
  /** Carrinho da Shopify (fonte de verdade do valor); `undefined` enquanto é lido, `null` = sem carrinho. */
  const [cart, setCart] = useState<Cart | null | undefined>(undefined);
  const [maxPieces, setMaxPieces] = useState<number | null>(null);
  /** Disponibilidade por mês e quantidade de peças (`peças|YYYY-MM`), carregada quando o mês é exibido. */
  const [months, setMonths] = useState<ReadonlyMap<string, AvailabilityDay[]>>(() => new Map());
  const [failedMonths, setFailedMonths] = useState<ReadonlySet<string>>(() => new Set());
  const [operationStartDate, setOperationStartDate] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Peça sendo removida do carrinho (variante). */
  const [removing, setRemoving] = useState<string | null>(null);
  /** Prévia (centavos) mostrada no clique de "Alugar agora", para avisar se a Shopify confirmou outro total. */
  const [submittedPreview, setSubmittedPreview] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Trava síncrona: dois cliques seguidos nunca viram duas inclusões.
  const submittingRef = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);

  // O limite parte da primeira retirada possível, não só de hoje: com a
  // operação começando meses à frente, uma janela fixa a partir de hoje
  // terminava antes da abertura e travava a navegação.
  const rangeEnd = useMemo(() => {
    const start = operationStartDate ? fromISO(operationStartDate) : null;
    return addDays(start && start > today ? start : today, RANGE_DAYS);
  }, [today, operationStartDate]);

  // Peças da reserva = seleção (já escolhidas + esta) + as outras que já estão
  // no carrinho, cada variante uma vez. Não limita artificialmente em 6: se
  // passar do máximo, o backend responde `max_pieces_exceeded` (capar
  // escondia uma 7ª peça). O valor vem do mesmo resumo (lib/rental-price.ts):
  // soma de TODAS as linhas, e o total oficial da Shopify quando tudo já está
  // no carrinho — nunca o preço da peça desta página.
  const selectionIds = useMemo(() => new Set(selectionPieces.map((piece) => piece.variantId)), [selectionPieces]);
  const rentalCart = useMemo(() => {
    if (!cart) return null;
    const lines = cart.lines.filter((line) => !isValePassProduct({ variantId: line.merchandise.id }));
    // Se algo que não é aluguel estivesse no carrinho, o total dele não seria o da reserva.
    return { lines, cost: lines.length === cart.lines.length ? cart.cost : null };
  }, [cart]);
  const summary = useMemo<ReservationSummary | null>(
    () => (cart === undefined ? null : reservationSummary(selectionPieces, rentalCart)),
    [cart, rentalCart, selectionPieces],
  );
  const pieces = summary ? summary.pieces : null;
  const otherPieces = pieces === null ? null : pieces - selectionPieces.length;
  const limitReached = otherPieces !== null && atPieceLimit(selectionPieces.length, otherPieces, maxPieces);

  const viewKey = monthKey(view);
  const cacheKey = `${pieces ?? '-'}|${viewKey}`;
  const loadFailed = failedMonths.has(cacheKey);
  const loading = pieces === null || (!months.has(cacheKey) && !loadFailed);

  // ---- reserva em montagem: retoma retirada e opção de devolução (uma vez por montagem) ----
  const restoredFor = useRef<string | null>(null);

  // ---- peças no carrinho (uma vez por variante) ----
  useEffect(() => {
    let cancelled = false;
    setCart(undefined);
    setSubmittedPreview(null);
    setMonths(new Map());
    setFailedMonths(new Set());
    setSelected(null);
    setSundayChoice(null);
    setError(null);

    void (async () => {
      const current = isCartConfigured ? await getCart().catch(() => null) : null;
      if (!cancelled) setCart(current);
    })();
    return () => {
      cancelled = true;
      // Remontagem (troca de peça ou o modo estrito do React): esta limpeza
      // zera a seleção, então a retomada da reserva em montagem vale de novo.
      restoredFor.current = null;
    };
  }, [variant.id]);

  useEffect(() => {
    if (!draftLoaded || restoredFor.current === variant.id) return;
    restoredFor.current = variant.id;
    if (!draft.pickup || fromISO(draft.pickup) < today) return;
    const pickup = fromISO(draft.pickup);
    setSelected(pickup);
    setView(new Date(pickup.getFullYear(), pickup.getMonth(), 1));
    setSundayChoice(draft.returnOption);
  }, [draftLoaded, draft, variant.id, today]);

  /** Retirada e devolução valem para TODAS as peças da reserva em montagem. */
  function persistDates(pickup: Date | null, option: ReturnChoice | null) {
    if (draft.pieces.length > 0) writeDraft(withDates(draft, pickup ? toISO(pickup) : null, option));
  }

  // ---- disponibilidade real do mês exibido ----
  useEffect(() => {
    if (pieces === null || months.has(cacheKey)) return;
    let cancelled = false;
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const last = new Date(view.getFullYear(), view.getMonth() + 1, 0);
    const from = first < today ? today : first;
    const to = last > rangeEnd ? rangeEnd : last;

    void (async () => {
      // Mês inteiro fora da janela: nada a consultar, todos os dias ficam indisponíveis.
      const result = from > to ? { days: [], operationStartDate } : await fetchAvailability(variant.id, pieces, from, to);
      if (cancelled) return;
      if (result) {
        setMonths((prev) => new Map(prev).set(cacheKey, result.days));
        setOperationStartDate(result.operationStartDate ?? null);
        if ('maxPieces' in result && typeof result.maxPieces === 'number') setMaxPieces(result.maxPieces);
        setFailedMonths((prev) => {
          const next = new Set(prev);
          next.delete(cacheKey);
          return next;
        });
      } else {
        setFailedMonths((prev) => new Set(prev).add(cacheKey));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [variant.id, pieces, view, cacheKey, months, today, rangeEnd, operationStartDate]);

  // Só os dias calculados para a quantidade ATUAL de peças (mudar a seleção muda a devolução).
  const dayMap = useMemo(() => {
    const map = new Map<string, AvailabilityDay>();
    for (const [key, monthDays] of months) if (key.startsWith(`${pieces ?? '-'}|`)) for (const d of monthDays) map.set(d.date, d);
    return map;
  }, [months, pieces]);

  const weekdays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) =>
        addDays(WEEKDAY_BASE, i)
          .toLocaleDateString(locale, { weekday: 'short' })
          .replace('.', '')
          .slice(0, 3),
      ),
    [locale],
  );

  const { days, freeCount, padCount, isBeforeOperationStart, isMaxPiecesExceeded } = useMemo(() => {
    const y = view.getFullYear();
    const m = view.getMonth();
    const pad = new Date(y, m, 1).getDay();
    const total = new Date(y, m + 1, 0).getDate();
    const out: { date: Date; info: AvailabilityDay | undefined }[] = [];
    let free = 0;
    let known = 0;
    let beforeStart = 0;
    let maxPiecesExceeded = 0;

    for (let i = 1; i <= total; i++) {
      const date = new Date(y, m, i);
      const info = dayMap.get(toISO(date));
      if (info?.bookable) free++;
      if (info) {
        known++;
        if (info.reason === 'pickup_before_operation_start') beforeStart++;
        if (info.reason === 'max_pieces_exceeded') maxPiecesExceeded++;
      }
      out.push({ date, info });
    }

    // Mês inteiro antes da abertura também conta, mesmo que o motivo informado
    // em cada dia seja outro (ex.: antecedência mínima, avaliada antes).
    const monthBeforeOpening = !!operationStartDate && new Date(y, m, total) < fromISO(operationStartDate);

    return {
      days: out,
      freeCount: free,
      padCount: pad,
      isBeforeOperationStart: known > 0 && free === 0 && (beforeStart > 0 || monthBeforeOpening),
      isMaxPiecesExceeded: known > 0 && free === 0 && maxPiecesExceeded > 0,
    };
  }, [view, dayMap, operationStartDate]);

  const atFirstMonth = monthIndex(view) <= monthIndex(today);
  const atLastMonth = monthIndex(view) >= monthIndex(rangeEnd);

  const selectedInfo = selected ? dayMap.get(toISO(selected)) : undefined;
  const needsSundayChoice = !!selectedInfo?.hasSundayReturnException;
  // Uma só seleção para o resumo E para o carrinho: a data exibida é a enviada.
  const selection = resolveRentalSelection(selectedInfo, sundayChoice);
  const effectiveReturnISO = selection?.return;
  const canSubmit = !!selection;

  function moveFocus(iso: string, step: number) {
    const target = addDays(fromISO(iso), step);
    if (monthIndex(target) < monthIndex(today) || monthIndex(target) > monthIndex(rangeEnd)) return;
    if (monthIndex(target) !== monthIndex(view)) {
      setView(new Date(target.getFullYear(), target.getMonth(), 1));
    }
    requestAnimationFrame(() => {
      gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${toISO(target)}"]`)?.focus();
    });
  }

  async function handleSubmit() {
    // A seleção é lida AGORA, no clique: é exatamente o que o resumo mostra.
    if (!selection || !sku || pieces === null || !summary || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    const previewCents = summary.total.source === 'preview' ? summary.total.cents : null;
    try {
      // Revalida TODAS as peças com a quantidade total e as mesmas datas: as
      // escolhidas e as do carrinho com a mesma retirada (a devolução delas
      // acompanha a da reserva).
      const sameReservation = (cart?.lines ?? [])
        .filter((line) => !selectionIds.has(line.merchandise.id) && !isValePassProduct({ variantId: line.merchandise.id }))
        .filter((line) => line.attributes.some((a) => a.key === '_vsc_pickup' && a.value === selection.pickup))
        .map((line) => ({ variantId: line.merchandise.id, title: line.merchandise.product.title }));
      const toCheck = [...new Map([...selectionPieces, ...sameReservation].map((piece) => [piece.variantId, piece] as const)).values()];
      const unavailable = await unavailablePieces(toCheck, pieces, selection);
      if (unavailable === null) {
        setError('Não foi possível confirmar a disponibilidade de todas as peças agora. Tente novamente.');
        return;
      }
      if (unavailable.length > 0) {
        setError(`Indisponível nestas datas: ${unavailable.join(', ')}. Remova da seleção ou escolha outra data de retirada.`);
        return;
      }
      const updated = await addRentalSelectionToCart({
        pieces: selectionPieces.map((piece) => ({ variantId: piece.variantId, sku: piece.sku })),
        pickup: selection.pickup,
        return: selection.return,
        returnOption: selection.returnOption,
        pickupLabel: fromISO(selection.pickup).toLocaleDateString(locale),
        returnLabel: fromISO(selection.return).toLocaleDateString(locale),
      });
      // Tudo no carrinho: a reserva em montagem acabou. Daqui em diante o
      // resumo mostra o total que a Shopify devolveu, não a prévia.
      setCart(updated);
      setSubmittedPreview(previewCents);
      writeDraft(EMPTY_DRAFT);
      window.dispatchEvent(new Event('closet:cart-added'));
    } catch (err) {
      setError(cartErrorMessage(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  /** Guarda esta peça (e as datas) na reserva em montagem e volta ao catálogo. */
  function handleAddAnother() {
    if (submittingRef.current || otherPieces === null) return;
    const result = addPiece(draft, currentPiece, maxPieces, otherPieces);
    if (!result.added && result.reason === 'limit') {
      setError(limitMessage(maxPieces));
      return;
    }
    writeDraft(withDates(result.draft, selected ? toISO(selected) : null, sundayChoice));
    router.push('/pecas');
  }

  /**
   * Tira uma peça da reserva: da seleção em montagem e, se já estiver no
   * carrinho, também do carrinho (a Shopify devolve o total recalculado). A
   * peça desta página não tem "Remover" — ela é a que está sendo alugada aqui.
   */
  async function handleRemove(row: SummaryRow) {
    if (submittingRef.current || row.variantId === variant.id) return;
    setError(null);
    setSubmittedPreview(null);
    if (row.inSelection) writeDraft(removePiece(draft, row.variantId));
    if (!row.inCart || !cart) return;
    submittingRef.current = true;
    setRemoving(row.variantId);
    try {
      let next: Cart | null = cart;
      for (const line of cart.lines.filter((l) => l.merchandise.id === row.variantId)) next = await removeCartLine(line.id);
      setCart(next);
    } catch {
      setError('Não foi possível remover a peça do carrinho. Tente novamente.');
    } finally {
      submittingRef.current = false;
      setRemoving(null);
    }
  }

  const busy = submitting || removing !== null;
  const selectedUnavailable = !!selected && !!selectedInfo && !selectedInfo.bookable;
  const canAddAnother = !busy && otherPieces !== null && !limitReached && !selectedUnavailable && !loading;
  const total = summary?.total ?? null;
  const showSummary = !!summary && (!!effectiveReturnISO || summary.rows.length > 1);
  const actionTotal =
    showSummary && summary && total && total.source !== 'unknown'
      ? `${formatPrice(total.amount, total.currencyCode, locale)} · ${summary.pieces} ${summary.pieces === 1 ? 'peça' : 'peças'}`
      : null;

  const whatsappHref = whatsapp
    ? `https://wa.me/${whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(
        `Olá! Gostaria de alugar ${productTitle} (código ${sku}). Podem verificar a disponibilidade?`,
      )}`
    : null;

  if (!sku) {
    return (
      <div className="rounded-xl border border-dashed border-marsala/30 p-5 text-sm">
        <strong className="font-medium text-marsala">Peça sem código (SKU)</strong>
        <p className="mt-1 text-ink/60">
          Esta peça ainda não tem código cadastrado. O código é o que identifica a roupa
          física — sem ele não é possível reservar.
        </p>
      </div>
    );
  }

  return (
    <section id="rental-calendar" aria-labelledby="rental-calendar-title" className="rental-calendar rounded-2xl border border-ink/10 bg-cream p-5 sm:p-6">
      <header className="mb-5">
        <h2 id="rental-calendar-title" className="text-[0.95rem] font-semibold uppercase tracking-[0.14em] text-marsala">
          Escolha seu período
        </h2>
        <p className="mt-2 text-[0.8rem] leading-relaxed text-ink/55">
          Selecione a data de retirada. A devolução é calculada pela quantidade de peças.
        </p>
      </header>

      <div className="mb-3 flex items-center justify-between gap-2">
        <NavButton
          label="Mês anterior"
          disabled={atFirstMonth}
          onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}
          d="M15 5l-7 7 7 7"
        />
        <div className="flex-1 text-center text-[0.9rem] font-semibold first-letter:uppercase" aria-live="polite">
          {view.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}
        </div>
        <NavButton
          label="Próximo mês"
          disabled={atLastMonth}
          onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}
          d="M9 5l7 7-7 7"
        />
      </div>

      <div className="grid grid-cols-7 gap-1" aria-hidden>
        {weekdays.map((w) => (
          <span
            key={w}
            className="py-1 text-center text-[0.65rem] font-semibold uppercase tracking-wider text-ink/65"
          >
            {w}
          </span>
        ))}
      </div>

      <div
        ref={gridRef}
        role="group"
        aria-busy={loading}
        aria-label="Calendário de datas de retirada"
        className="mt-1.5 grid min-h-[15rem] grid-cols-7 gap-1"
        onKeyDown={(e) => {
          const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
          const iso = (e.target as HTMLElement).dataset?.date;
          if (!step || !iso) return;
          e.preventDefault();
          moveFocus(iso, step);
        }}
      >
        {loading ? (
          <div className="col-span-7 flex min-h-[15rem] items-center justify-center gap-2 text-[0.8rem] text-ink/50">
            <Spinner />
            Carregando disponibilidade…
          </div>
        ) : loadFailed ? (
          <div className="col-span-7 flex min-h-[15rem] items-center justify-center px-4 text-center text-[0.8rem] text-ink/50">
            Não foi possível consultar a disponibilidade no momento.
          </div>
        ) : (
          <>
            {Array.from({ length: padCount }, (_, i) => (
              <span key={`pad-${i}`} aria-hidden />
            ))}
            {days.map(({ date, info }) => (
              <DayCell
                key={toISO(date)}
                date={date}
                bookable={!!info?.bookable}
                known={!!info}
                locale={locale}
                isToday={sameDay(date, today)}
                isSelected={!!selected && sameDay(date, selected)}
                onSelect={() => {
                  setSelected(date);
                  setSundayChoice(null);
                  persistDates(date, null);
                }}
              />
            ))}
          </>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-3.5 border-t border-ink/10 pt-3.5 text-[0.7rem] text-ink/50">
        <Legend className="border-ink/15 bg-cream">Disponível</Legend>
        <Legend className="border-transparent bg-ink/20">Ocupado</Legend>
        <Legend className="border-marsala bg-marsala">Selecionado</Legend>
      </div>

      {selected && selectedInfo?.bookable && needsSundayChoice && (
        <div className="mt-5 rounded-xl bg-marsala/[0.06] p-4">
          <p className="text-[0.8rem] font-medium text-marsala">
            A devolução calculada cai num domingo — a loja não abre. Escolha uma opção:
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            {selectedInfo.returnOptions?.map((option) => {
              const unavailable = option.available === false;
              return (
                <button
                  key={option.type}
                  type="button"
                  disabled={unavailable || busy}
                  aria-pressed={sundayChoice === option.type}
                  data-return-option={option.type}
                  onClick={() => {
                    setSundayChoice(option.type);
                    persistDates(selected, option.type);
                  }}
                  className={[
                    'flex-1 rounded-lg border px-3.5 py-2.5 text-left text-[0.8rem] transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                    sundayChoice === option.type && !unavailable
                      ? 'border-marsala bg-marsala text-cream'
                      : 'border-ink/15 hover:border-marsala/40',
                  ].join(' ')}
                >
                  <span className="block font-medium">
                    {option.type === 'saturday' ? 'Sábado à noite' : 'Segunda-feira'}
                  </span>
                  <span className="block text-[0.72rem] opacity-80">
                    {fromISO(option.date).toLocaleDateString(locale, LONG_DATE)}
                    {unavailable ? ' · indisponível' : option.window ? ` · ${option.window}` : ''}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[0.7rem] text-marsala/70">Nenhuma diária adicional nessas opções.</p>
        </div>
      )}

      {showSummary && summary && total && (
        <>
          <dl
            className="mt-5 rounded-xl bg-ink/[0.03] p-4"
            data-testid="rental-summary"
            data-pickup={selection?.pickup}
            data-return={effectiveReturnISO}
            data-pieces={pieces ?? undefined}
            data-total-source={total.source}
            data-total={total.source === 'unknown' ? undefined : total.amount}
          >
            <div className="mb-3 border-b border-ink/10 pb-3">
              <dt className="text-[0.75rem] text-ink/50">
                {summary.pieces === 1 ? 'Peça da reserva' : `Peças da reserva (${summary.pieces})`}
              </dt>
              <dd>
                <ul className="mt-1.5 space-y-1" data-testid="selected-pieces">
                  {summary.rows.map((row) => (
                    <li key={row.variantId} data-variant={row.variantId} data-price={row.unitAmount ?? undefined} className="flex items-center justify-between gap-2 text-[0.8rem]">
                      <span className="min-w-0 truncate">
                        {row.variantId === variant.id || !row.handle ? (
                          row.title
                        ) : (
                          <Link href={`/pecas/${row.handle}`} className="hover:text-marsala focus-visible:underline focus-visible:outline-none">{row.title}</Link>
                        )}
                        {row.quantity > 1 && <span className="text-ink/60"> × {row.quantity}</span>}
                        {row.variantId === variant.id ? (
                          <span className="text-ink/45"> · esta peça</span>
                        ) : row.inCart ? (
                          <span className="text-ink/45"> · no carrinho</span>
                        ) : null}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="tabular-nums text-ink/60">
                          {row.unitAmount !== null && row.currencyCode ? formatPrice(row.unitAmount, row.currencyCode, locale) : 'a confirmar'}
                        </span>
                        {row.variantId !== variant.id && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleRemove(row)}
                            aria-label={`Remover ${row.title} da reserva`}
                            className="rounded px-1 text-[0.72rem] text-marsala underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-marsala/40 disabled:opacity-40"
                          >
                            {removing === row.variantId ? 'Removendo…' : 'Remover'}
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
            <SumRow label="Retirada">{selected ? selected.toLocaleDateString(locale, LONG_DATE) : 'escolha no calendário'}</SumRow>
            <SumRow label="Devolução">
              {effectiveReturnISO
                ? fromISO(effectiveReturnISO).toLocaleDateString(locale, LONG_DATE)
                : needsSundayChoice
                  ? 'escolha sábado ou segunda'
                  : 'calculada pela retirada'}
            </SumRow>
            <SumRow label="Período">
              {selectedInfo?.bookable && selectedInfo.durationDays
                ? `${selectedInfo.durationDays} ${selectedInfo.durationDays === 1 ? 'dia' : 'dias'}`
                : '—'}
            </SumRow>
            <div className="mt-1.5 border-t border-ink/10 pt-3">
              <SumRow label={total.source === 'shopify' ? 'Total no carrinho' : 'Total estimado'} emphasis>
                {total.source === 'unknown' ? 'a confirmar' : formatPrice(total.amount, total.currencyCode, locale)}
              </SumRow>
            </div>
          </dl>
          <p
            className="mt-2 text-right text-[0.7rem] leading-relaxed text-ink/50"
            data-testid="total-note"
            data-total-changed={total.source === 'shopify' && submittedPreview !== null && submittedPreview !== total.cents ? 'true' : undefined}
          >
            {totalNote(total, submittedPreview, locale)}
          </p>

          {effectiveReturnISO && (
            <p className="mt-3 text-[0.7rem] leading-relaxed text-ink/50">
              O período é definido pela quantidade de peças ({pieces} no total). Ao adicionar
              mais peças, a devolução é recalculada.
            </p>
          )}
        </>
      )}

      <Status
        tone={loadFailed ? 'error' : freeCount === 0 && !loading ? 'warn' : selected ? 'ok' : null}
      >
        {loadFailed
          ? 'Não conseguimos carregar as datas agora. Fale com o atendimento para confirmar a disponibilidade.'
          : isMaxPiecesExceeded
            ? 'Você atingiu o máximo de peças permitido nesta reserva. Finalize o carrinho atual ou remova uma peça antes de adicionar outra.'
            : isBeforeOperationStart
              ? operationStartDate
                ? `Reservas online disponíveis a partir de ${fromISO(operationStartDate).toLocaleDateString(locale, LONG_DATE)}.`
                : 'Reservas online ainda não disponíveis para estas datas.'
              : freeCount === 0 && !loading
                ? 'Não há datas disponíveis neste mês. Fale com o atendimento para verificar outras opções.'
                : selected && selectedInfo?.bookable
                  ? 'Disponível para retirada nesta data.'
                  : null}
      </Status>

      {selectedUnavailable && draft.pieces.length > 0 && (
        <Status tone="warn">
          Esta peça não está disponível na retirada escolhida para a reserva. Escolha outra data ou{' '}
          <Link href="/pecas" className="underline underline-offset-2">volte ao catálogo</Link> sem ela.
        </Status>
      )}
      {limitReached && <Status tone="warn">{limitMessage(maxPieces)}</Status>}
      {error && <Status tone="error">{error}</Status>}

      <RentalAction>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] gap-2">
        <button
          type="button"
          onClick={handleAddAnother}
          disabled={!canAddAnother}
          data-testid="add-another-piece"
          className="flex w-full items-center justify-center rounded-xl border border-marsala bg-cream px-3 py-2 text-[0.7rem] font-semibold uppercase leading-tight tracking-[0.08em] text-marsala transition-colors hover:bg-marsala/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-marsala/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed"
        >
          Adicionar outra peça
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit || busy}
          className={`flex w-full items-center justify-center gap-2 rounded-xl bg-marsala px-4 ${actionTotal ? 'py-2' : 'py-3.5'} text-[0.8rem] font-semibold uppercase tracking-[0.12em] text-cream transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-marsala/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-35`}
        >
          {submitting && <Spinner light />}
          <span className="flex flex-col items-center leading-tight">
            Alugar agora
            {/* No celular a barra fica fixa por cima do fim do resumo: o total
                vai junto do botão para nunca ficar escondido. */}
            {actionTotal && (
              <span data-testid="action-total" aria-hidden className="mt-0.5 text-[0.68rem] font-medium normal-case tracking-normal opacity-85">
                {actionTotal}
              </span>
            )}
          </span>
        </button>
      </div>
      </RentalAction>

      {whatsappHref && (loadFailed || (freeCount === 0 && !loading)) && !isMaxPiecesExceeded && (
        <a
          href={whatsappHref}
          target="_blank"
          rel="noopener"
          className="mt-3 flex w-full items-center justify-center rounded-xl border border-marsala px-5 py-3.5 text-[0.8rem] font-semibold uppercase tracking-[0.12em] text-marsala transition-colors hover:bg-marsala/5"
        >
          Falar com o atendimento
        </a>
      )}
    </section>
  );
}

/** Diz de onde vem o total exibido: prévia (soma local) ou o carrinho da Shopify (oficial). */
function totalNote(total: SummaryTotal, submittedPreview: number | null, locale: string): string {
  if (total.source === 'shopify') {
    return submittedPreview !== null && submittedPreview !== total.cents
      ? `Total confirmado pela Shopify (a prévia era ${formatPrice(centsToAmount(submittedPreview), total.currencyCode, locale)}).`
      : 'Valor oficial do carrinho (Shopify).';
  }
  if (total.source === 'preview') return 'Prévia: soma de todas as peças. O valor oficial é o do carrinho.';
  return total.reason === 'mixed_currency'
    ? 'Peças em moedas diferentes: o valor é confirmado no carrinho.'
    : 'Uma das peças está sem preço aqui: o valor é confirmado no carrinho.';
}

function limitMessage(maxPieces: number | null): string {
  return maxPieces ? `Você atingiu o máximo de ${maxPieces} peças por reserva.` : 'Você atingiu o máximo de peças por reserva.';
}

/**
 * Nomes das peças que NÃO cabem nas datas escolhidas (com a quantidade total de
 * peças). `null` = não deu para confirmar (API fora do ar): não adiciona nada.
 */
async function unavailablePieces(pieces: readonly { variantId: string; title: string }[], countedPieces: number, selection: RentalSelection): Promise<string[] | null> {
  const pickup = fromISO(selection.pickup);
  const checks = await Promise.all(
    pieces.map(async (piece) => {
      const result = await fetchAvailability(piece.variantId, countedPieces, pickup, pickup);
      if (!result) return null;
      const day = result.days.find((d) => d.date === selection.pickup);
      const same = resolveRentalSelection(day, selection.returnOption);
      return same && same.return === selection.return ? '' : piece.title;
    }),
  );
  if (checks.some((check) => check === null)) return null;
  return checks.filter((check): check is string => !!check);
}

/**
 * Mensagem de falha ao adicionar ao carrinho. Produção: amigável (e específica
 * quando a Shopify não manteve a peça). Desenvolvimento: também a causa real.
 */
function cartErrorMessage(err: unknown): string {
  const friendly =
    err instanceof CartError && err.code === 'not_added'
      ? 'Esta peça não está disponível na loja para estas datas agora. Fale com o atendimento.'
      : 'Não foi possível adicionar ao carrinho. Tente novamente.';
  if (process.env.NODE_ENV === 'production') return friendly;
  return `${friendly} [dev: ${err instanceof Error ? err.message : String(err)}]`;
}

const LONG_DATE: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
};

/**
 * Consulta a disponibilidade real. Sem fallback inventado: por padrão usa
 * o proxy same-origin do Next; uma URL pública explícita continua aceita.
 * `new URL(base, window.location.origin)` suporta os dois formatos e evita
 * o crash que ocorria com `new URL('/api/availability')`.
 */
async function fetchAvailability(
  shopifyVariantId: string,
  countedPieces: number,
  from: Date,
  to: Date,
): Promise<AvailabilityResponse | null> {
  const base = process.env.NEXT_PUBLIC_AVAILABILITY_URL?.trim() || '/api/availability';
  const url = new URL(base, window.location.origin);
  url.searchParams.set('shopifyVariantId', shopifyVariantId);
  url.searchParams.set('countedPieces', String(countedPieces));
  url.searchParams.set('from', toISO(from));
  url.searchParams.set('to', toISO(to));

  try {
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as AvailabilityResponse;
  } catch {
    return null;
  }
}

function DayCell({
  date,
  bookable,
  known,
  locale,
  isToday,
  isSelected,
  onSelect,
}: {
  date: Date;
  bookable: boolean;
  known: boolean;
  locale: string;
  isToday: boolean;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const human = date.toLocaleDateString(locale, { day: 'numeric', month: 'long' });
  const disabled = !bookable;
  const label = disabled ? `${human} — indisponível` : human;

  return (
    <button
      type="button"
      data-date={toISO(date)}
      aria-pressed={isSelected}
      disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onClick={onSelect}
      aria-label={label}
      className={[
        'grid aspect-square min-h-[2.75rem] place-items-center rounded-lg border text-sm tabular-nums transition-colors sm:min-h-0',
        isToday ? 'font-bold' : '',
        isSelected
          ? 'border-marsala bg-marsala font-semibold text-cream'
          : !known
            ? 'cursor-not-allowed border-transparent text-ink/25'
            : disabled
              ? 'cursor-not-allowed border-transparent text-ink/65 line-through'
              : 'border-transparent hover:border-marsala/25 hover:bg-marsala/[0.06]',
      ].join(' ')}
    >
      {date.getDate()}
    </button>
  );
}

function NavButton({
  label,
  d,
  onClick,
  disabled,
}: {
  label: string;
  d: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-ink/12 transition-colors hover:bg-marsala/[0.06] disabled:cursor-not-allowed disabled:opacity-30"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
        <path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

function Legend({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i className={`h-2.5 w-2.5 rounded-full border ${className}`} />
      {children}
    </span>
  );
}

function SumRow({
  label,
  emphasis,
  children,
}: {
  label: string;
  emphasis?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-sm">
      <dt className="text-ink/55">{label}</dt>
      <dd
        className={`m-0 text-right font-semibold tabular-nums ${
          emphasis ? 'text-lg text-marsala' : ''
        }`}
      >
        {children}
      </dd>
    </div>
  );
}

function Status({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'error' | null;
  children: React.ReactNode;
}) {
  if (!tone || !children) return null;
  const styles = {
    ok: 'bg-emerald-700/10 text-emerald-800',
    warn: 'bg-marsala/[0.09] text-marsala',
    error: 'bg-red-700/10 text-red-800',
  }[tone];
  return (
    <div role="status" className={`mt-4 rounded-xl px-3.5 py-3 text-[0.8rem] leading-relaxed ${styles}`}>
      {children}
    </div>
  );
}

function Spinner({ light }: { light?: boolean }) {
  return (
    <span
      aria-hidden
      className={`h-3.5 w-3.5 animate-spin rounded-full border-2 border-t-transparent ${
        light ? 'border-cream' : 'border-current'
      }`}
    />
  );
}
