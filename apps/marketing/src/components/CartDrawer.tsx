'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ShoppingBag, X, ArrowUpRight } from 'lucide-react';
import { getCart, type Cart } from '@/lib/cart';

export function CartDrawer() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [cart, setCart] = useState<Cart | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [added, setAdded] = useState(false);
  const [open, setOpen] = useState(false);
  const request = useRef({ id: 0 });
  async function show(wasAdded = false) {
    setAdded(wasAdded); setOpen(true); dialog.current?.showModal(); setLoading(true); setError(false);
    const id = ++request.current.id;
    try { const result = await getCart(); if (id === request.current.id) setCart(result); }
    catch { if (id === request.current.id) setError(true); }
    finally { if (id === request.current.id) setLoading(false); }
  }
  useEffect(() => {
    const pending = request.current;
    const addedToCart = () => { void show(true); };
    window.addEventListener('closet:cart-added', addedToCart);
    return () => { window.removeEventListener('closet:cart-added', addedToCart); pending.id++; };
  }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);
  const close = () => dialog.current?.close();
  return <>
    <button type="button" aria-label="Abrir carrinho" onClick={() => void show()} className="cart-trigger"><ShoppingBag size={20} /></button>
    <dialog ref={dialog} className="cart-drawer" aria-labelledby="cart-drawer-title" onClose={() => setOpen(false)} onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right) close(); } }}>
      <div className="drawer-heading"><div><p className="eyebrow">Seu próximo inverno</p><h2 id="cart-drawer-title">Seu closet de viagem</h2></div><button type="button" onClick={close} aria-label="Fechar carrinho" autoFocus><X size={23} /></button></div>
      {added && <p className="cart-success" role="status">Peça adicionada ao seu carrinho.</p>}
      <div className="drawer-items" aria-live="polite">
        {loading ? <p>Carregando suas peças…</p> : error ? <p>Não foi possível carregar seu carrinho. <button onClick={() => void show(added)} className="underline">Tentar novamente</button></p> : !cart?.lines.length ? <div className="drawer-empty"><ShoppingBag size={40} strokeWidth={1} /><h3>Uma viagem cheia de possibilidades.</h3><p>Escolha suas peças e comece a preparar seu próximo inverno.</p><Link href="/pecas" onClick={close} className="editorial-button">Explorar peças <ArrowUpRight size={18} /></Link></div> : cart.lines.map(line => <div className="drawer-item" key={line.id}>
          {line.merchandise.product.featuredImage && <Image src={line.merchandise.product.featuredImage.url} alt={line.merchandise.product.title} width={80} height={105} />}
          <div><Link href={`/pecas/${line.merchandise.product.handle}`} onClick={close}>{line.merchandise.product.title}</Link><p>Quantidade: {line.quantity}</p>{line.attributes.filter(a => a.key === 'Retirada' || a.key === 'Devolução').map(a => <p key={a.key}>{a.key}: {a.value}</p>)}</div>
        </div>)}
      </div>
      {!loading && !error && cart && cart.lines.length > 0 && <div className="drawer-bottom"><p>Total <strong>{new Intl.NumberFormat('pt-BR', { style: 'currency', currency: cart.cost.totalAmount.currencyCode }).format(Number(cart.cost.totalAmount.amount))}</strong></p><Link href="/carrinho" onClick={close} className="editorial-button">Revisar e finalizar reserva <ArrowUpRight size={18} /></Link><button type="button" onClick={close}>Continuar escolhendo</button></div>}
    </dialog>
  </>;
}
