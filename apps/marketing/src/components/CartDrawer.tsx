'use client';

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { ShoppingBag } from 'lucide-react';

const CartDrawerDialog = dynamic(() => import('./CartDrawerDialog'), {
  ssr: false,
  loading: () => null,
});

export function CartDrawer() {
  const [open, setOpen] = useState(false);
  const [addedPieces, setAddedPieces] = useState(0);

  const show = useCallback((pieces = 0) => {
    setAddedPieces(pieces);
    setOpen(true);
  }, []);

  useEffect(() => {
    const addedToCart = (event: Event) => {
      const pieces = (event as CustomEvent<{ pieces?: number }>).detail?.pieces;
      show(typeof pieces === 'number' && pieces > 0 ? pieces : 1);
    };
    window.addEventListener('closet:cart-added', addedToCart);
    return () => window.removeEventListener('closet:cart-added', addedToCart);
  }, [show]);

  return (
    <>
      <button
        type="button"
        aria-label="Abrir carrinho"
        onClick={() => show()}
        className="cart-trigger relative transition-transform hover:scale-105 active:scale-95"
      >
        <ShoppingBag size={20} />
      </button>

      {open && (
        <CartDrawerDialog
          open={open}
          onClose={() => setOpen(false)}
          initialAddedPieces={addedPieces}
        />
      )}
    </>
  );
}
