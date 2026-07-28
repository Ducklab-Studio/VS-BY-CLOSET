import Link from 'next/link';
import type { Metadata } from 'next';
import { ShoppingBag } from 'lucide-react';

export const metadata: Metadata = { title: 'Carrinho' };

export default function CartPage() {
  // Estrutura da UI do carrinho. A lógica de estado (Zustand) e integração
  // com a API de carrinho serão conectadas na fase de checkout — ver ROADMAP.
  return (
    <div className="mx-auto max-w-2xl px-4 py-20 text-center">
      <ShoppingBag className="mx-auto text-white/30" size={64} />
      <h1 className="font-heading mt-6 text-2xl text-white">Seu carrinho está vazio</h1>
      <p className="mt-2 text-white/50">Adicione produtos para continuar a compra.</p>
      <Link href="/produtos" className="btn-pill btn-pill-solid mt-6 inline-flex">
        Ver produtos
      </Link>
    </div>
  );
}
