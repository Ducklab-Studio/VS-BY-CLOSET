import Link from 'next/link';
import Image from 'next/image';
import { Star } from 'lucide-react';
import type { Product } from '@/lib/types';
import { formatPrice } from '@/lib/utils';

export function ProductCard({ product }: { product: Product }) {
  const image = product.media?.[0]?.url ?? 'https://placehold.co/600x800?text=Sem+Imagem';
  const price = Number(product.price);
  const promo = product.promoPrice ? Number(product.promoPrice) : null;
  const discount = promo ? Math.round((1 - promo / price) * 100) : 0;

  return (
    <Link
      href={`/produto/${product.slug}`}
      className="group block overflow-hidden rounded-2xl border border-white/10 bg-dusk transition hover:border-white/25"
    >
      <div className="relative aspect-[3/4] overflow-hidden bg-mist">
        <Image
          src={image}
          alt={product.name}
          fill
          sizes="(max-width: 768px) 50vw, 25vw"
          className="object-cover transition duration-500 group-hover:scale-105"
        />
        {promo && (
          <span className="absolute left-3 top-3 rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-ink">
            -{discount}%
          </span>
        )}
        {product.isNewArrival && !promo && (
          <span className="absolute left-3 top-3 rounded-full border border-white/30 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-white">
            Novo
          </span>
        )}
      </div>

      <div className="p-4">
        {product.brand && (
          <p className="text-xs uppercase tracking-widest text-white/40">{product.brand.name}</p>
        )}
        <h3 className="mt-1 line-clamp-2 text-sm font-medium text-white">{product.name}</h3>

        {product.ratingCount > 0 && (
          <div className="mt-1 flex items-center gap-1 text-xs text-white/50">
            <Star size={13} className="fill-white/70 text-white/70" />
            {Number(product.ratingAvg).toFixed(1)} ({product.ratingCount})
          </div>
        )}

        <div className="mt-2 flex items-baseline gap-2">
          {promo ? (
            <>
              <span className="text-lg font-semibold text-white">{formatPrice(promo)}</span>
              <span className="text-sm text-white/40 line-through">{formatPrice(price)}</span>
            </>
          ) : (
            <span className="text-lg font-semibold text-white">{formatPrice(price)}</span>
          )}
        </div>
        {product.maxInstallments > 1 && (
          <p className="mt-0.5 text-xs text-white/50">
            em até {product.maxInstallments}x sem juros
          </p>
        )}
      </div>
    </Link>
  );
}
