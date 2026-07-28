'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Menu, X } from 'lucide-react';
import { BooqableEmbed } from '@/components/booqable/BooqableEmbed';

const navLinks = [
  { href: '/catalogo', label: 'Coleção' },
  { href: '/como-funciona', label: 'Como funciona' },
  { href: '/faq', label: 'Dúvidas' },
  { href: '/contato', label: 'Contato' },
];

export function Header() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-ink/90 backdrop-blur">
      <div className="border-b border-white/10 py-2 text-center text-[11px] font-medium uppercase tracking-widest text-white/70">
        Envio para todo o Brasil · Devolva sem lavar
      </div>

      <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-4">
        <button
          className="text-white md:hidden"
          aria-label="Abrir menu"
          onClick={() => setMobileOpen((v) => !v)}
        >
          {mobileOpen ? <X size={24} /> : <Menu size={24} />}
        </button>

        <Link href="/" className="font-heading text-xl tracking-widest text-white">
          VALLE<span className="text-white/60">SHOWROOM</span>
        </Link>

        <nav className="hidden flex-1 items-center gap-6 md:flex" aria-label="Principal">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-xs font-medium uppercase tracking-widest text-white/70 transition hover:text-white"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Carrinho e conta ficam por conta do Booqable: ele guarda o período
            da reserva junto dos itens, coisa que um carrinho nosso não saberia. */}
        <div className="ml-auto flex items-center gap-3">
          <BooqableEmbed component="sidebar" />
        </div>
      </div>

      {mobileOpen && (
        <nav className="border-t border-white/10 bg-ink px-4 py-3 md:hidden" aria-label="Mobile">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setMobileOpen(false)}
              className="block py-2 text-sm font-medium uppercase tracking-widest text-white/70"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
