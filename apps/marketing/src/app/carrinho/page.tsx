'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ProductImage } from '@/components/ProductImage';
import Link from 'next/link';
import { ArrowUpRight, Minus, Plus } from 'lucide-react';
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
import { createCheckoutAttempt } from '@/lib/checkout-attempt';
import {
  fetchRentalStock,
  stockForVariant,
  type RentalStockMap,
} from '@/lib/rental-stock';

/**
 * Carrinho.
 *
 * Shopify continua sendo a autoridade do estoque comercial e do preço.
 * O reservations-api continua sendo a autoridade da agenda das peças
 * físicas. Para a quantidade exibida ao cliente usamos o MENOR limite
 * conhecido entre os dois, e o HOLD transacional do backend revalida tudo
 * novamente antes de seguir para o checkout.
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
      setCheckoutError('Não foi possível identificar a data de retirada deste carrinho. Refaça a seleção pela peça.');
      return;
    }

    setCheckingOut(true);
    setCheckoutError(null);

    const items = groupItemsByVariant(cart.lines);
    const checkoutResult = await checkoutAttemptRef.current!.run({
      items,
      pickupDate,
      termsAccepted,
      ...(sundayChoice ? { sundayReturnOption: sundayChoice } : {}),
    }, async () => {
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
          throw new Error(`A quantidade de uma das peças mudou. Agora há ${stock.effective} unidade(s) disponível(is) para esta data.`);
        }
      }
    });

    if (!checkoutResult.ok) {
      if ('reason' in checkoutResult && checkoutResult.reason === 'needs_sunday_choice') {
        setSundayOptions(checkoutResult.returnOptions);
        setCheckoutError(null);
      } else {
        setCheckoutError(checkoutResult.message);
      }
      setCheckingOut(false);
      return;
    }

    window.location.href = checkoutResult.checkoutUrl;
  }

  if (loading) {
    return <Shell><p className="text-ink/50">Carregando…</p></Shell>;
  }

  if (!cart || cart.lines.length === 0) {
    return (
      <Shell>
        <p className="text-ink/60">Seu carrinho está vazio.</p>
        <Link href="/pecas" className="editorial-button mt-6">
          Ver peças <ArrowUpRight size={18} />
        </Link>
      </Shell>
    );
  }

  const pieces = cart.totalQuantity;

  return (
    <Shell>
      <ul className="divide-y divide-ink/10 border-y border-ink/10">
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

          return (
            <li key={line.id} className="flex gap-4 py-5">
              <div className="relative h-24 w-20 shrink-0 overflow-hidden rounded-lg bg-ink/[0.04]">
                {line.merchandise.product.featuredImage && (
                  <ProductImage
                    src={line.merchandise.product.featuredImage.url}
                    alt={line.merchandise.product.featuredImage.altText ?? line.merchandise.product.title}
                    fill
                    sizes="80px"
                    className="object-cover"
                  />
                )}
              </div>

              <div className="min-w-0 flex-1">
                <Link
                  href={`/pecas/${line.merchandise.product.handle}`}
                  className="font-medium transition-colors hover:text-marsala"
                >
                  {line.merchandise.product.title}
                </Link>

                {line.merchandise.sku && (
                  <p className="mt-0.5 text-[0.7rem] uppercase tracking-wider text-ink/65">
                    {line.merchandise.sku}
                  </p>
                )}

                <div className="mt-1 space-y-0.5 text-[0.72rem] text-ink/55">
                  <p>
                    {stock.shopify === null
                      ? 'Estoque Shopify: sob consulta'
                      : stock.shopify > 0
                        ? `Estoque Shopify: ${stock.shopify}`
                        : 'Esgotado na Shopify'}
                  </p>
                  <p>
                    {stockLoading
                      ? 'Conferindo peças físicas para a data…'
                      : stock.physical === null
                        ? 'Estoque físico na data: será validado ao finalizar'
                        : `Peças físicas livres na data: ${stock.physical}`}
                  </p>
                  {stock.effective !== null && !stockLoading ? (
                    <p className="font-medium text-marsala">
                      Disponível para esta reserva: {stock.effective}
                    </p>
                  ) : null}
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-[0.75rem] text-ink/60">Quantidade</span>
                  <div className="inline-flex items-center overflow-hidden rounded-lg border border-ink/15">
                    <button
                      type="button"
                      aria-label="Diminuir quantidade"
                      disabled={busy || line.quantity <= 1}
                      onClick={() => void handleQuantity(line, line.quantity - 1)}
                      className="grid h-8 w-8 place-items-center transition hover:bg-ink/5 disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <Minus size={13} />
                    </button>
                    <span className="min-w-9 text-center text-sm font-semibold tabular-nums">
                      {updatingQuantity === line.id ? '…' : line.quantity}
                    </span>
                    <button
                      type="button"
                      aria-label="Aumentar quantidade"
                      disabled={busy || !canIncrease}
                      onClick={() => void handleQuantity(line, line.quantity + 1)}
                      className="grid h-8 w-8 place-items-center transition hover:bg-ink/5 disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                </div>

                {pickup && ret && (
                  <p className="mt-2 text-[0.8rem] text-ink/60">
                    Retirada {pickup} · Devolução {ret}
                  </p>
                )}

                <button
                  type="button"
                  onClick={() => void handleRemove(line.id)}
                  disabled={busy}
                  className="mt-2 text-[0.75rem] text-ink/65 underline underline-offset-2 transition-colors hover:text-marsala disabled:opacity-50"
                >
                  {removing === line.id ? 'Removendo…' : 'Remover'}
                </button>
              </div>

              <div className="shrink-0 text-right">
                <p className="font-semibold tabular-nums">
                  {formatPrice(line.merchandise.price.amount, line.merchandise.price.currencyCode)}
                </p>
                {line.quantity > 1 && <p className="mt-1 text-[0.68rem] text-ink/45">cada</p>}
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-4 text-[0.75rem] leading-relaxed text-ink/50">
        {pieces} {pieces === 1 ? 'peça' : 'peças'}
        {durationFailed ? (
          <> · não foi possível calcular o período agora.</>
        ) : duration !== null ? (
          <> · período de {duration} {duration === 1 ? 'dia' : 'dias'}</>
        ) : (
          <> · calculando período…</>
        )}
        . A quantidade respeita o estoque da Shopify e as peças físicas livres para a data escolhida.
      </p>

      <div className="mt-6 flex items-baseline justify-between border-t border-ink/10 pt-5">
        <span className="text-[0.8rem] uppercase tracking-[0.12em] text-ink/55">Total</span>
        <span className="text-2xl font-semibold text-marsala tabular-nums">
          {formatPrice(cart.cost.totalAmount.amount, cart.cost.totalAmount.currencyCode)}
        </span>
      </div>

      {error && (
        <p className="mt-4 rounded-xl bg-red-700/10 px-3.5 py-3 text-[0.8rem] text-red-800">
          {error}
        </p>
      )}

      {sundayOptions && sundayOptions.length > 0 && (
        <div className="mt-5 rounded-xl bg-marsala/[0.06] p-4">
          <p className="text-[0.8rem] font-medium text-marsala">
            A devolução calculada cai num domingo — a loja não abre. Escolha uma opção:
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            {sundayOptions.map((option) => (
              <button
                key={option.type}
                type="button"
                disabled={checkingOut}
                onClick={() => {
                  setSundayChoice(option.type);
                  setSundayOptions(null);
                }}
                className="flex-1 rounded-lg border border-ink/15 px-3.5 py-2.5 text-left text-[0.8rem] transition-colors hover:border-marsala/40"
              >
                <span className="block font-medium">
                  {option.type === 'saturday' ? 'Sábado à noite' : 'Segunda-feira'}
                </span>
                <span className="block text-[0.72rem] opacity-80">
                  {new Date(`${option.date}T00:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })}
                  {option.window ? ` · ${option.window}` : ''}
                </span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-[0.7rem] text-marsala/70">Nenhuma diária adicional nessas opções.</p>
        </div>
      )}

      {sundayChoice && (
        <p className="mt-4 text-[0.75rem] text-ink/55">
          Devolução escolhida: {sundayChoice === 'saturday' ? 'sábado à noite' : 'segunda-feira de manhã'}.{' '}
          <button type="button" disabled={checkingOut} onClick={() => { checkoutAttemptRef.current?.reset(); setSundayChoice(null); }} className="underline underline-offset-2 hover:text-marsala">
            alterar
          </button>
        </p>
      )}

      <label className="mt-5 flex items-start gap-2.5 text-[0.78rem] leading-relaxed text-ink/70">
        <input
          type="checkbox"
          checked={termsAccepted}
          onChange={(e) => setTermsAccepted(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-ink/30 text-marsala focus:ring-marsala"
        />
        <span>
          Li e aceito os{' '}
          <Link href="/termos-de-uso" target="_blank" className="underline underline-offset-2 hover:text-marsala">
            termos de uso
          </Link>{' '}
          da reserva.
        </span>
      </label>

      {checkoutError && (
        <p className="mt-3 rounded-xl bg-red-700/10 px-3.5 py-3 text-[0.8rem] text-red-800">
          {checkoutError}
        </p>
      )}

      <button
        type="button"
        onClick={handleCheckout}
        disabled={!termsAccepted || checkingOut || !!sundayOptions || stockLoading || !!removing || !!updatingQuantity}
        className="mt-6 flex w-full items-center justify-center rounded-xl bg-marsala px-5 py-3.5 text-[0.8rem] font-semibold uppercase tracking-[0.12em] text-cream transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {checkingOut ? 'Preparando…' : stockLoading ? 'Conferindo estoque…' : 'Finalizar reserva'}
      </button>

      <p className="mt-3 text-center text-[0.7rem] text-ink/65">
        Pagamento processado com segurança pela Shopify.
      </p>
    </Shell>
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
  return Array.from(byVariant.entries()).map(([shopifyVariantId, quantity]) => ({ shopifyVariantId, quantity }));
}

function derivePickupDate(lines: CartLine[]): string | null {
  const values = new Set(lines.map((l) => l.attributes.find((a) => a.key === '_vsc_pickup')?.value).filter((v): v is string => !!v));
  if (values.size !== 1) return null;
  return [...values][0];
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="cart-page mx-auto max-w-2xl px-6 py-12 sm:py-16">
      <p className="privacy-eyebrow">Seu closet de viagem</p><h1 className="mb-8 font-heading text-3xl">Seu closet,<br /><em>peça por peça.</em></h1>
      {children}
    </div>
  );
}
