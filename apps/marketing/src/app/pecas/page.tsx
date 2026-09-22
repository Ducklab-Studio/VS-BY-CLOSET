import type { Metadata } from 'next';
import Link from 'next/link';
import {
  RENTAL_CATEGORIES,
  type CategorySlug,
  isShopifyConfigured,
  listProducts,
} from '@/lib/shopify';
import { isValePassProduct } from '@/lib/vale-pass-product';
import { DEMO_PRODUCTS, isDemoCatalogEnabled } from '@/lib/demo-catalog';
import { CategorySelect } from '@/components/CategorySelect';
import { CatalogGrid } from '@/components/CatalogGrid';

export const metadata: Metadata = {
  title: 'Peças',
  description: 'Jaquetas, sobretudos, tricôs e botas para alugar. Retire ao chegar no Chile.',
};

export const revalidate = 60;

/**
 * Catálogo, com filtro por nicho (jaquetas de couro, sobretudo de lã...).
 * Substitui o link que ia para /collections/all no tema Shopify.
 *
 * Cada peça é uma unidade física com código próprio — o cliente decidiu
 * assim para conseguir rastrear qual roupa vive voltando com problema.
 * Isso significa que peças iguais aparecem como itens separados aqui.
 * Quando houver repetição de verdade no catálogo, vale agrupar por modelo
 * e deixar o sistema escolher a unidade livre; hoje seria complexidade
 * para um caso que ainda não existe.
 */
export default async function PecasPage({
  searchParams,
}: {
  searchParams: Promise<{ categoria?: string }>;
}) {
  const { categoria } = await searchParams;
  const activeCategory = RENTAL_CATEGORIES.find((c) => c.slug === categoria)?.slug as
    | CategorySlug
    | undefined;

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

  let products: Awaited<ReturnType<typeof listProducts>> = [];
  if (isShopifyConfigured) {
    try {
      products = await listProducts({ first: 100, category: activeCategory });
    } catch {
      // Loja fora do ar não pode virar tela de erro: mostra o estado vazio
      // com o contato, que é o que resolve pro cliente final.
      products = [];
    }
  } else {
    // Demo local — ver lib/demo-catalog.ts. Nunca acontece em produção
    // porque exige a flag explícita além da API não configurada.
    products = activeCategory
      ? DEMO_PRODUCTS.filter(
          (p) => p.productType === RENTAL_CATEGORIES.find((c) => c.slug === activeCategory)?.productType,
        )
      : DEMO_PRODUCTS;
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
      <CategorySelect activeCategory={activeCategory} categories={RENTAL_CATEGORIES} />
      <nav
        aria-label="Filtrar por tipo de peça"
        className="catalog-desktop-categories mb-10 flex-wrap gap-2"
      >
        <CategoryPill href="/pecas" active={!activeCategory}>
          Todas
        </CategoryPill>
        {RENTAL_CATEGORIES.map((cat) => (
          <CategoryPill
            key={cat.slug}
            href={`/pecas?categoria=${cat.slug}`}
            active={activeCategory === cat.slug}
          >
            {cat.label}
          </CategoryPill>
        ))}
      </nav>

      {products.length === 0 ? (
        <p className="py-16 text-center text-ink/50">
          {activeCategory
            ? 'Nenhuma peça cadastrada neste tipo ainda.'
            : 'Nenhuma peça cadastrada ainda.'}
        </p>
      ) : (
        <CatalogGrid
          products={products.map((product) => ({
            ...product,
            // Valle Pass (e qualquer produto fora do fluxo de aluguel) nunca
            // entra na checagem de disponibilidade — não depende de peça
            // física nenhuma; ver isValePassProduct.
            checkVariantId: isValePassProduct({ productId: product.id }) ? null : (product.variantId ?? null),
          }))}
        />
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
