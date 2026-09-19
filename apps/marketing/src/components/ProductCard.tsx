import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { formatPrice, productUrl, type StorefrontProduct } from '@/lib/shopify';
import { ProductImage } from './ProductImage';

export function ProductCard({ product, catalog = false, priority = false }: { product: StorefrontProduct; catalog?: boolean; priority?: boolean }) {
  const Heading = catalog ? 'h2' : 'h3';
  return <Link href={productUrl(product.handle)} className={`product-editorial ${catalog ? 'catalog-product' : ''}`}>
    <div className="product-photo">
      {product.featuredImage ? <ProductImage src={product.featuredImage.url} alt={product.featuredImage.altText || product.title} fill priority={priority} sizes="(min-width: 1440px) 320px, (min-width: 1100px) 25vw, (min-width: 768px) 33vw, 50vw" /> : <span className="product-no-photo">{catalog ? 'Sem foto' : 'Foto em breve'}</span>}
      {!catalog && <span className="product-action">Ver peça <ArrowUpRight size={16} /></span>}
    </div>
    <p className="product-category">{product.productType || (catalog ? '' : 'Seleção do closet')}</p>
    <Heading>{product.title}</Heading>
    <p className="product-price">{formatPrice(product.priceRange.minVariantPrice.amount, product.priceRange.minVariantPrice.currencyCode)}</p>
  </Link>;
}
