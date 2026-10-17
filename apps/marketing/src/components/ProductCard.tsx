import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { formatPrice, productUrl, type StorefrontProduct } from '@/lib/shopify';
import { isValePassProduct } from '@/lib/vale-pass-product';
import { ProductImage } from './ProductImage';
import { SelectionFlag } from './RentalSelectionBar';

/** Largura real da foto em cada layout (catalog.css / .product-grid): com 4 colunas até 1440px. */
const DEFAULT_SIZES =
  '(min-width: 1440px) 340px, (min-width: 1100px) 25vw, (min-width: 768px) 33vw, 50vw';

export function ProductCard({
  product,
  catalog = false,
  priority = false,
  imageSizes = DEFAULT_SIZES,
  draftRaw = null,
}: {
  product: StorefrontProduct;
  catalog?: boolean;
  priority?: boolean;
  imageSizes?: string;
  draftRaw?: string | null;
}) {
  const Heading = catalog ? 'h2' : 'h3';
  const awaiting = product.rentalStatus === 'awaiting';
  // Valle Pass não é peça de aluguel: o cartão não deve chamá-lo de "peça".
  const isValePass = isValePassProduct({ productId: product.id });
  return (
    <Link
      href={productUrl(product.handle)}
      className={`product-editorial ${catalog ? 'catalog-product' : ''}`}
    >
      <div className="product-photo">
        {product.featuredImage ? (
          <ProductImage
            src={product.featuredImage.url}
            originalWidth={product.featuredImage.width}
            alt={product.featuredImage.altText || product.title}
            fill
            preload={priority}
            loading={priority ? undefined : 'lazy'}
            sizes={imageSizes}
          />
        ) : (
          <span className="product-no-photo">{catalog ? 'Sem foto' : 'Foto em breve'}</span>
        )}
        {!catalog && (
          <span className="product-action">
            {isValePass ? 'Ver Valle Pass' : 'Ver peça'} <ArrowUpRight size={16} />
          </span>
        )}
        {awaiting && (
          <span
            data-rental-status="awaiting"
            className="absolute left-3 top-3 rounded-full bg-cream/95 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-ink/70 shadow-sm"
          >
            Indisponível por enquanto
          </span>
        )}
        {catalog && !awaiting && <SelectionFlag handle={product.handle} initialRaw={draftRaw} />}
      </div>
      <p className="product-category">
        {product.productType || (catalog ? '' : isValePass ? 'Valle Pass' : 'Seleção do closet')}
      </p>
      <Heading>{product.title}</Heading>
      <p className="product-price">
        {formatPrice(
          product.priceRange.minVariantPrice.amount,
          product.priceRange.minVariantPrice.currencyCode,
        )}
      </p>
    </Link>
  );
}
