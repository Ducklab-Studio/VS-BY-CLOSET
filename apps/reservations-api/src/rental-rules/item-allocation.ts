/**
 * Alocação PURA de unidades físicas para peças com datas DIFERENTES na mesma reserva (Fase 3).
 *
 * Hoje todas as peças de uma reserva compartilham a mesma janela (`allocateFreeUnits` recebe UM conjunto de unidades
 * ocupadas). Com retirada e duração por peça, cada peça tem a sua janela, e duas peças da MESMA variante só podem
 * dividir uma unidade se as janelas delas (já com preparação e limpeza embutidas) não se sobrepõem.
 *
 * Sem banco, sem HTTP, sem relógio. NÃO substitui `allocateFreeUnits` e não está ligado ao HOLD; é o núcleo testável
 * que o HOLD por peça vai usar quando o modelo de dados for aprovado. No banco, a verdade final continua sendo a
 * restrição EXCLUDE `reservation_items_no_overlap_per_unit` — isto aqui só decide ANTES de gravar.
 *
 * Determinismo: peças ordenadas por (início da janela, id); unidades tentadas em ordem crescente de id — a mesma
 * preferência de hoje ("sempre a unidade de menor id livre primeiro"). A busca é exata (backtracking), não gulosa:
 * existem casos em que o "primeiro livre" gulosamente deixa a próxima peça sem unidade, apesar de haver solução.
 */

import { type BlockedRange, blockedRangesOverlap } from './rental-engine';

export interface AllocationItem {
  readonly id: string;
  readonly variantId: string;
  /** Janela da PRÓPRIA peça (preparação + aluguel + limpeza). */
  readonly range: BlockedRange;
}

export interface AllocationUnit {
  readonly id: string;
  readonly variantId: string;
}

/** Ocupação que já existe (outra reserva, bloqueio operacional da unidade). */
export interface UnitOccupation {
  readonly unitId: string;
  readonly range: BlockedRange;
}

export type ItemAllocationFailureReason =
  /** Nenhuma unidade da variante existe/está livre na janela desta peça (independe das outras peças). */
  | 'no_free_unit'
  /** Cada peça teria unidade sozinha, mas as peças da mesma variante disputam as mesmas unidades entre si. */
  | 'items_conflict_with_each_other';

export type ItemAllocationResult =
  | { readonly ok: true; readonly assignments: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly failures: readonly { readonly itemId: string; readonly reason: ItemAllocationFailureReason }[] };

/** Teto de segurança da busca exata. A regra comercial é até 6 peças; isto só protege contra entrada absurda. */
export const MAX_ALLOCATION_ITEMS = 20;

export class TooManyItemsToAllocateError extends Error {
  constructor(count: number) {
    super(`${count} peças excede o limite de ${MAX_ALLOCATION_ITEMS} da alocação.`);
    this.name = 'TooManyItemsToAllocateError';
  }
}

const startOf = (item: AllocationItem) => item.range.blockedFrom;
const compareDates = (a: AllocationItem, b: AllocationItem): number => {
  const x = startOf(a);
  const y = startOf(b);
  return x.year - y.year || x.month - y.month || x.day - y.day || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
};

export function allocateUnitsPerItem(
  items: readonly AllocationItem[],
  units: readonly AllocationUnit[],
  occupations: readonly UnitOccupation[],
): ItemAllocationResult {
  if (items.length > MAX_ALLOCATION_ITEMS) throw new TooManyItemsToAllocateError(items.length);
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('Ids de peça duplicados.');

  const sortedUnits = [...units].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const busyByUnit = new Map<string, BlockedRange[]>();
  for (const occupation of occupations) {
    const list = busyByUnit.get(occupation.unitId) ?? [];
    list.push(occupation.range);
    busyByUnit.set(occupation.unitId, list);
  }

  const ordered = [...items].sort(compareDates);
  // Candidatas de cada peça: unidades da variante livres na janela dela (ignorando as outras peças da reserva).
  const candidates = new Map<string, string[]>();
  const failures: { itemId: string; reason: ItemAllocationFailureReason }[] = [];
  for (const item of ordered) {
    const free = sortedUnits
      .filter((unit) => unit.variantId === item.variantId)
      .filter((unit) => !(busyByUnit.get(unit.id) ?? []).some((range) => blockedRangesOverlap(range, item.range)))
      .map((unit) => unit.id);
    candidates.set(item.id, free);
    if (free.length === 0) failures.push({ itemId: item.id, reason: 'no_free_unit' });
  }
  if (failures.length > 0) return { ok: false, failures };

  // Busca exata: atribui peça a peça; uma unidade só recebe outra peça se a janela dela não colide com as já atribuídas.
  const assigned = new Map<string, string>();
  const taken = new Map<string, BlockedRange[]>();
  const place = (index: number): boolean => {
    if (index === ordered.length) return true;
    const item = ordered[index];
    for (const unitId of candidates.get(item.id) ?? []) {
      const already = taken.get(unitId) ?? [];
      if (already.some((range) => blockedRangesOverlap(range, item.range))) continue;
      assigned.set(item.id, unitId);
      taken.set(unitId, [...already, item.range]);
      if (place(index + 1)) return true;
      assigned.delete(item.id);
      taken.set(unitId, already);
    }
    return false;
  };

  if (place(0)) {
    // Devolve na ordem original das peças (determinística e fácil de ler).
    return { ok: true, assignments: new Map(items.map((item) => [item.id, assigned.get(item.id) as string])) };
  }
  // Sem solução conjunta: aponta as peças que disputam (todas as que compartilham variante com outra sem folga).
  const byVariant = new Map<string, string[]>();
  for (const item of ordered) byVariant.set(item.variantId, [...(byVariant.get(item.variantId) ?? []), item.id]);
  const conflicting = [...byVariant.values()].filter((ids) => ids.length > 1).flat();
  return {
    ok: false,
    failures: (conflicting.length > 0 ? conflicting : ordered.map((item) => item.id)).map((itemId) => ({ itemId, reason: 'items_conflict_with_each_other' as const })),
  };
}
