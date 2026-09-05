'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';

export function CategorySelect({ activeCategory, categories }: {
  activeCategory?: string;
  categories: readonly { slug: string; label: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div className="catalog-mobile-filter" aria-busy={pending}>
      <label htmlFor="catalog-category">Categoria</label>
      <div className="catalog-select-wrap">
        <SlidersHorizontal size={17} strokeWidth={1.5} aria-hidden="true" />
        <select
          id="catalog-category"
          value={activeCategory ?? ''}
          disabled={pending}
          onChange={(event) => {
            const category = event.target.value;
            startTransition(() => router.push(category ? `/pecas?categoria=${encodeURIComponent(category)}` : '/pecas', { scroll: false }));
          }}
        >
          <option value="">Todas as peças</option>
          {categories.map(category => <option key={category.slug} value={category.slug}>{category.label}</option>)}
        </select>
        <ChevronDown size={17} strokeWidth={1.5} aria-hidden="true" />
      </div>
      <span className="catalog-filter-status" role="status">{pending ? 'Atualizando peças…' : ''}</span>
    </div>
  );
}
