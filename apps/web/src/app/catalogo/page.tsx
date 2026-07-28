import type { Metadata } from 'next';
import { BooqableEmbed } from '@/components/booqable/BooqableEmbed';

export const metadata: Metadata = {
  title: 'Coleção',
  description:
    'Macacões, jaquetas, calças, botas e acessórios de neve para alugar. Escolha suas datas e veja o que está disponível.',
};

export default function CatalogoPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-12">
      <header className="border-b border-white/10 pb-8">
        <h1 className="font-heading text-3xl">Coleção</h1>
        <p className="mt-2 max-w-2xl text-sm text-white/50">
          Defina o período da viagem para ver disponibilidade e preço reais de cada peça.
        </p>
      </header>

      {/* Escolher as datas primeiro é o que faz a lista abaixo mostrar
          disponibilidade real em vez de catálogo genérico. */}
      <div className="mt-8 max-w-xl">
        <BooqableEmbed component="datepicker" />
      </div>

      <div className="mt-10 grid gap-8 lg:grid-cols-[240px_1fr]">
        <aside className="space-y-6">
          <BooqableEmbed component="product-search" />
          <BooqableEmbed component="collections" />
        </aside>

        <div className="space-y-6">
          <BooqableEmbed component="sort" />
          <BooqableEmbed component="product-list" perPage={12} />
        </div>
      </div>
    </div>
  );
}
