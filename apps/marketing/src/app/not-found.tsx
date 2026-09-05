import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';

export const metadata: Metadata = { title: 'Página não encontrada', robots: { index: false, follow: false } };

/** Fase 10, item 4 — antes desta rota não existir, um link de peça
 *  expirado ou um endereço errado caía na página 404 genérica do
 *  Next.js, fora da identidade da marca. */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-24 text-center">
      <p className="text-[0.7rem] uppercase tracking-[0.22em] text-marsala/70">Erro 404</p>
      <h1 className="mt-3 font-heading text-2xl sm:text-3xl">Esta página saiu de temporada.</h1>
      <p className="mt-3 text-ink/70">
        O endereço pode estar incorreto ou o link expirou. Encontre sua próxima peça no closet ou volte ao início.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-5">
        <Link href="/pecas" className="editorial-button">
          Explore as peças <ArrowUpRight size={18} />
        </Link>
        <Link href="/" className="text-sm font-medium text-marsala underline underline-offset-4 hover:no-underline">
          Voltar ao início
        </Link>
      </div>
    </div>
  );
}
