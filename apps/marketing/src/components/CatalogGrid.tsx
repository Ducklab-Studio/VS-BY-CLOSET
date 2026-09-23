'use client';

import { useEffect, useState } from 'react';
import { ProductCard } from './ProductCard';
import type { StorefrontProduct } from '@/lib/shopify';
import { fetchReservableVariantIds } from '@/lib/reservable-variants';

/**
 * Grade do catálogo — item novo (correção do bug "peça desativada continua
 * aparecendo como reservável"): uma única consulta em lote, no navegador,
 * decide quais variantes têm alguma peça física ativa e reservável AGORA.
 * Produtos sem `checkVariantId` (Valle Pass e qualquer produto fora do
 * fluxo de aluguel) nunca entram nessa checagem — continuam exatamente
 * como sempre foram, sem depender de peça física nenhuma.
 *
 * Falha ao consultar (rede fora do ar) não esconde nada: sem confirmação
 * de indisponibilidade, o card continua aparecendo normal — quem
 * efetivamente barra reserva é o calendário/HOLD no servidor, sempre.
 */
export function CatalogGrid({ products }: { products: readonly (StorefrontProduct & { checkVariantId: string | null })[] }) {
  const [unavailable, setUnavailable] = useState<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const variantIds = products.map((p) => p.checkVariantId).filter((id): id is string => !!id);

    if (variantIds.length === 0) {
      setUnavailable(new Set());
      return;
    }

    fetchReservableVariantIds(variantIds).then((reservable) => {
      if (cancelled) return;
      if (!reservable) {
        setUnavailable(new Set()); // falha de rede: nenhum card marcado indisponível
        return;
      }
      setUnavailable(new Set(variantIds.filter((id) => !reservable.has(id))));
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só reconsulta se o CONJUNTO de produtos mudar (paginação/filtro), não a cada render
  }, [products.map((p) => p.id).join(',')]);

  return (
    <div className="catalog-grid">
      {products.map((product, index) => (
        <ProductCard
          key={product.id}
          product={product}
          catalog
          priority={index < 2}
          unavailable={!!product.checkVariantId && !!unavailable?.has(product.checkVariantId)}
        />
      ))}
    </div>
  );
}
