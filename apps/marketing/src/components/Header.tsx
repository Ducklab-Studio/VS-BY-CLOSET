'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Menu, X, User, ShoppingBag } from 'lucide-react';
import { isStoreUrlConfigured, storeUrl } from '@/lib/shopify';

const navLinks = [
  { href: '/como-funciona', label: 'Como funciona' },
  { href: '/faq', label: 'Dúvidas' },
  { href: '/contato', label: 'Contato' },
];

/**
 * Coleção, carrinho e conta ficam por conta do Shopify — só aparecem quando
 * NEXT_PUBLIC_SHOPIFY_STORE_URL está configurada. Sem isso, mostrar o link
 * levaria a lugar nenhum; melhor escondê-lo até a loja existir de verdade.
 */
export function Header() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-ink/10 bg-cream/90 backdrop-blur">
      <div className="border-b border-ink/10 py-2 text-center text-[11px] font-medium uppercase tracking-widest text-ink/60">
        Reserve online · Retire ao chegar no Chile
      </div>

      <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-4">
        <button
          className="text-ink md:hidden"
          aria-label="Abrir menu"
          onClick={() => setMobileOpen((v) => !v)}
        >
          {mobileOpen ? <X size={24} /> : <Menu size={24} />}
        </button>

        <Link href="/" className="font-heading text-xl tracking-widest text-marsala">
          VALLE&apos;S<span className="text-ink">CLOSET</span>
        </Link>

        <nav className="hidden flex-1 items-center gap-6 md:flex" aria-label="Principal">
          {isStoreUrlConfigured && (
            <a
              href={storeUrl('/collections/all')}
              className="text-xs font-medium uppercase tracking-widest text-ink/70 transition hover:text-marsala"
            >
              Coleção
            </a>
          )}
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-xs font-medium uppercase tracking-widest text-ink/70 transition hover:text-marsala"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-4">
          {isStoreUrlConfigured && (
            <>
              <a
                href={storeUrl('/account')}
                aria-label="Minha conta"
                className="text-ink/70 transition hover:text-marsala"
              >
                <User size={20} />
              </a>
              <a
                href={storeUrl('/cart')}
                aria-label="Carrinho"
                className="text-ink/70 transition hover:text-marsala"
              >
                <ShoppingBag size={20} />
              </a>
            </>
          )}
        </div>
      </div>

      {mobileOpen && (
        <nav className="border-t border-ink/10 bg-cream px-4 py-3 md:hidden" aria-label="Mobile">
          {isStoreUrlConfigured && (
            <a
              href={storeUrl('/collections/all')}
              className="block py-2 text-sm font-medium uppercase tracking-widest text-ink/70"
            >
              Coleção
            </a>
          )}
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setMobileOpen(false)}
              className="block py-2 text-sm font-medium uppercase tracking-widest text-ink/70"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
