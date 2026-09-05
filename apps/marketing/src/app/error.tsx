'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';

/** Fase 10, item 4 — limite de erro do site público. Cobre uma falha
 *  inesperada de Server Component (ex.: a Storefront API responder algo
 *  fora do previsto) com uma tela on-brand em vez do erro genérico do
 *  Next.js. Erros já tratados nas próprias páginas (loja fora do ar,
 *  catálogo não configurado) continuam com seus estados dedicados e
 *  nunca chegam até aqui. */
export default function GlobalPageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl px-6 py-24 text-center">
      <p className="text-[0.7rem] uppercase tracking-[0.22em] text-marsala/70">Algo não saiu como esperado</p>
      <h1 className="mt-3 font-heading text-2xl sm:text-3xl">Não conseguimos carregar esta página.</h1>
      <p className="mt-3 text-ink/70">Foi um erro pontual. Tente novamente ou continue explorando o closet.</p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-5">
        <button type="button" onClick={reset} className="editorial-button">
          Tentar novamente
        </button>
        <Link href="/pecas" className="text-sm font-medium text-marsala underline underline-offset-4 hover:no-underline">
          Ver as peças <ArrowUpRight size={14} className="inline" />
        </Link>
      </div>
    </div>
  );
}
