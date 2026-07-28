'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Search, ShoppingBag, User, Heart, Menu, X } from 'lucide-react';

const navLinks = [
  { href: '/produtos', label: 'Todos' },
  { href: '/produtos?category=moon-boots', label: 'Moon Boots' },
  { href: '/produtos?category=botas', label: 'Botas de Neve' },
  { href: '/produtos?category=acessorios', label: 'Acessórios' },
  { href: '/produtos?onSale=true', label: 'Promoções' },
];

export function Header() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-ink/90 backdrop-blur">
      {/* Barra de aviso */}
      <div className="border-b border-white/10 py-2 text-center text-[11px] font-medium uppercase tracking-widest text-white/70">
        Frete grátis acima de R$ 299 · Moon Boots com até 6x sem juros
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
          MINHA<span className="text-white/60">LOJA</span>
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

        <form action="/produtos" className="ml-auto hidden flex-1 max-w-xs md:block">
          <div className="relative">
            <Search
              size={18}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/40"
            />
            <input
              type="search"
              name="search"
              placeholder="Buscar produtos..."
              aria-label="Buscar produtos"
              className="w-full rounded-full border border-white/15 bg-white/5 py-2 pl-10 pr-4 text-sm text-white outline-none placeholder:text-white/40 focus:border-white/40"
            />
          </div>
        </form>

        <div className="flex items-center gap-3">
          <Link href="/conta/favoritos" aria-label="Favoritos" className="text-white/70 hover:text-white">
            <Heart size={22} />
          </Link>
          <Link href="/login" aria-label="Minha conta" className="text-white/70 hover:text-white">
            <User size={22} />
          </Link>
          <Link
            href="/carrinho"
            aria-label="Carrinho"
            className="relative text-white/70 hover:text-white"
          >
            <ShoppingBag size={22} />
          </Link>
        </div>
      </div>

      {/* Menu mobile */}
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
