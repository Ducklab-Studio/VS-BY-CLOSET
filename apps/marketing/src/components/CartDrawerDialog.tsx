'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ProductImage } from '@/components/ProductImage';
import { ArrowUpRight, Minus, Plus, ShoppingBag, X } from 'lucide-react';
import {
  getCart,
  quantityForVariant,
  removeCartLine,
  updateCartLineQuantity,
  type Cart,
  type CartLine,
} from '@/lib/cart';
import {
  fetchRentalStock,
  shopifyStockLabel,
  stockForVariant,
  type RentalStockMap,
} from '@/lib/rental-stock';
import { formatPrice } from '@/lib/shopify';

export default function CartDrawerDialog({
  open,
  onClose,
  initialAddedPieces,
}: {
  open: boolean;
  onClose: () => void;
  initialAddedPieces: number;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [cart, setCart] = useState<Cart | null>(null);
  const [rentalStock, setRentalStock] = useState<RentalStockMap>({});
  const [loading, setLoading] = useState(false);
  const [stockLoading, setStockLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatingLine, setUpdatingLine] = useState<string | null>(null);
  const request = useRef({ id: 0 });

  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      setLoading(true);
      setError(null);
      const id = ++request.current.id;

      const loadData = async () => {
        try {
          const result = await getCart();
          if (id === request.current.id) {
            setCart(result);
            if (!result?.lines.length) {
              setRentalStock({});
            } else {
              setStockLoading(true);
              try {
                const nextStock = await fetchRentalStock(result);
                if (id === request.current.id) {
                  setRentalStock(nextStock);
                }
              } finally {
                if (id === request.current.id) setStockLoading(false);
              }
            }
          }
        } catch {
          if (id === request.current.id) setError('Não foi possível carregar seu carrinho.');
        } finally {
          if (id === request.current.id) setLoading(false);
        }
      };

      void loadData();
    } else {
      dialog.current?.close();
    }
  }, [open]);

  async function loadStock(nextCart: Cart | null, requestId?: number) {
    if (!nextCart?.lines.length) {
      setRentalStock({});
      return;
    }

    setStockLoading(true);
    try {
      const nextStock = await fetchRentalStock(nextCart);
      if (requestId === undefined || requestId === request.current.id) {
        setRentalStock(nextStock);
      }
    } finally {
      if (requestId === undefined || requestId === request.current.id) {
        setStockLoading(false);
      }
    }
  }

  async function changeQuantity(line: CartLine, nextQuantity: number) {
    if (!cart || updatingLine) return;

    const stock = stockForVariant(rentalStock, line.merchandise.id);
    const totalSameVariant = quantityForVariant(cart, line.merchandise.id);
    const otherLinesQuantity = totalSameVariant - line.quantity;
    const maxForThisLine =
      stock.effective === null ? null : Math.max(0, stock.effective - otherLinesQuantity);

    if (nextQuantity < 1) return;
    if (maxForThisLine !== null && nextQuantity > maxForThisLine) {
      setError(
        stock.physical !== null && stock.shopify !== null
          ? `Para esta data há no máximo ${stock.effective} unidade(s) disponível(is), considerando Shopify e estoque físico.`
          : `Há no máximo ${stock.effective} unidade(s) disponível(is) desta peça.`,
      );
      return;
    }

    setUpdatingLine(line.id);
    setError(null);
    try {
      const nextCart = await updateCartLineQuantity(line.id, nextQuantity);
      setCart(nextCart);
      await loadStock(nextCart);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível alterar a quantidade.');
    } finally {
      setUpdatingLine(null);
    }
  }

  async function removeLine(lineId: string) {
    if (updatingLine) return;
    setUpdatingLine(lineId);
    setError(null);
    try {
      const nextCart = await removeCartLine(lineId);
      setCart(nextCart);
      await loadStock(nextCart);
    } catch {
      setError('Não foi possível remover a peça.');
    } finally {
      setUpdatingLine(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="cart-drawer bg-white shadow-2xl m-0 ml-auto w-full max-w-md h-[100dvh] max-h-[100dvh] p-0 border-none text-ink backdrop:bg-ink/40"
      aria-labelledby="cart-drawer-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const r = event.currentTarget.getBoundingClientRect();
          if (event.clientX < r.left || event.clientX > r.right) onClose();
        }
      }}
    >
      <div className="flex flex-col h-full">
        <div className="drawer-heading flex justify-between items-center px-6 py-5 border-b border-ink/5 bg-cream/30">
          <div>
            <p className="eyebrow text-[0.65rem] font-bold text-marsala/60 tracking-[0.2em] uppercase mb-1">
              Reserva em andamento
            </p>
            <h2
              id="cart-drawer-title"
              className="font-heading text-3xl text-marsala m-0 leading-none"
            >
              Seu closet
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar carrinho"
            autoFocus
            className="grid place-items-center w-10 h-10 rounded-full bg-ink/5 text-ink/60 transition-colors hover:bg-ink/10 hover:text-marsala"
          >
            <X size={20} strokeWidth={1.5} />
          </button>
        </div>

        {/* Sucesso só com o carrinho REAL carregado e com linhas: nunca antes da Shopify confirmar. */}
        {initialAddedPieces > 0 && !loading && !!cart?.lines.length && (
          <div className="px-6 pt-4">
            <p
              className="cart-success rounded-xl bg-emerald-500/10 text-emerald-800 text-[0.8rem] font-medium px-4 py-3 m-0 flex items-center gap-2 border border-emerald-500/20"
              role="status"
            >
              <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0"></span>
              {initialAddedPieces === 1
                ? 'Peça adicionada ao seu carrinho.'
                : 'Peças adicionadas ao seu carrinho.'}
            </p>
          </div>
        )}
        {error && (
          <div className="px-6 pt-4">
            <p
              className="cart-success rounded-xl bg-red-600/10 text-red-800 text-[0.8rem] font-medium px-4 py-3 m-0 border border-red-600/20"
              role="alert"
            >
              {error}
            </p>
          </div>
        )}

        <div className="drawer-items flex-1 overflow-y-auto px-6 py-4 space-y-4" aria-live="polite">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-40 gap-3 text-ink/40">
              <span
                aria-hidden
                className="h-6 w-6 animate-spin rounded-full border-[3px] border-current border-t-transparent"
              />
              <span className="text-[0.8rem] font-medium tracking-wide">
                Carregando suas peças…
              </span>
            </div>
          ) : !cart?.lines.length ? (
            <div className="drawer-empty flex flex-col items-center justify-center h-full text-center py-10 space-y-6">
              <div className="grid place-items-center w-20 h-20 rounded-full bg-marsala/5 text-marsala">
                <ShoppingBag size={32} strokeWidth={1.5} />
              </div>
              <div className="space-y-2">
                <h3 className="font-heading text-3xl text-marsala m-0">Seu carrinho está vazio.</h3>
                <p className="text-[0.85rem] text-ink/60 leading-relaxed max-w-[280px] mx-auto m-0">
                  Peças escolhidas em &quot;Sua reserva em montagem&quot; só entram aqui depois de
                  &quot;Alugar agora&quot;.
                </p>
              </div>
              <Link
                href="/pecas"
                onClick={onClose}
                className="group inline-flex items-center gap-2 rounded-xl bg-marsala px-6 py-3.5 text-[0.75rem] font-semibold uppercase tracking-[0.15em] text-cream transition-all hover:bg-marsala-glow hover:shadow-[0_0_20px_rgba(83,19,30,0.3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-marsala"
              >
                Explorar peças{' '}
                <ArrowUpRight
                  size={16}
                  className="transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                />
              </Link>
            </div>
          ) : (
            cart.lines.map((line) => {
              const stock = stockForVariant(rentalStock, line.merchandise.id);
              const totalSameVariant = quantityForVariant(cart, line.merchandise.id);
              const canIncrease =
                line.merchandise.availableForSale &&
                !stockLoading &&
                (stock.effective === null || totalSameVariant < stock.effective);
              const busy = updatingLine === line.id;

              return (
                <div
                  className="drawer-item group flex gap-4 p-4 rounded-2xl bg-cream/30 border border-ink/5 transition-all hover:bg-white hover:shadow-sm"
                  key={line.id}
                >
                  <div className="relative w-20 h-28 rounded-xl overflow-hidden bg-cream/50 border border-ink/5 shrink-0">
                    {line.merchandise.product.featuredImage ? (
                      <ProductImage
                        src={line.merchandise.product.featuredImage.url}
                        alt={line.merchandise.product.title}
                        fill
                        sizes="80px"
                        className="object-cover transition-transform duration-500 group-hover:scale-105"
                      />
                    ) : (
                      <div className="grid h-full place-items-center text-[0.6rem] text-ink/40">
                        Sem foto
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1 flex flex-col">
                    <Link
                      href={`/pecas/${line.merchandise.product.handle}`}
                      onClick={onClose}
                      className="font-heading text-lg leading-tight text-ink/90 transition-colors hover:text-marsala mb-1"
                    >
                      {line.merchandise.product.title}
                    </Link>

                    <div className="space-y-1 text-[0.7rem] text-ink/50 flex-1">
                      <p
                        className="font-mono text-[0.85rem] font-bold text-marsala tabular-nums"
                        data-testid="drawer-line-price"
                      >
                        {line.quantity} ×{' '}
                        {formatPrice(
                          line.merchandise.price?.amount,
                          line.merchandise.price?.currencyCode,
                        ) || 'A confirmar'}
                      </p>

                      <div className="space-y-0.5">
                        <p className="font-medium text-ink/70">
                          {stockLoading ? 'Conferindo estoque…' : shopifyStockLabel(stock)}
                        </p>
                        <p className="text-[0.65rem]">
                          {stockLoading
                            ? 'Conferindo peças físicas…'
                            : stock.physical === null
                              ? 'Estoque físico: verificado no checkout'
                              : `Peças físicas livres na data: ${stock.physical}`}
                        </p>
                        {stock.effective !== null && !stockLoading ? (
                          <p className="inline-block rounded-md bg-emerald-500/10 px-1.5 py-0.5 font-medium text-emerald-700 mt-0.5">
                            Disponíveis: {stock.effective}
                          </p>
                        ) : null}
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-ink/5 pt-2">
                      <div className="inline-flex items-center overflow-hidden rounded-lg border border-ink/10 bg-white">
                        <button
                          type="button"
                          aria-label="Diminuir quantidade"
                          disabled={busy || line.quantity <= 1}
                          onClick={() => void changeQuantity(line, line.quantity - 1)}
                          className="grid h-7 w-7 place-items-center text-ink/60 transition hover:bg-marsala/5 hover:text-marsala disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <Minus size={12} />
                        </button>
                        <span className="min-w-7 text-center font-mono text-xs font-semibold tabular-nums text-ink">
                          {busy ? '…' : line.quantity}
                        </span>
                        <button
                          type="button"
                          aria-label="Aumentar quantidade"
                          disabled={busy || !canIncrease}
                          onClick={() => void changeQuantity(line, line.quantity + 1)}
                          className="grid h-7 w-7 place-items-center text-ink/60 transition hover:bg-marsala/5 hover:text-marsala disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <Plus size={12} />
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => void removeLine(line.id)}
                        disabled={busy}
                        className="text-[0.7rem] font-medium text-ink/40 underline underline-offset-2 hover:text-red-600 transition-colors disabled:opacity-40"
                      >
                        Remover
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {!loading && cart && cart.lines.length > 0 && (
          <div className="drawer-bottom p-6 bg-white border-t border-ink/5 shadow-[0_-10px_20px_-10px_rgba(0,0,0,0.05)]">
            <div className="flex justify-between items-end mb-5">
              <span className="text-[0.75rem] font-medium text-ink/50 uppercase tracking-widest">
                Total estimado
              </span>
              <strong
                className="font-mono text-2xl font-bold text-marsala tabular-nums leading-none"
                data-testid="drawer-total"
              >
                {formatPrice(cart.cost.totalAmount?.amount, cart.cost.totalAmount?.currencyCode) ||
                  'A confirmar'}
              </strong>
            </div>
            <Link
              href="/carrinho"
              onClick={onClose}
              className="group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-2xl bg-marsala px-6 py-4 text-[0.75rem] font-bold uppercase tracking-[0.15em] text-cream transition-all hover:bg-marsala-glow hover:shadow-[0_0_20px_rgba(83,19,30,0.3)] active:scale-[0.98]"
            >
              Revisar e finalizar reserva{' '}
              <ArrowUpRight
                size={16}
                className="transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
              />
            </Link>
            <button
              type="button"
              onClick={onClose}
              className="block w-full mt-4 text-[0.7rem] font-medium uppercase tracking-widest text-ink/50 transition-colors hover:text-marsala underline underline-offset-4"
            >
              Continuar escolhendo
            </button>
          </div>
        )}
      </div>
    </dialog>
  );
}
