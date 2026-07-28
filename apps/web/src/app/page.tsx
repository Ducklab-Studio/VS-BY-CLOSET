import Link from 'next/link';
import { ArrowRight, Truck, ShieldCheck, RefreshCw, CreditCard } from 'lucide-react';
import { api } from '@/lib/api';
import { ProductCard } from '@/components/product/ProductCard';
import type { Product } from '@/lib/types';

// Busca produtos com fallback silencioso (não quebra a home se a API cair).
async function safeList(query: Record<string, string | number>): Promise<Product[]> {
  try {
    const res = await api.products.list(query);
    return res.items;
  } catch {
    return [];
  }
}

const categories = [
  { slug: 'moon-boots', name: 'Moon Boots', img: 'https://placehold.co/400x500/171717/e5e5e5?text=Moon+Boots' },
  { slug: 'botas', name: 'Botas de Neve', img: 'https://placehold.co/400x500/171717/e5e5e5?text=Botas' },
  { slug: 'acessorios', name: 'Acessórios', img: 'https://placehold.co/400x500/171717/e5e5e5?text=Acessorios' },
  { slug: 'kits', name: 'Kits', img: 'https://placehold.co/400x500/171717/e5e5e5?text=Kits' },
];

const benefits = [
  { icon: Truck, title: 'Frete grátis', desc: 'Acima de R$ 299' },
  { icon: CreditCard, title: 'Até 6x sem juros', desc: 'No cartão' },
  { icon: RefreshCw, title: 'Troca fácil', desc: '30 dias para trocar' },
  { icon: ShieldCheck, title: 'Compra segura', desc: 'Dados protegidos' },
];

export default async function HomePage() {
  const [featured, newArrivals] = await Promise.all([
    safeList({ limit: 8 }),
    safeList({ sort: 'recent', limit: 4 }),
  ]);

  return (
    <>
      {/* ── Banner principal ───────────────────────────────────────────── */}
      <section className="relative overflow-hidden bg-ink text-white">
        <div className="mx-auto flex max-w-7xl flex-col items-start gap-6 px-4 py-20 md:py-28">
          <span className="rounded-full border border-white/20 px-4 py-1.5 text-xs font-medium uppercase tracking-widest text-white/70 animate-fade-in-up">
            Exclusive Collection · Inverno 2026
          </span>
          <h1 className="font-heading max-w-2xl text-4xl leading-tight animate-fade-in-up md:text-6xl">
            Moon Boots e acessórios para viver a neve
          </h1>
          <p className="max-w-lg text-lg text-white/60 animate-fade-in-up">
            Moon Boots e acessórios premium com alto desempenho térmico. Qualidade selecionada, entrega rápida.
          </p>
          <Link href="/produtos" className="btn-pill btn-pill-solid group">
            Comprar agora
            <ArrowRight size={18} className="transition group-hover:translate-x-1" />
          </Link>
        </div>
      </section>

      {/* ── Benefícios ─────────────────────────────────────────────────── */}
      <section className="border-b border-white/10">
        <div className="mx-auto grid max-w-7xl grid-cols-2 gap-6 px-4 py-8 md:grid-cols-4">
          {benefits.map((b) => (
            <div key={b.title} className="flex items-center gap-3">
              <b.icon className="text-white/70" size={28} />
              <div>
                <p className="text-sm font-semibold text-white">{b.title}</p>
                <p className="text-xs text-white/50">{b.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Categorias ─────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-4 py-16">
        <h2 className="font-heading mb-8 text-2xl text-white">Compre por categoria</h2>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {categories.map((cat) => (
            <Link
              key={cat.slug}
              href={`/produtos?category=${cat.slug}`}
              className="group relative aspect-[4/5] overflow-hidden rounded-2xl border border-white/10"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={cat.img}
                alt={cat.name}
                className="h-full w-full object-cover opacity-80 transition duration-500 group-hover:scale-105 group-hover:opacity-100"
              />
              <div className="absolute inset-0 flex items-end bg-gradient-to-t from-black/70 to-transparent p-4">
                <span className="font-heading text-lg text-white">{cat.name}</span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* ── Produtos em destaque ───────────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-8 flex items-center justify-between">
          <h2 className="font-heading text-2xl text-white">Destaques</h2>
          <Link
            href="/produtos"
            className="flex items-center gap-1 text-sm font-medium uppercase tracking-widest text-white/60 hover:text-white"
          >
            Ver todos <ArrowRight size={16} />
          </Link>
        </div>

        {featured.length > 0 ? (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {featured.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        ) : (
          <EmptyHint />
        )}
      </section>

      {/* ── Banner secundário ──────────────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-4 py-8">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col justify-center rounded-2xl border border-white/10 bg-dusk p-10 text-white">
            <p className="text-xs font-medium uppercase tracking-widest text-white/50">Promoção</p>
            <h3 className="font-heading mt-2 text-2xl">Moon Boots com desconto progressivo</h3>
            <p className="mt-2 text-white/60">Descontos em Moon Boots e kits selecionados.</p>
            <Link href="/produtos?onSale=true" className="mt-4 font-semibold text-white hover:underline">
              Aproveitar →
            </Link>
          </div>
          <div className="flex flex-col justify-center rounded-2xl border border-white/10 bg-mist p-10">
            <p className="text-xs font-medium uppercase tracking-widest text-white/50">Novidades</p>
            <h3 className="font-heading mt-2 text-2xl text-white">Lançamentos da temporada</h3>
            <p className="mt-2 text-white/60">Os acessórios de neve mais desejados acabaram de chegar.</p>
            <Link href="/produtos?sort=recent" className="mt-4 font-semibold text-white hover:underline">
              Ver lançamentos →
            </Link>
          </div>
        </div>
      </section>

      {/* ── Lançamentos ────────────────────────────────────────────────── */}
      {newArrivals.length > 0 && (
        <section className="mx-auto max-w-7xl px-4 py-12">
          <h2 className="font-heading mb-8 text-2xl text-white">Lançamentos</h2>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {newArrivals.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function EmptyHint() {
  return (
    <div className="rounded-2xl border border-dashed border-white/15 p-10 text-center text-sm text-white/50">
      Nenhum produto carregado. Suba a API e rode o seed do banco
      (<code className="rounded bg-white/10 px-1.5 py-0.5">pnpm db:seed</code>) para ver os produtos
      aqui.
    </div>
  );
}
