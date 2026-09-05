'use client';
import { useRef } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowUpRight } from 'lucide-react';
import type { StorefrontProduct } from '@/lib/shopify';

export function ProductCard({ product }: { product: StorefrontProduct }) {
  const card = useRef<HTMLAnchorElement>(null);
  const second = product.images?.nodes.find(image => image.url !== product.featuredImage?.url);
  return <Link ref={card} href={`/pecas/${product.handle}`} className="product-editorial" onPointerMove={event => {
    if (!window.matchMedia('(pointer: fine) and (prefers-reduced-motion: no-preference)').matches) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty('--rx', `${-(event.clientY - bounds.top - bounds.height / 2) / bounds.height * 5}deg`);
    event.currentTarget.style.setProperty('--ry', `${(event.clientX - bounds.left - bounds.width / 2) / bounds.width * 5}deg`);
  }} onPointerLeave={() => { card.current?.style.setProperty('--rx', '0deg'); card.current?.style.setProperty('--ry', '0deg'); }}>
    <div className="product-photo">
      {product.featuredImage ? <Image src={product.featuredImage.url} alt={product.featuredImage.altText ?? product.title} fill sizes="(max-width: 760px) 45vw, 25vw" className="product-primary" /> : <span className="product-no-photo">Foto em breve</span>}
      {second && <Image src={second.url} alt={second.altText ?? `${product.title}, outro ângulo`} fill sizes="(max-width: 760px) 45vw, 25vw" className="product-secondary" />}
      <span className="product-action">Ver peça <ArrowUpRight size={16} /></span>
    </div>
    <p className="product-category">{product.productType || 'Seleção do closet'}</p><h3>{product.title}</h3>
    <p className="product-price">{new Intl.NumberFormat('pt-BR', { style: 'currency', currency: product.priceRange.minVariantPrice.currencyCode }).format(Number(product.priceRange.minVariantPrice.amount))}</p>
  </Link>;
}
