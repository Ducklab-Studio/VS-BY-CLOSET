'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Menu, X, User, ArrowUpRight } from 'lucide-react';
import { CartDrawer } from '@/components/CartDrawer';
import { isStoreUrlConfigured, storeUrl } from '@/lib/shopify';

const navLinks = [
  { href: '/pecas', label: 'Peças' },
  { href: '/como-funciona', label: 'Como funciona' },
  { href: '/faq', label: 'Dúvidas' },
  { href: '/contato', label: 'Contato' },
];

export function Header() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  useEffect(() => {
    const sync = () => setScrolled(window.scrollY > 40);
    sync();
    window.addEventListener('scroll', sync, { passive: true });
    return () => window.removeEventListener('scroll', sync);
  }, []);
  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMobileOpen(false); menuButton.current?.focus(); }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [mobileOpen]);

  return (
    <header className={`storefront-header boutique-header sticky top-0 z-50 ${scrolled ? 'is-scrolled' : ''}`}>
      <div className="boutique-announcement"><span>Reserve online</span><span className="announcement-diamond" aria-hidden="true" /><span>Retire no Chile</span></div>
      <div className="header-main boutique-main">
        <button ref={menuButton} type="button" className="boutique-menu-toggle" aria-label={mobileOpen ? 'Fechar menu' : 'Abrir menu'} aria-expanded={mobileOpen} aria-controls="mobile-navigation" onClick={() => setMobileOpen(value => !value)}>
          {mobileOpen ? <X size={22} strokeWidth={1.5} /> : <Menu size={22} strokeWidth={1.5} />}
        </button>
        <Link href="/" aria-label="VS by Closet — início" className="boutique-logo" onClick={() => setMobileOpen(false)}>
          <Image src="/brand/logo-horizontal-marsala.png" alt="VS by Closet" width={1200} height={320} priority />
        </Link>
        <nav className="boutique-desktop-nav" aria-label="Principal">
          {navLinks.map(link => <Link key={link.href} href={link.href} aria-current={pathname === link.href ? 'page' : undefined}>{link.label}</Link>)}
        </nav>
        <div className="boutique-actions">
          {isStoreUrlConfigured && <a href={storeUrl('/account')} aria-label="Minha conta" className="boutique-account"><User size={20} strokeWidth={1.5} /></a>}
          <CartDrawer />
        </div>
      </div>
      {mobileOpen && <nav id="mobile-navigation" className="boutique-mobile-nav" aria-label="Menu mobile">
        <p className="boutique-menu-eyebrow">Seu closet em todas as estações</p>
        {navLinks.map((link, index) => <Link key={link.href} href={link.href} aria-current={pathname === link.href ? 'page' : undefined} onClick={() => setMobileOpen(false)}><span className="boutique-menu-number">0{index + 1}</span><span>{link.label}</span><ArrowUpRight size={19} strokeWidth={1.3} /></Link>)}
        {isStoreUrlConfigured && <a href={storeUrl('/account')} className="boutique-mobile-account"><User size={18} strokeWidth={1.5} /><span>Minha conta e reservas</span><ArrowUpRight size={17} /></a>}
      </nav>}
    </header>
  );
}
