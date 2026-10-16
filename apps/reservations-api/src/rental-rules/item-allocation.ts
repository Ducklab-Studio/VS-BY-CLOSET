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
 * Contrato do chamador:
 *  - `occupations` deve conter SÓ ocupações que de fato bloqueiam a unidade (status que ocupam), de outras reservas;
 *  - uma linha com quantidade N vira N itens (um por peça física), cada um com id próprio;
 *  - são no máximo `MAX_ALLOCATION_ITEMS` (6) peças físicas por chamada.
 *
 * FAIL CLOSED: qualquer entrada inválida (peças demais, ids duplicados, janela vazia/invertida, data inexistente)
 * devolve `{ ok: false, failures }` ANTES da busca combinatória — nunca lança e nunca ignora um item ou uma ocupação
 * defeituosa (ignorar uma ocupação inválida liberaria uma unidade que pode estar ocupada).
 *
 * Determinismo: peças ordenadas por (nº de unidades candidatas, início da janela, id); unidades tentadas em ordem
 * crescente de id — a mesma preferência de hoje ("sempre a unidade de menor id livre primeiro"). A busca é exata
 * (backtracking), não gulosa, e tem um orçamento fixo de nós: estourá-lo é uma falha explícita, não um travamento.
 */

import { isValidBlockedRange } from './engine-guards';
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
  | 'items_conflict_with_each_other'
  /** Mais peças físicas do que `MAX_ALLOCATION_ITEMS`. */
  | 'too_many_items'
  | 'no_items'
  | 'invalid_item'
  | 'duplicate_item_id'
  /** Janela da peça vazia, invertida ou com data inexistente. */
  | 'invalid_range'
  | 'invalid_unit'
  | 'duplicate_unit_id'
  | 'invalid_occupation'
  /** Orçamento de busca esgotado (fail closed). */
  | 'search_limit_exceeded';

export interface ItemAllocationFailure {
  /** Ausente nas falhas que não são de uma peça específica (ex.: `too_many_items`, `invalid_unit`). */
  readonly itemId?: string;
  readonly reason: ItemAllocationFailureReason;
}

export type ItemAllocationResult =
  | { readonly ok: true; readonly assignments: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly failures: readonly ItemAllocationFailure[] };

/** Limite operacional conhecido de peças por reserva. A checagem acontece ANTES de qualquer busca combinatória. */
export const MAX_ALLOCATION_ITEMS = 6;

/** Orçamento de nós da busca exata. Com 6 peças nunca é alcançado em casos reais; é só um freio determinístico. */
export const MAX_SEARCH_NODES = 100_000;

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== '';
const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const dateKey = (d: { year: number; month: number; day: number }) => d.year * 10_000 + d.month * 100 + d.day;

function validateInput(items: unknown, units: unknown, occupations: unknown): ItemAllocationFailure[] {
  if (!Array.isArray(items) || !Array.isArray(units) || !Array.isArray(occupations)) return [{ reason: 'invalid_item' }];
  if (items.length === 0) return [{ reason: 'no_items' }];
  // ANTES de olhar o conteúdo: a busca combinatória nunca recebe mais peças do que o limite.
  if (items.length > MAX_ALLOCATION_ITEMS) return [{ reason: 'too_many_items' }];

  const failures: ItemAllocationFailure[] = [];
  const itemIds = new Set<string>();
  for (const item of items) {
    const id = (item as Partial<AllocationItem> | null)?.id;
    if (item === null || typeof item !== 'object' || !isNonEmptyString(id) || !isNonEmptyString(item.variantId)) {
      failures.push({ ...(isNonEmptyString(id) ? { itemId: id } : {}), reason: 'invalid_item' });
      continue;
    }
    if (itemIds.has(id)) failures.push({ itemId: id, reason: 'duplicate_item_id' });
    itemIds.add(id);
    if (!isValidBlockedRange(item.range)) failures.push({ itemId: id, reason: 'invalid_range' });
  }

  const unitIds = new Set<string>();
  for (const unit of units) {
    if (unit === null || typeof unit !== 'object' || !isNonEmptyString(unit.id) || !isNonEmptyString(unit.variantId)) {
      failures.push({ reason: 'invalid_unit' });
      continue;
    }
    if (unitIds.has(unit.id)) failures.push({ reason: 'duplicate_unit_id' });
    unitIds.add(unit.id);
  }

  for (const occupation of occupations) {
    if (occupation === null || typeof occupation !== 'object' || !isNonEmptyString(occupation.unitId) || !isValidBlockedRange(occupation.range)) {
      failures.push({ reason: 'invalid_occupation' });
    }
  }
  return failures;
}

export function allocateUnitsPerItem(
  items: readonly AllocationItem[],
  units: readonly AllocationUnit[],
  occupations: readonly UnitOccupation[],
): ItemAllocationResult {
  const invalid = validateInput(items, units, occupations);
  if (invalid.length > 0) return { ok: false, failures: invalid };

  const sortedUnits = [...units].sort((a, b) => compareStrings(a.id, b.id));
  const busyByUnit = new Map<string, BlockedRange[]>();
  for (const occupation of occupations) {
    const list = busyByUnit.get(occupation.unitId) ?? [];
    list.push(occupation.range);
    busyByUnit.set(occupation.unitId, list);
  }

  // Candidatas de cada peça: unidades da variante livres na janela dela (ignorando as outras peças da reserva).
  const candidates = new Map<string, string[]>();
  const failures: ItemAllocationFailure[] = [];
  for (const item of items) {
    const free = sortedUnits
      .filter((unit) => unit.variantId === item.variantId)
      .filter((unit) => !(busyByUnit.get(unit.id) ?? []).some((range) => blockedRangesOverlap(range, item.range)))
      .map((unit) => unit.id);
    candidates.set(item.id, free);
    if (free.length === 0) failures.push({ itemId: item.id, reason: 'no_free_unit' });
  }
  if (failures.length > 0) return { ok: false, failures };

  // Ordem da busca: as peças mais restritas primeiro (poda cedo), depois início da janela e id — tudo determinístico.
  const ordered = [...items].sort(
    (a, b) =>
      (candidates.get(a.id) as string[]).length - (candidates.get(b.id) as string[]).length ||
      dateKey(a.range.blockedFrom) - dateKey(b.range.blockedFrom) ||
      compareStrings(a.id, b.id),
  );

  // Busca exata: atribui peça a peça; uma unidade só recebe outra peça se a janela dela não colide com as já atribuídas.
  const assigned = new Map<string, string>();
  const taken = new Map<string, BlockedRange[]>();
  let nodes = 0;
  let exhausted = false;
  const place = (index: number): boolean => {
    if (index === ordered.length) return true;
    const item = ordered[index];
    for (const unitId of candidates.get(item.id) ?? []) {
      if (++nodes > MAX_SEARCH_NODES) {
        exhausted = true;
        return false;
      }
      const already = taken.get(unitId) ?? [];
      if (already.some((range) => blockedRangesOverlap(range, item.range))) continue;
      assigned.set(item.id, unitId);
      taken.set(unitId, [...already, item.range]);
      if (place(index + 1)) return true;
      assigned.delete(item.id);
      taken.set(unitId, already);
      if (exhausted) return false;
    }
    return false;
  };

  if (place(0)) {
    // Devolve na ordem original das peças (determinística e fácil de ler).
    return { ok: true, assignments: new Map(items.map((item) => [item.id, assigned.get(item.id) as string])) };
  }
  if (exhausted) return { ok: false, failures: [{ reason: 'search_limit_exceeded' }] };
  // Sem solução conjunta: aponta as peças que disputam (todas as que compartilham variante com outra sem folga).
  const byVariant = new Map<string, string[]>();
  for (const item of items) byVariant.set(item.variantId, [...(byVariant.get(item.variantId) ?? []), item.id]);
  const conflicting = [...byVariant.values()].filter((ids) => ids.length > 1).flat();
  return {
    ok: false,
    failures: (conflicting.length > 0 ? conflicting : items.map((item) => item.id)).map((itemId) => ({ itemId, reason: 'items_conflict_with_each_other' as const })),
  };
}
