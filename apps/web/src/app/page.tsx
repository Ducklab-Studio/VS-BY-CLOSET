import Link from 'next/link';
import { CalendarDays, Package, Truck, Sparkles } from 'lucide-react';
import { BooqableEmbed } from '@/components/booqable/BooqableEmbed';

export default function HomePage() {
  return (
    <>
      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="border-b border-white/10 px-4 py-20 sm:py-28">
        <div className="mx-auto max-w-5xl text-center">
          <p className="text-xs uppercase tracking-[0.3em] text-white/50">
            Aluguel e venda de roupa de neve
          </p>
          <h1 className="font-heading mt-5 text-4xl leading-tight sm:text-6xl">
            A neve não espera
            <br />
            seu guarda-roupa
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base text-white/60 sm:text-lg">
            Alugue macacões, jaquetas e botas premium pelo período exato da sua viagem. Gostou da
            peça? Você também pode comprar.
          </p>

          {/* O seletor de datas define o período e faz todo o catálogo passar a
              mostrar disponibilidade e preço reais para essas datas. */}
          <div className="mx-auto mt-10 max-w-xl">
            <BooqableEmbed component="datepicker" />
          </div>

          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/catalogo" className="btn-pill btn-pill-solid">
              Ver coleção
            </Link>
            <Link href="/como-funciona" className="btn-pill">
              Como funciona
            </Link>
          </div>
        </div>
      </section>

      {/* ── Como funciona (resumo) ────────────────────────────────────────── */}
      <section className="border-b border-white/10 px-4 py-16">
        <div className="mx-auto grid max-w-6xl gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              icon: CalendarDays,
              title: 'Escolha as datas',
              text: 'Informe ida e volta da viagem. Mostramos só o que está disponível no período.',
            },
            {
              icon: Package,
              title: 'Monte o look',
              text: 'Macacão, jaqueta, calça, botas e acessórios. Alugue ou compre cada peça.',
            },
            {
              icon: Truck,
              title: 'Receba em casa',
              text: 'Enviamos com antecedência para todo o Brasil, higienizado e pronto para usar.',
            },
            {
              icon: Sparkles,
              title: 'Devolva sem lavar',
              text: 'A higienização é por nossa conta. Na volta, é só postar.',
            },
          ].map((step, i) => (
            <div key={step.title}>
              <div className="flex items-center gap-3">
                <span className="font-heading text-2xl text-white/25">0{i + 1}</span>
                <step.icon size={18} className="text-white/50" />
              </div>
              <h3 className="font-heading mt-4 text-sm tracking-widest">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-white/50">{step.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Categorias ────────────────────────────────────────────────────── */}
      <section className="border-b border-white/10 px-4 py-16">
        <div className="mx-auto max-w-6xl">
          <h2 className="font-heading text-center text-2xl">Navegue por categoria</h2>
          <div className="mt-10">
            <BooqableEmbed component="collections" />
          </div>
        </div>
      </section>

      {/* ── Destaques ─────────────────────────────────────────────────────── */}
      <section className="px-4 py-16">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="font-heading text-2xl">Mais alugados</h2>
              <p className="mt-2 text-sm text-white/50">
                As peças que mais saem no inverno — reserve com antecedência.
              </p>
            </div>
            <Link
              href="/catalogo"
              className="text-xs uppercase tracking-widest text-white/60 hover:text-white"
            >
              Ver tudo
            </Link>
          </div>

          <div className="mt-10">
            <BooqableEmbed component="product-list" limit={8} perPage={8} />
          </div>
        </div>
      </section>
    </>
  );
}
