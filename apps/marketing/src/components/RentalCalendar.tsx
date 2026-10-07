'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { addDays, fromISO, sameDay, startOfDay, toISO } from '@/lib/rental-rules';
import {
  CartError,
  addRentalSelectionToCart,
  fetchVariantStock,
  getCart,
  isCartConfigured,
  removeCartLine,
  type Cart,
} from '@/lib/cart';
import { UNKNOWN_STOCK, shopifyStockText, type ShopifyStock } from '@/lib/shopify-stock';
import {
  AVAILABILITY_PROXY_PATH,
  availabilityFailureMessage,
  fetchAvailability as requestAvailability,
  type AvailabilityDay,
  type AvailabilityFailure,
} from '@/lib/availability-client';
import {
  GENERIC_UNAVAILABLE_MESSAGE,
  SHOPIFY_UNAVAILABLE_MESSAGE,
  unavailableExplanation,
} from '@/lib/unavailable-reason';
import {
  resolveRentalSelection,
  type RentalSelection,
  type ReturnChoice,
} from '@/lib/rental-selection';
import {
  EMPTY_DRAFT,
  addPiece,
  atPieceLimit,
  removePiece,
  selectionWith,
  withDates,
  withReturn,
  type DraftPiece,
} from '@/lib/rental-draft';
import {
  centsToAmount,
  reservationSummary,
  type ReservationSummary,
  type SummaryRow,
  type SummaryTotal,
} from '@/lib/rental-price';
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
 * reservar — nunca marca data como livre nem como ocupada sem resposta válida
 * (lib/availability-client.ts confere o formato, o prazo e o cancelamento). O
 * padrão é o proxy same-origin `/api/availability`; nenhuma URL localhost é
 * gravada no bundle de produção.
 */

const WEEKDAY_BASE = new Date(2024, 0, 7); // um domingo
/** Janela de reserva: dias a partir da primeira retirada possível — hoje, ou
 *  o início da operação configurado no ClosetAdmin, o que vier depois. */
const RANGE_DAYS = 120;

const monthIndex = (d: Date) => d.getFullYear() * 12 + d.getMonth();
const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

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
    () => ({
      variantId: variant.id,
      sku,
      title: productTitle,
      handle: productHandle,
      priceAmount,
      currencyCode: priceCurrency,
    }),
    [variant.id, sku, productTitle, productHandle, priceAmount, priceCurrency],
  );
  const selectionPieces = useMemo(() => selectionWith(draft, currentPiece), [draft, currentPiece]);

  const [view, setView] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [selected, setSelected] = useState<Date | null>(null);
  /** Data indisponível que o cliente tocou: só mostra o motivo (não vira a retirada). */
  const [inspected, setInspected] = useState<Date | null>(null);
  const [sundayChoice, setSundayChoice] = useState<ReturnChoice | null>(null);
  /** Carrinho da Shopify (fonte de verdade do valor); `undefined` enquanto é lido, `null` = sem carrinho. */
  const [cart, setCart] = useState<Cart | null | undefined>(undefined);
  const [maxPieces, setMaxPieces] = useState<number | null>(null);
  /** Disponibilidade por mês e quantidade de peças (`peças|YYYY-MM`), carregada quando o mês é exibido. */
  const [months, setMonths] = useState<ReadonlyMap<string, AvailabilityDay[]>>(() => new Map());
  /** Meses cuja consulta falhou (e por quê). Falha nunca vira data livre nem ocupada. */
  const [failures, setFailures] = useState<ReadonlyMap<string, { failure: AvailabilityFailure; status?: number }>>(
    () => new Map(),
  );
  const [operationStartDate, setOperationStartDate] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Peça sendo removida do carrinho (variante). */
  const [removing, setRemoving] = useState<string | null>(null);
  /** Prévia (centavos) mostrada no clique de "Alugar agora", para avisar se a Shopify confirmou outro total. */
  const [submittedPreview, setSubmittedPreview] = useState<number | null>(null);
  /** Estoque comercial ATUAL na Shopify (consulta sem cache no navegador); `null` enquanto confere. */
  const [shopifyStock, setShopifyStock] = useState<ShopifyStock | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Trava síncrona: dois cliques seguidos nunca viram duas inclusões.
  const submittingRef = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  /** O cliente pediu "Tentar novamente": se falhar de novo, o foco volta ao botão. */
  const retriedRef = useRef(false);

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
  const selectionIds = useMemo(
    () => new Set(selectionPieces.map((piece) => piece.variantId)),
    [selectionPieces],
  );
  const rentalCart = useMemo(() => {
    if (!cart) return null;
    const lines = cart.lines.filter(
      (line) => !isValePassProduct({ variantId: line.merchandise.id }),
    );
    // Se algo que não é aluguel estivesse no carrinho, o total dele não seria o da reserva.
    return { lines, cost: lines.length === cart.lines.length ? cart.cost : null };
  }, [cart]);
  const summary = useMemo<ReservationSummary | null>(
    () => (cart === undefined ? null : reservationSummary(selectionPieces, rentalCart)),
    [cart, rentalCart, selectionPieces],
  );
  const pieces = summary ? summary.pieces : null;
  const otherPieces = pieces === null ? null : pieces - selectionPieces.length;
  const limitReached =
    otherPieces !== null && atPieceLimit(selectionPieces.length, otherPieces, maxPieces);

  const viewKey = monthKey(view);
  // Por variante, quantidade de peças e mês: dado de outra peça nunca aparece nesta.
  const cachePrefix = `${variant.id}|${pieces ?? '-'}|`;
  const cacheKey = `${cachePrefix}${viewKey}`;
  const failure = failures.get(cacheKey) ?? null;
  const loadFailed = failure !== null;
  const hasMonth = months.has(cacheKey);
  const loading = pieces === null || (!hasMonth && !loadFailed);

  // ---- reserva em montagem: retoma retirada e opção de devolução (uma vez por montagem) ----
  const restoredFor = useRef<string | null>(null);

  // ---- peças no carrinho (uma vez por variante) ----
  useEffect(() => {
    let cancelled = false;
    setCart(undefined);
    setSubmittedPreview(null);
    setMonths(new Map());
    setFailures(new Map());
    setSelected(null);
    setInspected(null);
    setSundayChoice(null);
    setError(null);

    void (async () => {
      const current = isCartConfigured ? await getCart().catch(() => null) : null;
      if (!cancelled) setCart(current);
    })();
    // Estoque comercial sempre fresco: o `availableForSale` da página vem do
    // cache (ISR) e já bloqueou peça com 199 unidades à venda.
    setShopifyStock(null);
    void (async () => {
      const stock = isCartConfigured
        ? ((await fetchVariantStock([variant.id])).get(variant.id) ?? UNKNOWN_STOCK)
        : UNKNOWN_STOCK;
      if (!cancelled) setShopifyStock(stock);
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
    if (draft.pieces.length > 0)
      writeDraft(withDates(draft, pickup ? toISO(pickup) : null, option));
  }

  // ---- disponibilidade real do mês exibido ----
  // Valores que a consulta lê mas que NÃO devem dispará-la de novo (senão a
  // resposta de um mês refaria a consulta do outro).
  const windowRef = useRef({ view, today, rangeEnd });
  useEffect(() => {
    windowRef.current = { view, today, rangeEnd };
  }, [view, today, rangeEnd]);

  useEffect(() => {
    if (pieces === null || hasMonth || loadFailed) return;
    const { view: month, today: now, rangeEnd: limit } = windowRef.current;
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    const from = first < now ? now : first;
    const to = last > limit ? limit : last;

    // Mês inteiro fora da janela: nada a consultar, todos os dias ficam indisponíveis.
    if (from > to) {
      setMonths((prev) => new Map(prev).set(cacheKey, []));
      return;
    }

    // Trocar de mês/peça cancela a consulta anterior (e o prazo dela).
    const controller = new AbortController();
    void (async () => {
      const result = await requestAvailability(
        { variantId: variant.id, countedPieces: pieces, from: toISO(from), to: toISO(to) },
        availabilityOptions(controller.signal),
      );
      if (controller.signal.aborted) return;
      if (result.ok) {
        retriedRef.current = false;
        setMonths((prev) => new Map(prev).set(cacheKey, result.data.days));
        setOperationStartDate(result.data.operationStartDate ?? null);
        if (typeof result.data.maxPieces === 'number') setMaxPieces(result.data.maxPieces);
      } else {
        setFailures((prev) => new Map(prev).set(cacheKey, { failure: result.failure, status: result.status }));
      }
    })();
    return () => controller.abort();
  }, [variant.id, pieces, cacheKey, hasMonth, loadFailed]);

  /** "Tentar novamente": repete a consulta deste mês, sem recarregar a página. */
  const retryAvailability = useCallback(() => {
    retriedRef.current = true;
    setFailures((prev) => {
      if (!prev.has(cacheKey)) return prev;
      const next = new Map(prev);
      next.delete(cacheKey);
      return next;
    });
  }, [cacheKey]);

  // Depois de uma nova tentativa que falha de novo, o foco volta ao botão.
  useEffect(() => {
    if (loadFailed && retriedRef.current) retryRef.current?.focus();
  }, [loadFailed]);

  // Só os dias calculados para a quantidade ATUAL de peças (mudar a seleção muda a devolução).
  const dayMap = useMemo(() => {
    const map = new Map<string, AvailabilityDay>();
    for (const [key, monthDays] of months)
      if (key.startsWith(cachePrefix)) for (const d of monthDays) map.set(d.date, d);
    return map;
  }, [months, cachePrefix]);

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
    const monthBeforeOpening =
      !!operationStartDate && new Date(y, m, total) < fromISO(operationStartDate);

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
  // Sem consulta válida do mês exibido não há reserva: nada de "Alugar agora" às cegas.
  const canSubmit = !!selection && !loadFailed;

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
    if (!selection || !sku || pieces === null || !summary || submittingRef.current || loadFailed) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    const previewCents = summary.total.source === 'preview' ? summary.total.cents : null;
    // Revalida TODAS as peças com a quantidade total e as mesmas datas: as
    // escolhidas e as do carrinho com a mesma retirada (a devolução delas
    // acompanha a da reserva).
    const sameReservation = (cart?.lines ?? [])
      .filter(
        (line) =>
          !selectionIds.has(line.merchandise.id) &&
          !isValePassProduct({ variantId: line.merchandise.id }),
      )
      .filter((line) =>
        line.attributes.some((a) => a.key === '_vsc_pickup' && a.value === selection.pickup),
      )
      .map((line) => ({ variantId: line.merchandise.id, title: line.merchandise.product.title }));
    const toCheck: { variantId: string; title: string }[] = [
      ...new Map(
        [...selectionPieces, ...sameReservation].map((piece) => [piece.variantId, piece] as const),
      ).values(),
    ];
    try {
      const unavailable = await unavailablePieces(toCheck, pieces, selection);
      if (unavailable === null) {
        setError(
          'Não foi possível confirmar a disponibilidade de todas as peças agora. Tente novamente.',
        );
        return;
      }
      if (unavailable.length > 0) {
        // Nada vai ao carrinho; diz qual peça e o motivo real (API do ClosetAdmin).
        const detail = unavailable.map((piece) => `${piece.title}: ${piece.message}`).join(' ');
        setError(
          `Indisponível para esta data — ${detail} Nenhuma peça foi adicionada; remova da seleção ou escolha outra data de retirada.`,
        );
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
      // Só aqui (Shopify confirmou cada peça com quantidade > 0) a seleção vira
      // carrinho: limpa o rascunho e avisa a gaveta quantas peças entraram.
      writeDraft(EMPTY_DRAFT);
      window.dispatchEvent(
        new CustomEvent('closet:cart-added', { detail: { pieces: toCheck.length } }),
      );
    } catch (err) {
      // Falhou: rascunho intacto (nada foi confirmado) e o erro diz quais peças.
      const titles = new Map(toCheck.map((piece) => [piece.variantId, piece.title] as const));
      setError(cartErrorMessage(err, titles));
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
    // Só rascunho (nada vai à Shopify aqui). A devolução exibida no catálogo vale
    // enquanto a quantidade for a mesma do cálculo (sem outras peças no carrinho).
    const dated = withDates(result.draft, selected ? toISO(selected) : null, sundayChoice);
    writeDraft(
      otherPieces === 0 && effectiveReturnISO
        ? withReturn(dated, effectiveReturnISO, dated.pieces.length)
        : dated,
    );
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
      for (const line of cart.lines.filter((l) => l.merchandise.id === row.variantId))
        next = await removeCartLine(line.id);
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
  const inspectedExplanation = inspected
    ? unavailableExplanation(dayMap.get(toISO(inspected)))
    : null;
  // Só a Shopify AGORA (consulta fresca) confirmando que a variante não está à
  // venda bloqueia; dado do cache da página, erro, timeout ou falta de número, não.
  const soldOut = shopifyStock?.status === 'sold_out';
  const canAddAnother =
    !busy &&
    otherPieces !== null &&
    !limitReached &&
    !selectedUnavailable &&
    !loading &&
    !loadFailed &&
    !soldOut;
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
          Esta peça ainda não tem código cadastrado. O código é o que identifica a roupa física —
          sem ele não é possível reservar.
        </p>
      </div>
    );
  }

  return (
    <section
      id="rental-calendar"
      aria-labelledby="rental-calendar-title"
      className="rental-calendar relative rounded-3xl border border-ink/5 bg-white p-6 sm:p-8 shadow-sm"
    >
      <header className="mb-6 flex flex-col gap-1.5">
        <h2 id="rental-calendar-title" className="text-lg font-heading text-marsala leading-none">
          Escolha seu período
        </h2>
        <p className="text-[0.8rem] text-ink/50">
          Selecione a data de retirada. A devolução é calculada de acordo com as peças.
        </p>
      </header>

      <div className="mb-4 flex items-center justify-between gap-2 px-1">
        <NavButton
          label="Mês anterior"
          disabled={atFirstMonth}
          onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}
          d="M15 5l-7 7 7 7"
        />
        <div
          className="flex-1 text-center text-[0.95rem] font-semibold text-marsala first-letter:uppercase tracking-wide"
          aria-live="polite"
        >
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
        tabIndex={-1}
        aria-busy={loading}
        aria-label="Calendário de datas de retirada"
        data-testid="availability-grid"
        data-state={loading ? 'loading' : loadFailed ? 'error' : 'ready'}
        className="mt-1.5 grid min-h-[15rem] grid-cols-7 gap-1 focus:outline-none"
        onKeyDown={(e) => {
          const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
          const iso = (e.target as HTMLElement).dataset?.date;
          if (!step || !iso) return;
          e.preventDefault();
          moveFocus(iso, step);
        }}
      >
        {loading ? (
          <>
            <span className="sr-only" role="status">
              Carregando a disponibilidade…
            </span>
            {Array.from({ length: 31 }, (_, i) => (
              <div
                key={`skel-${i}`}
                className="aspect-square min-h-[2.75rem] animate-pulse rounded-xl bg-ink/5 sm:min-h-0"
                aria-hidden="true"
              />
            ))}
          </>
        ) : loadFailed ? (
          <div
            role="alert"
            data-testid="availability-error"
            data-failure={failure.failure}
            data-status={failure.status}
            className="col-span-7 flex min-h-[15rem] flex-col items-center justify-center p-6 text-center text-[0.82rem] text-ink/60"
          >
            <span className="mb-2 rounded-full bg-marsala/10 px-3 py-1 text-xs font-semibold text-marsala">
              Aviso
            </span>
            <p className="font-medium text-marsala">
              Não foi possível consultar a disponibilidade no momento.
            </p>
            <p className="mt-1 text-[0.75rem] text-ink/60">
              {availabilityFailureMessage(failure.failure, failure.status)} Isso não significa que as datas estejam ocupadas.
            </p>
            <button
              ref={retryRef}
              type="button"
              data-testid="availability-retry"
              onClick={retryAvailability}
              className="mt-4 inline-flex min-h-[2.75rem] items-center justify-center rounded-xl border border-marsala px-5 py-2.5 text-[0.75rem] font-semibold uppercase tracking-[0.12em] text-marsala transition-colors hover:bg-marsala/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-marsala"
            >
              Tentar novamente
            </button>
            <p className="mt-3 text-[0.72rem] text-ink/50">
              Se continuar, fale com o atendimento para confirmar a data.
            </p>
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
                isInspected={!!inspected && sameDay(date, inspected)}
                onSelect={() => {
                  setInspected(null);
                  setSelected(date);
                  setSundayChoice(null);
                  persistDates(date, null);
                }}
                onInspect={() => setInspected(date)}
              />
            ))}
          </>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-4 text-[0.7rem] font-medium tracking-wide text-ink/60">
        <Legend className="border-ink/10 bg-white">Disponível</Legend>
        <Legend className="border-transparent bg-ink/5">Ocupado</Legend>
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
          <p className="mt-2 text-[0.7rem] text-marsala/70">
            Nenhuma diária adicional nessas opções.
          </p>
        </div>
      )}

      {showSummary && summary && total && (
        <div className="mt-8 rounded-2xl bg-cream/40 p-5 sm:p-6 border border-ink/5">
          <dl
            data-testid="rental-summary"
            data-pickup={selection?.pickup}
            data-return={effectiveReturnISO}
            data-pieces={pieces ?? undefined}
            data-total-source={total.source}
            data-total={total.source === 'unknown' ? undefined : total.amount}
          >
            <div className="mb-4 border-b border-ink/5 pb-4">
              <dt className="text-[0.7rem] uppercase tracking-widest font-semibold text-ink/40 mb-3">
                {summary.pieces === 1 ? 'Sua reserva' : `Sua reserva (${summary.pieces} peças)`}
              </dt>
              <dd>
                <ul className="space-y-2.5" data-testid="selected-pieces">
                  {summary.rows.map((row) => (
                    <li
                      key={row.variantId}
                      data-variant={row.variantId}
                      data-price={row.unitAmount ?? undefined}
                      className="flex items-start justify-between gap-4 text-[0.85rem]"
                    >
                      <span className="min-w-0 flex-1 leading-tight">
                        {row.variantId === variant.id || !row.handle ? (
                          <span className="font-medium text-ink/80">{row.title}</span>
                        ) : (
                          <Link
                            href={`/pecas/${row.handle}`}
                            className="font-medium text-ink/80 hover:text-marsala focus-visible:underline focus-visible:outline-none transition-colors"
                          >
                            {row.title}
                          </Link>
                        )}
                        {row.quantity > 1 && (
                          <span className="text-ink/50 ml-1">× {row.quantity}</span>
                        )}

                        <span className="block mt-0.5 text-[0.7rem] text-ink/40">
                          {row.variantId === variant.id
                            ? 'Esta peça'
                            : row.inCart
                              ? 'No carrinho'
                              : ''}
                        </span>
                      </span>

                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <span className="font-mono text-[0.8rem] font-bold text-marsala tabular-nums">
                          {row.unitAmount !== null && row.currencyCode
                            ? formatPrice(row.unitAmount, row.currencyCode, locale)
                            : 'A confirmar'}
                        </span>
                        {row.variantId !== variant.id && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleRemove(row)}
                            aria-label={`Remover ${row.title} da reserva`}
                            className="text-[0.65rem] uppercase tracking-wider text-ink/40 transition hover:text-red-600 focus-visible:text-red-600 disabled:opacity-40"
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

            <div className="space-y-2">
              <SumRow label="Retirada">
                {selected
                  ? selected.toLocaleDateString(locale, LONG_DATE)
                  : 'Escolha no calendário'}
              </SumRow>
              <SumRow label="Devolução">
                {effectiveReturnISO
                  ? fromISO(effectiveReturnISO).toLocaleDateString(locale, LONG_DATE)
                  : needsSundayChoice
                    ? 'Escolha sábado ou segunda'
                    : 'Calculada pela retirada'}
              </SumRow>
              <SumRow label="Período">
                {selectedInfo?.bookable && selectedInfo.durationDays
                  ? `${selectedInfo.durationDays} ${selectedInfo.durationDays === 1 ? 'dia' : 'dias'}`
                  : '—'}
              </SumRow>
            </div>

            <div className="mt-5 border-t border-ink/10 pt-5">
              <SumRow
                label={total.source === 'shopify' ? 'Total da reserva' : 'Total estimado'}
                emphasis
              >
                {total.source === 'unknown'
                  ? 'A confirmar'
                  : formatPrice(total.amount, total.currencyCode, locale)}
              </SumRow>
            </div>
          </dl>

          <p
            className="mt-3 text-center text-[0.7rem] leading-relaxed text-ink/40"
            data-testid="total-note"
            data-total-changed={
              total.source === 'shopify' &&
              submittedPreview !== null &&
              submittedPreview !== total.cents
                ? 'true'
                : undefined
            }
          >
            {totalNote(total, submittedPreview, locale)}
          </p>

          {effectiveReturnISO && (
            <p className="mt-4 flex items-start gap-2.5 rounded-lg bg-white/60 p-3 text-[0.7rem] leading-relaxed text-ink/50 border border-ink/5">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-ink/10 text-[10px] font-bold text-ink/70">
                i
              </span>
              <span>
                O período é definido pela quantidade de peças ({pieces} no total). Ao adicionar mais
                peças, a devolução pode ser recalculada.
              </span>
            </p>
          )}
        </div>
      )}

      <Status tone={loadFailed ? null : freeCount === 0 && !loading ? 'warn' : selected ? 'ok' : null}>
        {loadFailed
          ? null
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

      {inspectedExplanation && (
        <div
          data-testid="unavailable-reason"
          role="status"
          className="mt-4 rounded-xl bg-marsala/[0.09] px-3.5 py-3 text-[0.8rem] leading-relaxed text-marsala"
        >
          <p className="font-medium">{inspectedExplanation.message}</p>
          {inspectedExplanation.extra ? (
            <p className="mt-1 text-[0.72rem] opacity-80">{inspectedExplanation.extra}</p>
          ) : null}
        </div>
      )}
      {selectedUnavailable && (
        <Status tone="warn">
          {unavailableExplanation(selectedInfo)?.message ?? GENERIC_UNAVAILABLE_MESSAGE}
          {draft.pieces.length > 0 && (
            <>
              {' '}
              Escolha outra retirada ou{' '}
              <Link href="/pecas" className="underline underline-offset-2">
                volte ao catálogo
              </Link>{' '}
              sem esta peça.
            </>
          )}
        </Status>
      )}
      {/* Estoque comercial (Shopify) é separado da disponibilidade da data (agenda do ClosetAdmin). */}
      {soldOut ? (
        <Status tone="warn">{SHOPIFY_UNAVAILABLE_MESSAGE}</Status>
      ) : (
        <p
          data-testid="shopify-stock"
          data-status={shopifyStock?.status ?? 'checking'}
          className="mt-3 text-[0.72rem] text-ink/55"
        >
          {shopifyStockText(shopifyStock)}
        </p>
      )}
      {limitReached && <Status tone="warn">{limitMessage(maxPieces)}</Status>}
      {error && <Status tone="error">{error}</Status>}

      <RentalAction>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-8">
          <button
            type="button"
            onClick={handleAddAnother}
            disabled={!canAddAnother}
            data-testid="add-another-piece"
            className="flex w-full items-center justify-center rounded-xl bg-white border border-marsala/20 px-6 py-4 text-[0.75rem] font-bold uppercase tracking-[0.12em] text-marsala transition-all hover:bg-marsala/5 hover:border-marsala active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
          >
            Mais uma peça
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || busy || soldOut || loading}
            className={`flex w-full items-center justify-center gap-3 rounded-xl bg-marsala px-6 py-4 text-[0.75rem] font-bold uppercase tracking-[0.12em] text-cream transition-all hover:bg-marsala-glow hover:shadow-[0_0_20px_rgba(83,19,30,0.3)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 disabled:hover:shadow-none`}
          >
            {submitting && <Spinner light />}
            <span className="flex flex-col items-center leading-none gap-1">
              <span>Alugar agora</span>
              {actionTotal && (
                <span
                  data-testid="action-total"
                  aria-hidden
                  className="text-[0.65rem] font-medium opacity-80"
                >
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
  if (total.source === 'preview')
    return 'Prévia: soma de todas as peças. O valor oficial é o do carrinho.';
  return total.reason === 'mixed_currency'
    ? 'Peças em moedas diferentes: o valor é confirmado no carrinho.'
    : 'Uma das peças está sem preço aqui: o valor é confirmado no carrinho.';
}

function limitMessage(maxPieces: number | null): string {
  return maxPieces
    ? `Você atingiu o máximo de ${maxPieces} peças por reserva.`
    : 'Você atingiu o máximo de peças por reserva.';
}

/**
 * Peças que NÃO cabem nas datas escolhidas (com a quantidade total de peças),
 * com o motivo real devolvido pela API. `null` = não deu para confirmar (API
 * fora do ar): não adiciona nada.
 */
async function unavailablePieces(
  pieces: readonly { variantId: string; title: string }[],
  countedPieces: number,
  selection: RentalSelection,
): Promise<{ title: string; message: string }[] | null> {
  const checks = await Promise.all(
    pieces.map(async (piece) => {
      const result = await requestAvailability(
        { variantId: piece.variantId, countedPieces, from: selection.pickup, to: selection.pickup },
        availabilityOptions(),
      );
      if (!result.ok) return null;
      const day = result.data.days.find((d) => d.date === selection.pickup);
      const same = resolveRentalSelection(day, selection.returnOption);
      if (same && same.return === selection.return) return { ok: true as const };
      return {
        ok: false as const,
        title: piece.title,
        message: unavailableExplanation(day)?.message ?? GENERIC_UNAVAILABLE_MESSAGE,
      };
    }),
  );
  if (checks.some((check) => check === null)) return null;
  return checks.flatMap((check) =>
    check && !check.ok ? [{ title: check.title, message: check.message }] : [],
  );
}

/**
 * Mensagem de falha ao adicionar ao carrinho. Produção: amigável (e específica
 * quando a Shopify não manteve a peça). Desenvolvimento: também a causa real.
 */
function cartErrorMessage(err: unknown, titles: ReadonlyMap<string, string> = new Map()): string {
  const rejected =
    err instanceof CartError ? err.variantIds.map((id) => titles.get(id) ?? 'peça').join(', ') : '';
  const friendly =
    err instanceof CartError && err.code === 'not_added'
      ? rejected
        ? `${SHOPIFY_UNAVAILABLE_MESSAGE.replace(/\.$/, '')}: ${rejected}. Nenhuma peça foi adicionada — remova da seleção ou fale com o atendimento.`
        : 'Esta peça não está disponível na loja para estas datas agora. Fale com o atendimento.'
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
 * Opções da consulta no navegador: o padrão é o proxy same-origin do Next; uma
 * URL pública explícita (NEXT_PUBLIC_AVAILABILITY_URL) continua aceita e, se
 * falhar por rede/CORS, cai no proxy do próprio site. URL inválida vira falha
 * de configuração (nunca um calendário carregando para sempre).
 */
function availabilityOptions(signal?: AbortSignal) {
  const configured = process.env.NEXT_PUBLIC_AVAILABILITY_URL?.trim() || AVAILABILITY_PROXY_PATH;
  return {
    base: configured,
    fallbackBase: AVAILABILITY_PROXY_PATH,
    origin: window.location.origin,
    signal,
  };
}

function DayCell({
  date,
  bookable,
  known,
  locale,
  isToday,
  isSelected,
  isInspected,
  onSelect,
  onInspect,
}: {
  date: Date;
  bookable: boolean;
  known: boolean;
  locale: string;
  isToday: boolean;
  isSelected: boolean;
  isInspected: boolean;
  onSelect: () => void;
  onInspect: () => void;
}) {
  const human = date.toLocaleDateString(locale, { day: 'numeric', month: 'long' });
  const disabled = !bookable;
  const label = disabled ? `${human} — indisponível${known ? ', ver motivo' : ''}` : human;

  return (
    <button
      type="button"
      data-date={toISO(date)}
      data-bookable={bookable ? 'true' : 'false'}
      aria-pressed={isSelected}
      disabled={!known}
      onClick={bookable ? onSelect : onInspect}
      aria-label={label}
      className={[
        'relative grid aspect-square min-h-[2.75rem] place-items-center rounded-xl border text-sm tabular-nums transition-all duration-200 sm:min-h-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-marsala',
        isToday ? 'font-bold' : '',
        isSelected
          ? 'border-marsala bg-marsala font-semibold text-cream shadow-md scale-105 z-[1]'
          : !known
            ? 'cursor-not-allowed border-transparent text-ink/20'
            : disabled
              ? `cursor-help border-transparent text-ink/50 bg-ink/[0.03] line-through ${isInspected ? 'ring-2 ring-marsala/60 bg-marsala/10 text-marsala font-medium' : ''}`
              : 'border-ink/10 bg-cream hover:border-marsala/40 hover:bg-marsala/[0.07] hover:scale-105 hover:shadow-sm text-ink',
      ].join(' ')}
    >
      <span>{date.getDate()}</span>
      {isToday && !isSelected && (
        <span className="absolute bottom-1 h-1 w-1 rounded-full bg-marsala" aria-hidden="true" />
      )}
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
        <path
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
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
    <div
      role="status"
      className={`mt-4 rounded-xl px-3.5 py-3 text-[0.8rem] leading-relaxed ${styles}`}
    >
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
