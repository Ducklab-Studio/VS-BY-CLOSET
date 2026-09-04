'use client';

import { useEffect } from 'react';
import { STOP_SCRUB_FN } from '@/lib/extension-attrs';

/**
 * Desliga o MutationObserver de `extension-attrs.ts` assim que a hidratação
 * termina.
 *
 * `useEffect` só roda depois do React hidratar a árvore, que é exatamente o
 * momento em que os atributos de extensão deixam de importar: o React não
 * revalida o DOM contra o HTML do servidor depois disso. Desligar aqui evita
 * ficar removendo atributo que a extensão reinsere pelo resto da sessão.
 */
export function ExtensionAttrGuard() {
  useEffect(() => {
    (window as unknown as Record<string, (() => void) | undefined>)[
      STOP_SCRUB_FN
    ]?.();
  }, []);

  return null;
}
