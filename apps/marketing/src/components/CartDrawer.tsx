'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
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
  stockForVariant,
  type RentalStockMap,
} from '@/lib/rental-stock';

export function CartDrawer() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [cart, setCart] = useState<Cart | null>(null);
  const [rentalStock, setRentalStock] = useState<RentalStockMap>({});
  const [loading, setLoading] = useState(false);
  const [stockLoading, setStockLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const [open, setOpen] = useState(false);
  const [updatingLine, setUpdatingLine] = useState<string | null>(null);
  const request = useRef({ id: 0 });

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

  async function show(wasAdded = false) {
    setAdded(wasAdded);
    setOpen(true);
    dialog.current?.showModal();
    setLoading(true);
    setError(null);
    const id = ++request.current.id;
    try {
      const result = await getCart();
      if (id === request.current.id) {
        setCart(result);
        await loadStock(result, id);
      }
    } catch {
      if (id === request.current.id) setError('Não foi possível carregar seu carrinho.');
    } finally {
      if (id === request.current.id) setLoading(false);
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
    const pending = request.current;
    const addedToCart = () => {
      void show(true);
    };
    window.addEventListener('closet:cart-added', addedToCart);
    return () => {
      window.removeEventListener('closet:cart-added', addedToCart);
      pending.id++;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const close = () => dialog.current?.close();

  return (
    <>
      <button type="button" aria-label="Abrir carrinho" onClick={() => void show()} className="cart-trigger">
        <ShoppingBag size={20} />
      </button>

      <dialog
        ref={dialog}
        className="cart-drawer"
        aria-labelledby="cart-drawer-title"
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            const r = event.currentTarget.getBoundingClientRect();
            if (event.clientX < r.left || event.clientX > r.right) close();
          }
        }}
      >
        <div className="drawer-heading">
          <div>
            <p className="eyebrow">Seu closet, toda estação</p>
            <h2 id="cart-drawer-title">Seu closet de viagem</h2>
          </div>
          <button type="button" onClick={close} aria-label="Fechar carrinho" autoFocus>
            <X size={23} />
          </button>
        </div>

        {added && <p className="cart-success" role="status">Peça adicionada ao seu carrinho.</p>}
        {error && <p className="cart-success" role="alert" style={{ background: 'rgba(153,27,27,.09)', color: '#8f1d1d' }}>{error}</p>}

        <div className="drawer-items" aria-live="polite">
          {loading ? (
            <p>Carregando suas peças…</p>
          ) : !cart?.lines.length ? (
            <div className="drawer-empty">
              <ShoppingBag size={40} strokeWidth={1} />
              <h3>Uma viagem cheia de possibilidades.</h3>
              <p>Escolha suas peças e comece a preparar o seu próximo closet.</p>
              <Link href="/pecas" onClick={close} className="editorial-button">
                Explorar peças <ArrowUpRight size={18} />
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
                <div className="drawer-item" key={line.id}>
                  {line.merchandise.product.featuredImage && (
                    <Image
                      src={line.merchandise.product.featuredImage.url}
                      alt={line.merchandise.product.title}
                      width={80}
                      height={105}
                    />
                  )}

                  <div className="min-w-0 flex-1">
                    <Link href={`/pecas/${line.merchandise.product.handle}`} onClick={close}>
                      {line.merchandise.product.title}
                    </Link>

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

                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-[0.72rem] text-ink/60">Quantidade</span>
                      <div className="inline-flex items-center overflow-hidden rounded-lg border border-ink/15">
                        <button
                          type="button"
                          aria-label="Diminuir quantidade"
                          disabled={busy || line.quantity <= 1}
                          onClick={() => void changeQuantity(line, line.quantity - 1)}
                          className="grid h-8 w-8 place-items-center transition hover:bg-ink/5 disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <Minus size={13} />
                        </button>
                        <span className="min-w-8 text-center text-sm font-semibold tabular-nums">
                          {busy ? '…' : line.quantity}
                        </span>
                        <button
                          type="button"
                          aria-label="Aumentar quantidade"
                          disabled={busy || !canIncrease}
                          onClick={() => void changeQuantity(line, line.quantity + 1)}
                          className="grid h-8 w-8 place-items-center transition hover:bg-ink/5 disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <Plus size={13} />
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => void removeLine(line.id)}
                        disabled={busy}
                        className="text-[0.7rem] text-ink/50 underline underline-offset-2 hover:text-marsala disabled:opacity-40"
                      >
                        Remover
                      </button>
                    </div>

                    {line.attributes
                      .filter((a) => a.key === 'Retirada' || a.key === 'Devolução')
                      .map((a) => <p key={a.key}>{a.key}: {a.value}</p>)}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {!loading && cart && cart.lines.length > 0 && (
          <div className="drawer-bottom">
            <p>
              Total{' '}
              <strong>
                {new Intl.NumberFormat('pt-BR', {
                  style: 'currency',
                  currency: cart.cost.totalAmount.currencyCode,
                }).format(Number(cart.cost.totalAmount.amount))}
              </strong>
            </p>
            <Link href="/carrinho" onClick={close} className="editorial-button">
              Revisar e finalizar reserva <ArrowUpRight size={18} />
            </Link>
            <button type="button" onClick={close}>Continuar escolhendo</button>
          </div>
        )}
      </dialog>
    </>
  );
}
