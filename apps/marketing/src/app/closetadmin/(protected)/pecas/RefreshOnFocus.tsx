'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

const MIN_INTERVAL_MS = 30_000;

/**
 * A sincronização com a Shopify (webhook de produto + reconciliação periódica)
 * acontece no servidor, fora desta tela. Ao voltar para a aba, os dados são
 * relidos sozinhos (SKU, status, peças) — sem recarregar a página e sem
 * polling contínuo contra a Admin API. No máximo uma vez a cada 30 s.
 */
export function RefreshOnFocus() {
  const router = useRouter();
  const lastRefresh = useRef(0);

  useEffect(() => {
    lastRefresh.current = Date.now(); // a página acabou de ser renderizada com dados novos
    function refreshIfStale() {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRefresh.current < MIN_INTERVAL_MS) return;
      lastRefresh.current = Date.now();
      router.refresh();
    }
    document.addEventListener('visibilitychange', refreshIfStale);
    window.addEventListener('focus', refreshIfStale);
    return () => {
      document.removeEventListener('visibilitychange', refreshIfStale);
      window.removeEventListener('focus', refreshIfStale);
    };
  }, [router]);

  return null;
}
