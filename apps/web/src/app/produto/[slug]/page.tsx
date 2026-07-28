import Image from 'next/image';
import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Star, Truck, ShieldCheck, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { formatPrice, installments } from '@/lib/utils';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  try {
    const p = await api.products.bySlug(slug);
    return {
      title: p.name,
      description: p.description.slice(0, 160),
      openGraph: { images: p.media?.[0]?.url ? [p.media[0].url] : [] },
    };
  } catch {
    return { title: 'Produto' };
  }
}

export default async function ProductPage({ params }: Props) {
  const { slug } = await params;

  let product;
  try {
    product = await api.products.bySlug(slug);
  } catch {
    notFound();
  }

  const price = Number(product.price);
  const promo = product.promoPrice ? Number(product.promoPrice) : null;
  const finalPrice = promo ?? price;
  const pixDiscount = product.pixDiscountPct ? Number(product.pixDiscountPct) : 0;
  const pixPrice = finalPrice * (1 - pixDiscount / 100);

  const colors = Array.from(
    new Map(
      (product.variants ?? [])
        .filter((v) => v.color)
        .map((v) => [v.color, { color: v.color!, hex: v.colorHex }]),
    ).values(),
  );
  const sizes = Array.from(new Set((product.variants ?? []).map((v) => v.size).filter(Boolean)));

  // Dados estruturados para SEO (rich results)
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: product.description,
    sku: product.sku,
    brand: product.brand?.name,
    image: product.media?.map((m) => m.url),
    offers: {
      '@type': 'Offer',
      price: finalPrice,
      priceCurrency: 'BRL',
      availability: 'https://schema.org/InStock',
    },
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-10">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <nav className="mb-6 text-sm text-white/50">
        <Link href="/" className="hover:text-white">
          Início
        </Link>{' '}
        /{' '}
        <Link href="/produtos" className="hover:text-white">
          Produtos
        </Link>{' '}
        / <span className="text-white">{product.name}</span>
      </nav>

      <div className="grid gap-10 md:grid-cols-2">
        {/* Galeria */}
        <div>
          <div className="relative aspect-[3/4] overflow-hidden rounded-2xl bg-mist">
            <Image
              src={product.media?.[0]?.url ?? 'https://placehold.co/600x800'}
              alt={product.name}
              fill
              sizes="(max-width: 768px) 100vw, 50vw"
              className="object-cover"
              priority
            />
          </div>
          {product.media && product.media.length > 1 && (
            <div className="mt-4 grid grid-cols-5 gap-2">
              {product.media.slice(0, 5).map((m) => (
                <div key={m.id} className="relative aspect-square overflow-hidden rounded-lg bg-mist">
                  <Image src={m.url} alt={m.alt ?? product.name} fill sizes="20vw" className="object-cover" />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Info */}
        <div>
          {product.brand && (
            <p className="text-sm uppercase tracking-widest text-white/40">{product.brand.name}</p>
          )}
          <h1 className="font-heading mt-1 text-3xl text-white">{product.name}</h1>

          {product.ratingCount > 0 && (
            <div className="mt-2 flex items-center gap-1 text-sm text-white/60">
              <Star size={16} className="fill-white/70 text-white/70" />
              {Number(product.ratingAvg).toFixed(1)} · {product.ratingCount} avaliações
            </div>
          )}

          <div className="mt-6">
            <div className="flex items-baseline gap-3">
              <span className="text-3xl font-semibold text-white">{formatPrice(finalPrice)}</span>
              {promo && <span className="text-lg text-white/40 line-through">{formatPrice(price)}</span>}
            </div>
            {pixDiscount > 0 && (
              <p className="mt-1 text-sm font-medium text-green-400">
                {formatPrice(pixPrice)} no PIX ({pixDiscount}% off)
              </p>
            )}
            <p className="mt-1 text-sm text-white/50">
              {installments(finalPrice, product.maxInstallments)}
            </p>
          </div>

          {/* Cores */}
          {colors.length > 0 && (
            <div className="mt-6">
              <p className="mb-2 text-sm font-medium text-white/80">Cor</p>
              <div className="flex gap-2">
                {colors.map((c) => (
                  <button
                    key={c.color}
                    title={c.color}
                    aria-label={c.color}
                    className="h-9 w-9 rounded-full border border-white/20 ring-offset-2 ring-offset-ink focus:ring-2 focus:ring-white/60"
                    style={{ backgroundColor: c.hex ?? '#ddd' }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Tamanhos */}
          {sizes.length > 0 && (
            <div className="mt-6">
              <p className="mb-2 text-sm font-medium text-white/80">Tamanho</p>
              <div className="flex flex-wrap gap-2">
                {sizes.map((s) => (
                  <button
                    key={s}
                    className="min-w-12 rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-white/80 hover:border-white/50 hover:text-white"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          <button className="btn-pill btn-pill-solid mt-8 w-full justify-center py-4">
            Adicionar ao carrinho
          </button>

          {/* Garantias */}
          <div className="mt-6 grid grid-cols-3 gap-3 border-t border-white/10 pt-6 text-center text-xs text-white/60">
            <div className="flex flex-col items-center gap-1">
              <Truck size={20} className="text-white/70" /> Frete rápido
            </div>
            <div className="flex flex-col items-center gap-1">
              <RefreshCw size={20} className="text-white/70" /> Troca em 30 dias
            </div>
            <div className="flex flex-col items-center gap-1">
              <ShieldCheck size={20} className="text-white/70" /> Compra segura
            </div>
          </div>

          {/* Descrição */}
          <div className="mt-8 border-t border-white/10 pt-6">
            <h2 className="font-heading text-lg text-white">Descrição</h2>
            <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-white/60">
              {product.description}
            </p>
            {product.material && (
              <p className="mt-3 text-sm text-white/60">
                <strong>Material:</strong> {product.material}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
