import Image from 'next/image';
import { isShopifyConfigured, listFeaturedProducts, productUrl } from '@/lib/shopify';

/**
 * Vitrine somente leitura. O clique em cada card leva ao tema Shopify — lá,
 * e só lá, o widget de aluguel do PRP e o checkout funcionam.
 */
export async function FeaturedProducts() {
  if (!isShopifyConfigured) {
    return (
      <div className="rounded-2xl border border-dashed border-white/20 p-8 text-center text-sm text-white/50">
        Storefront API não configurada — defina NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN e
        NEXT_PUBLIC_SHOPIFY_STOREFRONT_TOKEN no .env para carregar os produtos.
      </div>
    );
  }

  let products: Awaited<ReturnType<typeof listFeaturedProducts>> = [];
  try {
    products = await listFeaturedProducts(8);
  } catch (err) {
    return (
      <div className="rounded-2xl border border-red-400/30 bg-red-400/10 p-6 text-sm text-red-300">
        Não foi possível carregar os produtos: {(err as Error).message}
      </div>
    );
  }

  if (products.length === 0) {
    return <p className="text-center text-sm text-white/50">Nenhum produto publicado ainda.</p>;
  }

  return (
    <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4">
      {products.map((product) => (
        <a key={product.id} href={productUrl(product.handle)} className="group block">
          {product.featuredImage && (
            <div className="aspect-[3/4] overflow-hidden rounded-xl bg-surface">
              <Image
                src={product.featuredImage.url}
                alt={product.featuredImage.altText ?? product.title}
                width={600}
                height={800}
                className="h-full w-full object-cover transition group-hover:scale-105"
              />
            </div>
          )}
          <p className="mt-3 text-sm">{product.title}</p>
          <p className="text-xs text-muted">
            {new Intl.NumberFormat('pt-BR', {
              style: 'currency',
              currency: product.priceRange.minVariantPrice.currencyCode,
            }).format(Number(product.priceRange.minVariantPrice.amount))}
          </p>
        </a>
      ))}
    </div>
  );
}
