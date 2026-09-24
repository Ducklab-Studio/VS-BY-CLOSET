import type { Metadata } from 'next';
import { ProductCard } from '@/components/ProductCard';
import Link from 'next/link';
import {
  categoriesFromProducts,
  isShopifyConfigured,
  listCatalog,
} from '@/lib/shopify';
import { DEMO_PRODUCTS, isDemoCatalogEnabled } from '@/lib/demo-catalog';
import { CategorySelect } from '@/components/CategorySelect';

export const metadata: Metadata = {
  title: 'Peças',
  description: 'Jaquetas, sobretudos, tricôs e botas para alugar. Retire ao chegar no Chile.',
};

export const revalidate = 0;

/**
 * Catálogo, com filtro por nicho (jaquetas de couro, sobretudo de lã...).
 * Substitui o link que ia para /collections/all no tema Shopify.
 *
 * A resposta é deduplicada por ID/handle antes de renderizar para que uma
 * peça que apareça repetida na origem nunca ocupe dois cards.
 */
export default async function PecasPage({
  searchParams,
}: {
  searchParams: Promise<{ categoria?: string }>;
}) {
  const { categoria } = await searchParams;
  if (!isShopifyConfigured && !isDemoCatalogEnabled) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-24 text-center">
        <h1 className="font-heading text-2xl">Catálogo não configurado</h1>
        <p className="mt-3 text-ink/60">
          Defina as variáveis da Storefront API para carregar as peças.
        </p>
      </div>
    );
  }

  let products: Awaited<ReturnType<typeof listCatalog>>['products'] = [];
  let categories: Awaited<ReturnType<typeof listCatalog>>['categories'] = [];
  let catalogError = false;
  if (isShopifyConfigured) {
    try {
      const catalog = await listCatalog();
      products = catalog.products;
      categories = catalog.categories;
    } catch {
      catalogError = true;
    }
  } else {
    // Demo local — ver lib/demo-catalog.ts. Nunca acontece em produção
    // porque exige a flag explícita além da API não configurada.
    products = DEMO_PRODUCTS;
    categories = categoriesFromProducts(DEMO_PRODUCTS);
  }

  const activeCategory = categories.find((category) => category.slug === categoria);
  if (categoria && activeCategory) {
    products = products.filter(
      (product) => activeCategory.productIds
        ? activeCategory.productIds.includes(product.id)
        : product.productType.trim().toLocaleLowerCase() === activeCategory.productType?.toLocaleLowerCase(),
    );
  } else if (categoria) {
    products = [];
  }

  return (
    <div className="catalog-editorial catalog-container">
      <header className="catalog-heading mb-8">
        <p className="text-[0.7rem] uppercase tracking-[0.22em] text-ink/65">Aluguel</p>
        <h1 className="mt-2 font-heading text-3xl sm:text-4xl">Peças disponíveis</h1>
        {!isShopifyConfigured && isDemoCatalogEnabled && (
          <p className="mt-3 inline-block rounded-full bg-marsala/10 px-3 py-1 text-[0.7rem] font-medium text-marsala">
            Modo demonstração — peças fictícias, sem loja conectada
          </p>
        )}
      </header>

      {/* Filtro por nicho. Rota própria (não estado de cliente) de propósito:
          um link compartilhável direto pra "botas premium" é útil, e o
          catálogo pré-carrega sem esperar JS no navegador do cliente. */}
      <CategorySelect activeCategory={activeCategory?.slug} categories={categories} />
      <nav
        aria-label="Filtrar por tipo de peça"
        className="catalog-desktop-categories mb-10 flex-wrap gap-2"
      >
        <CategoryPill href="/pecas" active={!activeCategory}>
          Todas
        </CategoryPill>
        {categories.map((cat) => (
          <CategoryPill
            key={cat.slug}
            href={`/pecas?categoria=${cat.slug}`}
            active={activeCategory?.slug === cat.slug}
          >
            {cat.label}
          </CategoryPill>
        ))}
      </nav>

      {catalogError ? (
        <p role="alert" className="py-16 text-center text-ink/60">
          Não foi possível carregar as peças agora. Tente novamente em instantes.
        </p>
      ) : products.length === 0 ? (
        <p className="py-16 text-center text-ink/50">
          {categoria
            ? 'Nenhuma peça cadastrada neste tipo ainda.'
            : 'Nenhuma peça cadastrada ainda.'}
        </p>
      ) : (
        <div className="catalog-grid">
          {products.map((product, index) => (
            <ProductCard key={product.id} product={product} catalog priority={index < 2} />
          ))}
        </div>
      )}
    </div>
  );
}

function CategoryPill({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={[
        'shrink-0 rounded-full border px-4 py-3 text-sm font-medium transition-colors',
        active
          ? 'border-marsala bg-marsala text-cream'
          : 'border-ink/15 text-ink/60 hover:border-marsala/40 hover:text-marsala',
      ].join(' ')}
    >
      {children}
    </Link>
  );
}
