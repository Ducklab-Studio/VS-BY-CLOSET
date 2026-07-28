import Link from 'next/link';
import type { Metadata } from 'next';
import { api } from '@/lib/api';
import { ProductCard } from '@/components/product/ProductCard';
import type { Product } from '@/lib/types';

export const metadata: Metadata = {
  title: 'Catálogo de Moon Boots e acessórios',
  description: 'Explore nosso catálogo de Moon Boots, botas de neve e acessórios.',
};

type SearchParams = Record<string, string | undefined>;

const sortOptions = [
  { value: 'recent', label: 'Mais recentes' },
  { value: 'best_selling', label: 'Mais vendidos' },
  { value: 'price_asc', label: 'Menor preço' },
  { value: 'price_desc', label: 'Maior preço' },
  { value: 'rating', label: 'Melhor avaliados' },
];

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  let items: Product[] = [];
  let total = 0;
  let totalPages = 1;
  const page = Number(params.page ?? 1);

  try {
    const res = await api.products.list({
      search: params.search,
      category: params.category,
      brand: params.brand,
      color: params.color,
      size: params.size,
      minPrice: params.minPrice,
      maxPrice: params.maxPrice,
      onSale: params.onSale,
      sort: params.sort,
      page,
    });
    items = res.items;
    total = res.pagination.total;
    totalPages = res.pagination.totalPages;
  } catch {
    // API offline — mostra estado vazio
  }

  // Mantém os filtros atuais ao trocar de página/ordenação
  const buildQuery = (overrides: SearchParams) => {
    const merged = { ...params, ...overrides };
    const qs = new URLSearchParams();
    Object.entries(merged).forEach(([k, v]) => v && qs.set(k, v));
    return `?${qs.toString()}`;
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-10">
      <nav className="mb-6 text-sm text-white/50" aria-label="Breadcrumb">
        <Link href="/" className="hover:text-white">
          Início
        </Link>{' '}
        / <span className="text-white">Produtos</span>
      </nav>

      <div className="flex flex-col gap-8 md:flex-row">
        {/* ── Filtros (sidebar) ─────────────────────────────────────────── */}
        <aside className="w-full shrink-0 md:w-64" aria-label="Filtros">
          <h2 className="font-heading mb-4 text-lg text-white">Filtros</h2>
          <FilterGroup
            title="Categoria"
            options={[
              { value: 'moon-boots', label: 'Moon Boots' },
              { value: 'botas', label: 'Botas de Neve' },
              { value: 'acessorios', label: 'Acessórios' },
              { value: 'kits', label: 'Kits' },
            ]}
            param="category"
            current={params.category}
            buildQuery={buildQuery}
          />
          <FilterGroup
            title="Tamanho"
            options={['34', '36', '38', '40', '42', '44'].map((s) => ({ value: s, label: s }))}
            param="size"
            current={params.size}
            buildQuery={buildQuery}
          />
          <div className="mb-6">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-widest text-white">Ofertas</h3>
            <Link
              href={buildQuery({ onSale: params.onSale === 'true' ? undefined : 'true' })}
              className={`block text-sm ${
                params.onSale === 'true' ? 'font-semibold text-white' : 'text-white/60'
              }`}
            >
              Somente promoções
            </Link>
          </div>
        </aside>

        {/* ── Lista ─────────────────────────────────────────────────────── */}
        <div className="flex-1">
          <div className="mb-6 flex items-center justify-between">
            <p className="text-sm text-white/50">{total} produto(s)</p>
            <form>
              <select
                name="sort"
                defaultValue={params.sort ?? 'recent'}
                aria-label="Ordenar por"
                className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white"
              >
                {sortOptions.map((o) => (
                  <option key={o.value} value={o.value} className="bg-ink">
                    {o.label}
                  </option>
                ))}
              </select>
            </form>
          </div>

          {items.length > 0 ? (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
              {items.map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-white/15 p-16 text-center text-white/50">
              Nenhum produto encontrado.
            </div>
          )}

          {/* Paginação */}
          {totalPages > 1 && (
            <div className="mt-10 flex justify-center gap-2">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                <Link
                  key={n}
                  href={buildQuery({ page: String(n) })}
                  className={`flex h-10 w-10 items-center justify-center rounded-lg text-sm ${
                    n === page
                      ? 'bg-white text-ink'
                      : 'border border-white/15 text-white/70 hover:border-white/40'
                  }`}
                >
                  {n}
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FilterGroup({
  title,
  options,
  param,
  current,
  buildQuery,
}: {
  title: string;
  options: { value: string; label: string }[];
  param: string;
  current?: string;
  buildQuery: (o: SearchParams) => string;
}) {
  return (
    <div className="mb-6">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-widest text-white">{title}</h3>
      <ul className="space-y-1.5">
        {options.map((o) => (
          <li key={o.value}>
            <Link
              href={buildQuery({ [param]: current === o.value ? undefined : o.value, page: undefined })}
              className={`text-sm ${
                current === o.value ? 'font-semibold text-white' : 'text-white/60 hover:text-white'
              }`}
            >
              {o.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
