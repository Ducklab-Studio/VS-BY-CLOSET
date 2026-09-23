'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { addDays, fromISO, sameDay, startOfDay, toISO } from '@/lib/rental-rules';
import { addRentalToCart, countPiecesInCart, isCartConfigured } from '@/lib/cart';
import { formatPrice, type StorefrontVariant } from '@/lib/shopify';
import { RentalAction } from './RentalAction';

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
const RANGE_DAYS = 120;

interface ReturnOption {
  type: 'saturday' | 'mondayMorning';
  date: string;
  window?: string;
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
  days: AvailabilityDay[];
}

export function RentalCalendar({
  variant,
  productTitle,
  locale = 'pt-BR',
  whatsapp,
}: {
  variant: StorefrontVariant;
  productTitle: string;
  locale?: string;
  whatsapp?: string;
}) {
  const sku = variant.sku ?? '';
  const today = useMemo(() => startOfDay(new Date()), []);

  const [view, setView] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [selected, setSelected] = useState<Date | null>(null);
  const [sundayChoice, setSundayChoice] = useState<'saturday' | 'mondayMorning' | null>(null);
  const [data, setData] = useState<AvailabilityResponse | null>(null);
  const [pieces, setPieces] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const rangeEnd = useMemo(() => addDays(today, RANGE_DAYS), [today]);

  // ---- carga: peças no carrinho, depois disponibilidade real ----
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setLoadFailed(false);
      setData(null);
      setError(null);

      const cartPieces = isCartConfigured ? await countPiecesInCart().catch(() => 0) : 0;
      if (cancelled) return;

      // Não limita artificialmente em 6 aqui. Se o cliente já estiver no
      // máximo, o backend precisa receber a quantidade prospectiva real e
      // responder `max_pieces_exceeded`; capar em 6 permitia uma 7ª peça
      // parecer disponível no calendário e só falhar muito depois.
      const countedPieces = cartPieces + 1;

      setPieces(countedPieces);
      setSelected(null);
      setSundayChoice(null);

      const result = await fetchAvailability(variant.id, countedPieces, today, rangeEnd);
      if (cancelled) return;

      if (result) {
        setData(result);
        setLoadFailed(false);
      } else {
        setLoadFailed(true);
      }
      setLoading(false);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [variant.id, today, rangeEnd]);

  const dayMap = useMemo(() => {
    const map = new Map<string, AvailabilityDay>();
    for (const d of data?.days ?? []) map.set(d.date, d);
    return map;
  }, [data]);

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

    return {
      days: out,
      freeCount: free,
      padCount: pad,
      isBeforeOperationStart: known > 0 && free === 0 && beforeStart > 0,
      isMaxPiecesExceeded: known > 0 && free === 0 && maxPiecesExceeded > 0,
    };
  }, [view, dayMap]);

  const atFirstMonth = view.getFullYear() === today.getFullYear() && view.getMonth() === today.getMonth();
  const atLastMonth = view.getFullYear() === rangeEnd.getFullYear() && view.getMonth() === rangeEnd.getMonth();

  const selectedInfo = selected ? dayMap.get(toISO(selected)) : undefined;
  const needsSundayChoice = !!selectedInfo?.hasSundayReturnException;
  const chosenOption =
    needsSundayChoice && sundayChoice
      ? selectedInfo?.returnOptions?.find((o) => o.type === sundayChoice)
      : undefined;
  const effectiveReturnISO = needsSundayChoice ? chosenOption?.date : selectedInfo?.calculatedReturnDate;
  const canSubmit = !!selected && !!selectedInfo?.bookable && !!effectiveReturnISO;

  function moveFocus(iso: string, step: number) {
    const target = addDays(fromISO(iso), step);
    if (target.getMonth() !== view.getMonth() || target.getFullYear() !== view.getFullYear()) {
      setView(new Date(target.getFullYear(), target.getMonth(), 1));
    }
    requestAnimationFrame(() => {
      gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${toISO(target)}"]`)?.focus();
    });
  }

  async function handleSubmit() {
    if (!selected || !effectiveReturnISO || !sku) return;
    setSubmitting(true);
    setError(null);
    try {
      const returnDate = fromISO(effectiveReturnISO);
      await addRentalToCart({
        variantId: variant.id,
        sku,
        pickup: toISO(selected),
        return: effectiveReturnISO,
        pickupLabel: selected.toLocaleDateString(locale),
        returnLabel: returnDate.toLocaleDateString(locale),
      });
      window.dispatchEvent(new Event('closet:cart-added'));
    } catch {
      setError('Não foi possível adicionar ao carrinho. Tente novamente.');
    } finally {
      setSubmitting(false);
    }
  }

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

      {selected && selectedInfo?.bookable && (
        <>
          {needsSundayChoice && (
            <div className="mt-5 rounded-xl bg-marsala/[0.06] p-4">
              <p className="text-[0.8rem] font-medium text-marsala">
                A devolução calculada cai num domingo — a loja não abre. Escolha uma opção:
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                {selectedInfo.returnOptions?.map((option) => (
                  <button
                    key={option.type}
                    type="button"
                    onClick={() => setSundayChoice(option.type)}
                    className={[
                      'flex-1 rounded-lg border px-3.5 py-2.5 text-left text-[0.8rem] transition-colors',
                      sundayChoice === option.type
                        ? 'border-marsala bg-marsala text-cream'
                        : 'border-ink/15 hover:border-marsala/40',
                    ].join(' ')}
                  >
                    <span className="block font-medium">
                      {option.type === 'saturday' ? 'Sábado à noite' : 'Segunda-feira'}
                    </span>
                    <span className="block text-[0.72rem] opacity-80">
                      {fromISO(option.date).toLocaleDateString(locale, LONG_DATE)}
                      {option.window ? ` · ${option.window}` : ''}
                    </span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[0.7rem] text-marsala/70">Nenhuma diária adicional nessas opções.</p>
            </div>
          )}

          {effectiveReturnISO && (
            <>
              <dl className="mt-5 rounded-xl bg-ink/[0.03] p-4">
                <SumRow label="Retirada">{selected.toLocaleDateString(locale, LONG_DATE)}</SumRow>
                <SumRow label="Devolução">{fromISO(effectiveReturnISO).toLocaleDateString(locale, LONG_DATE)}</SumRow>
                <SumRow label="Período">
                  {selectedInfo.durationDays} {selectedInfo.durationDays === 1 ? 'dia' : 'dias'}
                </SumRow>
                <div className="mt-1.5 border-t border-ink/10 pt-3">
                  <SumRow label="Valor" emphasis>
                    {formatPrice(variant.price.amount, variant.price.currencyCode, locale)}
                  </SumRow>
                </div>
              </dl>

              <p className="mt-3 text-[0.7rem] leading-relaxed text-ink/50">
                O período é definido pela quantidade de peças ({pieces} no total). Ao adicionar
                mais peças, a devolução é recalculada.
              </p>
            </>
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
              ? data?.operationStartDate
                ? `Reservas online disponíveis a partir de ${fromISO(data.operationStartDate).toLocaleDateString(locale, LONG_DATE)}.`
                : 'Reservas online ainda não disponíveis para estas datas.'
              : freeCount === 0 && !loading
                ? 'Não há datas disponíveis neste mês. Fale com o atendimento para verificar outras opções.'
                : selected && selectedInfo?.bookable
                  ? 'Disponível para retirada nesta data.'
                  : null}
      </Status>

      {error && <Status tone="error">{error}</Status>}

      <RentalAction>
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit || submitting}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-marsala px-5 py-3.5 text-[0.8rem] font-semibold uppercase tracking-[0.12em] text-cream transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
      >
        {submitting && <Spinner light />}
        Alugar agora
      </button>
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
