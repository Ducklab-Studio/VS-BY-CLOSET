'use client';

import { useEffect, useRef } from 'react';
import { isBooqableConfigured, refreshBooqable } from '@/lib/booqable';

/**
 * Componentes disponíveis, conforme a documentação do Booqable.
 * Cada um corresponde a uma classe CSS que o script deles procura no DOM.
 */
export type BooqableComponent =
  | 'product-list'
  | 'product-search'
  | 'datepicker'
  | 'collections'
  | 'sidebar'
  | 'sort'
  | 'bar';

interface BooqableEmbedProps {
  component: BooqableComponent;
  /** Filtra por tags: `data-tags`. */
  tags?: string[];
  /** Filtra por coleções: `data-collections`. */
  collections?: string[];
  /** Produtos por página: `data-per`. */
  perPage?: number;
  /** Total de produtos carregados: `data-limit`. */
  limit?: number;
  /** Exibe campo de busca junto da lista: `data-show-search`. */
  showSearch?: boolean;
  className?: string;
}

/**
 * Renderiza um componente do Booqable.
 *
 * O script deles hidrata pela classe CSS, então este componente só monta a div
 * correta com os data-attributes e pede um reinit quando entra na tela.
 */
export function BooqableEmbed({
  component,
  tags,
  collections,
  perPage,
  limit,
  showSearch,
  className,
}: BooqableEmbedProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Se o script já carregou antes deste componente montar (navegação
    // client-side), ele não vai varrer o DOM sozinho.
    const id = requestAnimationFrame(() => refreshBooqable());
    return () => cancelAnimationFrame(id);
  }, []);

  if (!isBooqableConfigured) {
    return <BooqablePlaceholder component={component} />;
  }

  return (
    <div
      ref={ref}
      className={`booqable-${component} ${className ?? ''}`.trim()}
      {...(tags?.length && { 'data-tags': tags.join(',') })}
      {...(collections?.length && { 'data-collections': collections.join(',') })}
      {...(perPage && { 'data-per': String(perPage) })}
      {...(limit && { 'data-limit': String(limit) })}
      {...(showSearch && { 'data-show-search': 'true' })}
    />
  );
}

/**
 * Sem a conta configurada, mostra o que apareceria ali em vez de um espaço
 * vazio — evita a impressão de página quebrada durante o desenvolvimento.
 */
function BooqablePlaceholder({ component }: { component: BooqableComponent }) {
  const labels: Record<BooqableComponent, string> = {
    'product-list': 'Lista de produtos',
    'product-search': 'Campo de busca',
    datepicker: 'Seletor de datas de retirada e devolução',
    collections: 'Lista de categorias',
    sidebar: 'Barra lateral com carrinho',
    sort: 'Ordenação',
    bar: 'Barra de filtros',
  };

  return (
    <div className="rounded-2xl border border-dashed border-white/20 bg-white/[0.02] p-8 text-center">
      <p className="font-heading text-sm tracking-widest text-white/70">{labels[component]}</p>
      <p className="mt-2 text-xs text-white/40">
        Componente do Booqable — defina{' '}
        <code className="rounded bg-white/10 px-1.5 py-0.5 text-white/60">
          NEXT_PUBLIC_BOOQABLE_COMPANY
        </code>{' '}
        no .env para ativar.
      </p>
    </div>
  );
}
