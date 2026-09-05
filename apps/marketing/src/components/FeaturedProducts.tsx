import Link from 'next/link';
import { isShopifyConfigured, listFeaturedProducts } from '@/lib/shopify';
import { ProductCard } from '@/components/ProductCard';

export async function FeaturedProducts() {
  let products: Awaited<ReturnType<typeof listFeaturedProducts>> = [];
  let failed = false;
  if (isShopifyConfigured) {
    try { products = await listFeaturedProducts(4); } catch { failed = true; }
  }
  if (!products.length) return <div className="collection-empty"><p>{failed ? 'Não foi possível carregar a seleção agora.' : 'Novas peças estão chegando ao closet.'}</p><Link href="/pecas" className="editorial-link">Explorar catálogo</Link></div>;
  return <div className="product-grid">{products.map(product => <ProductCard key={product.id} product={product} />)}</div>;
}
