'use client';

import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { BOOQABLE_SCRIPT_URL, isBooqableConfigured, refreshBooqable } from '@/lib/booqable';

/**
 * Carrega o script do Booqable uma única vez e o reativa a cada navegação.
 *
 * Fica no layout raiz para que o script permaneça vivo entre as rotas — se
 * fosse montado por página, cada navegação recarregaria a integração e perderia
 * o estado do carrinho.
 */
export function BooqableScript() {
  const pathname = usePathname();
  const loaded = useRef(false);

  useEffect(() => {
    if (!loaded.current) return;
    // A navegação do App Router troca o DOM sem recarregar a página; sem este
    // reinit os componentes da nova rota ficariam como divs vazias.
    // Um frame de atraso garante que o React já pintou os elementos.
    const id = requestAnimationFrame(() => refreshBooqable());
    return () => cancelAnimationFrame(id);
  }, [pathname]);

  if (!isBooqableConfigured || !BOOQABLE_SCRIPT_URL) return null;

  return (
    <Script
      src={BOOQABLE_SCRIPT_URL}
      strategy="afterInteractive"
      onReady={() => {
        loaded.current = true;
        refreshBooqable();
      }}
    />
  );
}
