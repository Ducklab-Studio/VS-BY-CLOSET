/**
 * Pura, sem banco — separada de HoldsService só pra poder testar a
 * lógica de "quais unidades pegar" isoladamente, sem precisar de uma
 * transação real. `candidates` já vem ORDER BY id do SQL (ver
 * HoldsService) — a ordem aqui é só respeitada, não reordenada, pra
 * alocação ser determinística (sempre a unidade de menor id livre
 * primeiro).
 */
export interface UnitCandidate {
  readonly id: string;
  readonly shopifyVariantId: string;
}

export type AllocationResult =
  | { readonly ok: true; readonly allocation: ReadonlyMap<string, readonly string[]> }
  | { readonly ok: false; readonly shortfall: readonly string[] };

export function allocateFreeUnits(
  candidates: readonly UnitCandidate[],
  occupiedIds: ReadonlySet<string>,
  needed: ReadonlyMap<string, number>,
): AllocationResult {
  const freeByVariant = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (occupiedIds.has(candidate.id)) continue;
    const list = freeByVariant.get(candidate.shopifyVariantId) ?? [];
    list.push(candidate.id);
    freeByVariant.set(candidate.shopifyVariantId, list);
  }

  const shortfall: string[] = [];
  const allocation = new Map<string, readonly string[]>();
  for (const [variantId, quantity] of needed) {
    const free = freeByVariant.get(variantId) ?? [];
    if (free.length < quantity) {
      shortfall.push(variantId);
      continue;
    }
    allocation.set(variantId, free.slice(0, quantity));
  }

  if (shortfall.length > 0) return { ok: false, shortfall };
  return { ok: true, allocation };
}
