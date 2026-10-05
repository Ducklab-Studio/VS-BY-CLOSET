'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ProductImage } from '@/components/ProductImage';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Clock,
  Minus,
  Plus,
  ShieldCheck,
  ShoppingBag,
  Trash2,
} from 'lucide-react';
import {
  getCart,
  quantityForVariant,
  removeCartLine,
  updateCartLineQuantity,
  type Cart,
  type CartLine,
} from '@/lib/cart';
import { formatPrice } from '@/lib/shopify';
import { type SundayReturnOptionInfo } from '@/lib/checkout';
import { returnOptionFromLines } from '@/lib/rental-selection';
import { createCheckoutAttempt } from '@/lib/checkout-attempt';
import {
  fetchRentalStock,
  shopifyStockLabel,
  stockForVariant,
  type RentalStockMap,
} from '@/lib/rental-stock';

/**
 * Carrinho de Aluguel (Sprint 2 - Frontend Evolution).
 *
 * Shopify é a autoridade de preço e carrinho comercial.
 * O reservations-api é a autoridade da agenda física de aluguel.
 * O HOLD transacional revalida disponibilidade antes do envio ao checkout.
 */
export default function CarrinhoPage() {
  const [cart, setCart] = useState<Cart | null>(null);
  const [rentalStock, setRentalStock] = useState<RentalStockMap>({});
  const [loading, setLoading] = useState(true);
  const [stockLoading, setStockLoading] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [updatingQuantity, setUpdatingQuantity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [durationFailed, setDurationFailed] = useState(false);

  const [termsAccepted, setTermsAccepted] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [sundayOptions, setSundayOptions] = useState<SundayReturnOptionInfo[] | null>(null);
  const [sundayChoice, setSundayChoice] = useState<'saturday' | 'mondayMorning' | null>(null);
  const [lineConfirmDelete, setLineConfirmDelete] = useState<string | null>(null);

  const checkoutAttemptRef = useRef<ReturnType<typeof createCheckoutAttempt> | null>(null);
  if (checkoutAttemptRef.current === null) checkoutAttemptRef.current = createCheckoutAttempt();

  async function loadStock(nextCart: Cart | null) {
    if (!nextCart?.lines.length) {
      setRentalStock({});
      return;
    }

    setStockLoading(true);
    try {
      setRentalStock(await fetchRentalStock(nextCart));
    } finally {
      setStockLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    getCart()
      .then(async (result) => {
        if (cancelled) return;
        setCart(result);
        setSundayChoice(result ? returnOptionFromLines(result.lines) : null);
        if (result?.lines.length) {
          setStockLoading(true);
          try {
            const stock = await fetchRentalStock(result);
            if (!cancelled) setRentalStock(stock);
          } finally {
            if (!cancelled) setStockLoading(false);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setError('Não foi possível carregar o carrinho.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const pieces = cart?.totalQuantity ?? 0;
    if (pieces === 0) return;

    let cancelled = false;
    setDuration(null);
    fetchDuration(pieces).then((result) => {
      if (cancelled) return;
      if (result === null) {
        setDurationFailed(true);
      } else {
        setDuration(result);
        setDurationFailed(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cart?.totalQuantity]);

  const pickupDate = useMemo(() => (cart ? derivePickupDate(cart.lines) : null), [cart]);

  function resetCheckoutStateAfterCartChange() {
    checkoutAttemptRef.current?.reset();
    setSundayOptions(null);
    setSundayChoice(null);
    setCheckoutError(null);
    setTermsAccepted(false);
  }

  async function handleRemove(lineId: string) {
    if (checkingOut || removing || updatingQuantity) return;
    setRemoving(lineId);
    setLineConfirmDelete(null);
    setError(null);
    try {
      const nextCart = await removeCartLine(lineId);
      setCart(nextCart);
      await loadStock(nextCart);
      resetCheckoutStateAfterCartChange();
    } catch {
      setError('Não foi possível remover a peça. Tente novamente.');
    } finally {
      setRemoving(null);
    }
  }

  async function handleQuantity(line: CartLine, nextQuantity: number) {
    if (!cart || checkingOut || removing || updatingQuantity || nextQuantity < 1) return;

    const stock = stockForVariant(rentalStock, line.merchandise.id);
    const totalSameVariant = quantityForVariant(cart, line.merchandise.id);
    const otherLinesQuantity = totalSameVariant - line.quantity;
    const maxForThisLine =
      stock.effective === null ? null : Math.max(0, stock.effective - otherLinesQuantity);

    if (maxForThisLine !== null && nextQuantity > maxForThisLine) {
      setError(
        stock.physical !== null && stock.shopify !== null
          ? `Para esta data há no máximo ${stock.effective} unidade(s) disponível(is), considerando Shopify e estoque físico.`
          : `Há no máximo ${stock.effective} unidade(s) disponível(is) desta peça.`,
      );
      return;
    }

    setUpdatingQuantity(line.id);
    setError(null);
    try {
      const nextCart = await updateCartLineQuantity(line.id, nextQuantity);
      setCart(nextCart);
      await loadStock(nextCart);
      resetCheckoutStateAfterCartChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível alterar a quantidade.');
    } finally {
      setUpdatingQuantity(null);
    }
  }

  async function handleCheckout() {
    if (!cart || !termsAccepted || checkingOut || removing || updatingQuantity) return;
    if (!pickupDate) {
      setCheckoutError(
        'Não foi possível identificar a data de retirada deste carrinho. Refaça a seleção pela peça.',
      );
      return;
    }

    setCheckingOut(true);
    setCheckoutError(null);

    const items = groupItemsByVariant(cart.lines);
    const checkoutResult = await checkoutAttemptRef.current!.run(
      {
        items,
        pickupDate,
        termsAccepted,
        ...(sundayChoice ? { sundayReturnOption: sundayChoice } : {}),
      },
      async () => {
        let latestStock: RentalStockMap;
        try {
          latestStock = await fetchRentalStock(cart);
          setRentalStock(latestStock);
        } catch {
          throw new Error('Não foi possível confirmar o estoque agora. Tente novamente.');
        }
        for (const item of items) {
          const stock = stockForVariant(latestStock, item.shopifyVariantId);
          if (stock.effective !== null && item.quantity > stock.effective) {
            throw new Error(
              `A quantidade de uma das peças mudou. Agora há ${stock.effective} unidade(s) disponível(is) para esta data.`,
            );
          }
        }
      },
    );

    if (!checkoutResult.ok) {
      if ('reason' in checkoutResult && checkoutResult.reason === 'needs_sunday_choice') {
        setSundayOptions(checkoutResult.returnOptions);
        setCheckoutError(null);
      } else {
        const unavailable =
          'unavailableVariantIds' in checkoutResult
            ? (checkoutResult.unavailableVariantIds ?? [])
            : [];
        const titles = [
          ...new Set(
            cart.lines
              .filter((line) => unavailable.includes(line.merchandise.id))
              .map((line) => line.merchandise.product.title),
          ),
        ];
        setCheckoutError(
          titles.length > 0
            ? `${titles.join(', ')}: ${checkoutResult.message}`
            : checkoutResult.message,
        );
      }
      setCheckingOut(false);
      return;
    }

    window.location.href = checkoutResult.checkoutUrl;
  }

  if (loading) {
    return (
      <div className="cart-page mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
        <div className="mb-10 flex items-center justify-between">
          <div>
            <div className="h-4 w-32 animate-pulse rounded bg-ink/10" />
            <div className="mt-3 h-8 w-64 animate-pulse rounded bg-ink/10" />
          </div>
        </div>
        <div className="grid gap-10 lg:grid-cols-[1fr_380px]">
          <div className="space-y-5">
            {Array.from({ length: 2 }).map((_, i) => (
              <div
                key={i}
                className="flex gap-5 rounded-3xl border border-ink/5 bg-cream/30 p-5 shadow-sm"
              >
                <div className="h-32 w-24 animate-pulse rounded-2xl bg-ink/10 shrink-0" />
                <div className="flex-1 space-y-3 pt-2">
                  <div className="h-6 w-3/4 animate-pulse rounded bg-ink/10" />
                  <div className="h-4 w-1/2 animate-pulse rounded bg-ink/10" />
                  <div className="h-4 w-1/4 animate-pulse rounded bg-ink/10" />
                </div>
              </div>
            ))}
          </div>
          <div className="h-80 animate-pulse rounded-3xl border border-ink/5 bg-cream/30 p-6 shadow-sm" />
        </div>
      </div>
    );
  }

  if (!cart || cart.lines.length === 0) {
    return (
      <div className="cart-page mx-auto max-w-2xl px-6 py-20 text-center sm:py-32">
        <div className="mx-auto mb-6 grid h-20 w-20 place-items-center rounded-full bg-marsala/5 text-marsala shadow-sm">
          <ShoppingBag size={32} strokeWidth={1.5} />
        </div>
        <h1 className="font-heading text-3xl text-marsala sm:text-4xl">Seu carrinho está vazio</h1>
        <p className="mt-4 text-[0.95rem] leading-relaxed text-ink/60">
          Explore nosso catálogo premium de roupas de neve e selecione as peças para a sua viagem.
        </p>
        <div className="mt-10 flex justify-center">
          <Link
            href="/pecas"
            className="group inline-flex items-center gap-2 rounded-xl bg-marsala px-7 py-4 text-[0.8rem] font-semibold uppercase tracking-[0.15em] text-cream transition-all hover:bg-marsala-glow hover:shadow-glow-marsala focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-marsala"
          >
            Ver catálogo de peças
            <ArrowUpRight
              size={18}
              className="transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
            />
          </Link>
        </div>
      </div>
    );
  }

  const pieces = cart.totalQuantity;
  const cartTotalAmount = cart.cost.totalAmount?.amount;
  const cartTotalCurrency = cart.cost.totalAmount?.currencyCode;
  const formattedTotal = formatPrice(cartTotalAmount, cartTotalCurrency);

  return (
    <div className="cart-page mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-16">
      {/* Navigation & Header */}
      <div className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between border-b border-ink/5 pb-8">
        <div>
          <Link
            href="/pecas"
            className="group mb-3 inline-flex items-center gap-1.5 text-[0.7rem] font-medium uppercase tracking-[0.15em] text-ink/50 transition-colors hover:text-marsala"
          >
            <ArrowLeft size={14} className="transition-transform group-hover:-translate-x-1" />{' '}
            Continuar escolhendo
          </Link>
          <h1 className="font-heading text-4xl leading-tight sm:text-5xl text-marsala tracking-tight">
            Seu closet de viagem
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-marsala/5 border border-marsala/10 px-4 py-1.5 font-mono text-[0.8rem] font-semibold text-marsala">
            {pieces} {pieces === 1 ? 'peça' : 'peças'}
          </span>
          {formattedTotal && (
            <span className="font-mono text-base font-semibold tabular-nums text-ink/80">
              · {formattedTotal}
            </span>
          )}
        </div>
      </div>

      <div className="grid gap-10 lg:grid-cols-[1fr_380px] lg:items-start">
        {/* Item List */}
        <div className="space-y-5">
          {cart.lines.map((line) => {
            const pickup = line.attributes.find((a) => a.key === 'Retirada')?.value;
            const ret = line.attributes.find((a) => a.key === 'Devolução')?.value;
            const stock = stockForVariant(rentalStock, line.merchandise.id);
            const totalSameVariant = quantityForVariant(cart, line.merchandise.id);
            const canIncrease =
              line.merchandise.availableForSale &&
              !stockLoading &&
              (stock.effective === null || totalSameVariant < stock.effective);
            const busy = checkingOut || !!updatingQuantity || !!removing;
            const isLineRemoving = removing === line.id;
            const isLineUpdating = updatingQuantity === line.id;

            const unitPriceStr = formatPrice(
              line.merchandise.price?.amount,
              line.merchandise.price?.currencyCode,
            );
            const showConfirmDelete = lineConfirmDelete === line.id;

            return (
              <div
                key={line.id}
                className="group relative flex flex-col gap-5 rounded-3xl border border-ink/5 bg-white p-5 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)] transition-all hover:shadow-[0_8px_30px_-12px_rgba(0,0,0,0.1)] sm:flex-row sm:items-center sm:p-6"
              >
                {/* Product Image */}
                <div className="relative h-32 w-24 shrink-0 overflow-hidden rounded-2xl bg-cream/50 border border-ink/5">
                  {line.merchandise.product.featuredImage ? (
                    <ProductImage
                      src={line.merchandise.product.featuredImage.url}
                      alt={
                        line.merchandise.product.featuredImage.altText ??
                        line.merchandise.product.title
                      }
                      fill
                      sizes="96px"
                      className="object-cover transition-transform duration-700 group-hover:scale-105"
                    />
                  ) : (
                    <div className="grid h-full place-items-center text-[0.7rem] text-ink/40">
                      Sem foto
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <Link
                      href={`/pecas/${line.merchandise.product.handle}`}
                      className="font-heading text-xl leading-tight text-ink/90 transition-colors hover:text-marsala"
                    >
                      {line.merchandise.product.title}
                    </Link>
                    <div className="shrink-0 text-right sm:hidden">
                      <p className="font-mono text-sm font-semibold tabular-nums text-marsala">
                        {unitPriceStr || 'Preço a confirmar'}
                      </p>
                    </div>
                  </div>

                  {line.merchandise.sku && (
                    <p className="font-mono text-[0.7rem] uppercase tracking-wider text-ink/40">
                      SKU: {line.merchandise.sku}
                    </p>
                  )}

                  {/* Stock info pill */}
                  <div className="space-y-1 text-[0.75rem]">
                    <p className="font-medium text-ink/60">
                      {stockLoading ? 'Conferindo estoque…' : shopifyStockLabel(stock)}
                    </p>
                    {stock.effective !== null && !stockLoading ? (
                      <p className="inline-block rounded-md bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-700">
                        Disponível para esta reserva: {stock.effective}
                      </p>
                    ) : null}
                  </div>

                  {/* Dates Tag */}
                  {pickup && ret && (
                    <div className="inline-flex flex-wrap items-center gap-1.5 rounded-lg bg-sand/30 border border-sand/50 px-3 py-1.5 text-[0.75rem] font-medium text-marsala/90 mt-1">
                      <span>Retirada: {pickup}</span>
                      <span aria-hidden="true" className="text-marsala/40">
                        ·
                      </span>
                      <span>Devolução: {ret}</span>
                    </div>
                  )}

                  {/* Quantity & Delete Controls */}
                  <div className="mt-4 flex items-center justify-between pt-2 border-t border-ink/5">
                    <div className="flex items-center gap-3">
                      <span className="text-[0.75rem] font-medium text-ink/50 uppercase tracking-widest">
                        Qtd
                      </span>
                      <div className="inline-flex items-center overflow-hidden rounded-xl border border-ink/10 bg-cream/30">
                        <button
                          type="button"
                          aria-label="Diminuir quantidade"
                          disabled={busy || line.quantity <= 1}
                          onClick={() => void handleQuantity(line, line.quantity - 1)}
                          className="grid h-8 w-8 place-items-center text-ink/60 transition hover:bg-marsala/5 hover:text-marsala disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline-none"
                        >
                          <Minus size={14} />
                        </button>
                        <span className="min-w-9 text-center font-mono text-[0.8rem] font-semibold tabular-nums text-ink">
                          {isLineUpdating ? '…' : line.quantity}
                        </span>
                        <button
                          type="button"
                          aria-label="Aumentar quantidade"
                          disabled={busy || !canIncrease}
                          onClick={() => void handleQuantity(line, line.quantity + 1)}
                          className="grid h-8 w-8 place-items-center text-ink/60 transition hover:bg-marsala/5 hover:text-marsala disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline-none"
                        >
                          <Plus size={14} />
                        </button>
                      </div>
                    </div>

                    {showConfirmDelete ? (
                      <div className="flex items-center gap-2 animate-in fade-in slide-in-from-right-2 duration-200">
                        <span className="text-[0.7rem] font-medium text-marsala/80">
                          Remover peça?
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleRemove(line.id)}
                          disabled={busy}
                          className="rounded-md bg-red-600/10 px-2.5 py-1 text-[0.7rem] font-semibold text-red-700 transition-colors hover:bg-red-600/20 disabled:opacity-40"
                        >
                          Sim
                        </button>
                        <button
                          type="button"
                          onClick={() => setLineConfirmDelete(null)}
                          disabled={busy}
                          className="rounded-md bg-ink/5 px-2.5 py-1 text-[0.7rem] font-medium text-ink/70 transition-colors hover:bg-ink/10 disabled:opacity-40"
                        >
                          Não
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setLineConfirmDelete(line.id)}
                        disabled={busy}
                        aria-label={`Remover ${line.merchandise.product.title} do carrinho`}
                        className="inline-flex items-center gap-1.5 text-[0.75rem] font-medium text-ink/40 transition-colors hover:text-red-600 disabled:opacity-40 focus-visible:outline-none"
                      >
                        <Trash2 size={14} />
                        {isLineRemoving ? 'Removendo…' : 'Remover'}
                      </button>
                    )}
                  </div>
                </div>

                {/* Desktop Price */}
                <div className="hidden shrink-0 text-right sm:block ml-4">
                  <p className="font-mono text-lg font-bold tabular-nums text-marsala">
                    {unitPriceStr || 'A confirmar'}
                  </p>
                  {line.quantity > 1 && (
                    <p className="mt-1 text-[0.7rem] font-medium text-ink/40 uppercase tracking-wider">
                      por unidade
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Order Summary & Checkout Card */}
        <div className="rounded-3xl border border-marsala/10 bg-white p-6 sm:p-8 shadow-[0_8px_30px_-12px_rgba(83,19,30,0.1)] space-y-6 lg:sticky lg:top-28">
          <h2 className="font-heading text-2xl text-marsala border-b border-ink/5 pb-4">
            Resumo da reserva
          </h2>

          {/* Period Calculation Info */}
          <div className="rounded-2xl bg-cream p-4 text-[0.8rem] leading-relaxed text-ink/70 space-y-1.5 border border-ink/5">
            <p className="font-semibold text-ink/90 flex justify-between items-center">
              <span>
                {pieces} {pieces === 1 ? 'peça selecionada' : 'peças selecionadas'}
              </span>
              <ShoppingBag size={14} className="text-ink/40" />
            </p>
            <p className="text-[0.75rem] text-ink/60">
              {durationFailed
                ? 'Não foi possível calcular o período exato agora.'
                : duration !== null
                  ? `Período estimado: ${duration} ${duration === 1 ? 'dia' : 'dias'}`
                  : 'Calculando período…'}
            </p>
          </div>

          {/* Total Breakdown */}
          <div className="space-y-2 border-t border-b border-ink/5 py-4">
            <div className="flex items-baseline justify-between">
              <span className="text-[0.85rem] font-medium text-ink/60 uppercase tracking-widest">
                Total estimado
              </span>
              <span className="font-mono text-3xl font-bold tabular-nums text-marsala">
                {formattedTotal || 'a confirmar'}
              </span>
            </div>
            <p className="text-[0.7rem] leading-tight text-ink/40 text-right">
              Valor oficial do carrinho comercial Shopify.
            </p>
          </div>

          {/* Error Banner */}
          {error && (
            <div
              role="status"
              className="flex gap-3 rounded-2xl bg-red-50 p-4 text-[0.8rem] text-red-800 border border-red-100 animate-in fade-in slide-in-from-top-2"
            >
              <AlertTriangle size={18} className="shrink-0 mt-0.5 text-red-500" />
              <p className="font-medium leading-relaxed">{error}</p>
            </div>
          )}

          {/* Sunday Return Exception Choice */}
          {sundayOptions && sundayOptions.length > 0 && (
            <div className="rounded-2xl bg-marsala/5 p-5 space-y-3 border border-marsala/10 animate-in fade-in">
              <p className="text-[0.8rem] font-semibold text-marsala">
                A devolução calculada cai num domingo (loja fechada). Escolha a opção:
              </p>
              <div className="flex flex-col gap-2.5">
                {sundayOptions.map((option) => (
                  <button
                    key={option.type}
                    type="button"
                    disabled={checkingOut}
                    onClick={() => {
                      setSundayChoice(option.type);
                      setSundayOptions(null);
                    }}
                    className="group rounded-xl border border-marsala/10 bg-white p-3 text-left transition-all hover:border-marsala hover:shadow-sm"
                  >
                    <span className="block font-semibold text-marsala group-hover:text-marsala-glow text-[0.8rem]">
                      {option.type === 'saturday' ? 'Sábado à noite' : 'Segunda-feira de manhã'}
                    </span>
                    <span className="block text-[0.75rem] text-ink/60 mt-0.5">
                      {new Date(`${option.date}T00:00:00`).toLocaleDateString('pt-BR', {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric',
                      })}
                      {option.window ? ` · ${option.window}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {sundayChoice && (
            <div className="flex items-center justify-between rounded-xl bg-ink/5 p-3 text-[0.75rem]">
              <span className="text-ink/70">
                Devolução:{' '}
                <strong className="text-ink/90">
                  {sundayChoice === 'saturday' ? 'Sábado à noite' : 'Segunda-feira'}
                </strong>
              </span>
              <button
                type="button"
                disabled={checkingOut}
                onClick={() => {
                  checkoutAttemptRef.current?.reset();
                  setSundayChoice(null);
                }}
                className="font-medium text-marsala underline underline-offset-2 transition-colors hover:text-marsala-glow"
              >
                alterar
              </button>
            </div>
          )}

          {/* Mandatory HOLD Info Card */}
          <div className="flex gap-3 rounded-2xl border border-marsala/10 bg-marsala/5 p-4 text-[0.75rem] leading-relaxed text-marsala">
            <Clock size={20} className="shrink-0 mt-0.5" strokeWidth={1.5} />
            <div>
              <p className="font-bold tracking-wide">Reserva garantida por 30 minutos</p>
              <p className="mt-1 text-ink/70">
                Ao finalizar, o estoque físico é bloqueado exclusivamente para você durante o
                pagamento.
              </p>
            </div>
          </div>

          {/* Terms Acceptance */}
          <label className="group flex items-start gap-3 text-[0.75rem] leading-relaxed text-ink/70 cursor-pointer">
            <div className="relative flex items-center">
              <input
                type="checkbox"
                checked={termsAccepted}
                onChange={(e) => setTermsAccepted(e.target.checked)}
                className="peer h-4 w-4 shrink-0 cursor-pointer appearance-none rounded-[4px] border-2 border-ink/20 bg-white transition-all checked:border-marsala checked:bg-marsala focus:outline-none focus:ring-2 focus:ring-marsala/20 focus:ring-offset-1"
              />
              <svg
                className="pointer-events-none absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 text-white opacity-0 transition-opacity peer-checked:opacity-100"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="3"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <span className="mt-[-1px] select-none transition-colors group-hover:text-ink/90">
              Li e aceito os{' '}
              <Link
                href="/termos-de-uso"
                target="_blank"
                className="font-semibold text-marsala underline underline-offset-4 hover:text-marsala-glow"
              >
                termos de uso
              </Link>{' '}
              da reserva.
            </span>
          </label>

          {checkoutError && (
            <div
              role="status"
              className="flex gap-3 rounded-2xl bg-red-50 p-4 text-[0.8rem] text-red-800 border border-red-100 animate-in fade-in slide-in-from-top-2"
            >
              <AlertTriangle size={18} className="shrink-0 mt-0.5 text-red-500" />
              <p className="font-medium leading-relaxed">{checkoutError}</p>
            </div>
          )}

          {/* Checkout Action */}
          <button
            type="button"
            onClick={handleCheckout}
            disabled={
              !termsAccepted ||
              checkingOut ||
              !!sundayOptions ||
              stockLoading ||
              !!removing ||
              !!updatingQuantity
            }
            className="group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-2xl bg-marsala px-6 py-5 text-[0.8rem] font-bold uppercase tracking-[0.15em] text-cream transition-all hover:bg-marsala-glow hover:shadow-[0_0_20px_rgba(83,19,30,0.3)] active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-ink/10 disabled:text-ink/40 disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-marsala focus-visible:ring-offset-2"
          >
            {checkingOut ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-cream border-t-transparent" />
                Criando reserva (HOLD)…
              </>
            ) : stockLoading ? (
              'Conferindo estoque…'
            ) : (
              <>
                Finalizar reserva
                <ShieldCheck size={18} className="transition-transform group-hover:scale-110" />
              </>
            )}
          </button>

          <p className="text-center text-[0.7rem] font-medium text-ink/40 flex items-center justify-center gap-1.5">
            <ShieldCheck size={14} />
            Criptografia segura e validação presencial
          </p>
        </div>
      </div>
    </div>
  );
}

async function fetchDuration(countedPieces: number): Promise<number | null> {
  const base = process.env.NEXT_PUBLIC_RENTAL_PLAN_URL;
  if (!base) return null;

  const url = new URL(base);
  url.searchParams.set('countedPieces', String(countedPieces));

  try {
    const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = (await res.json()) as { durationDays?: number };
    return typeof data.durationDays === 'number' ? data.durationDays : null;
  } catch {
    return null;
  }
}

function groupItemsByVariant(lines: CartLine[]): { shopifyVariantId: string; quantity: number }[] {
  const byVariant = new Map<string, number>();
  for (const line of lines) {
    byVariant.set(line.merchandise.id, (byVariant.get(line.merchandise.id) ?? 0) + line.quantity);
  }
  return Array.from(byVariant.entries()).map(([shopifyVariantId, quantity]) => ({
    shopifyVariantId,
    quantity,
  }));
}

function derivePickupDate(lines: CartLine[]): string | null {
  const values = new Set(
    lines
      .map((l) => l.attributes.find((a) => a.key === '_vsc_pickup')?.value)
      .filter((v): v is string => !!v),
  );
  if (values.size !== 1) return null;
  return [...values][0];
}
