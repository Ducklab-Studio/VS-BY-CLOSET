import { describe, expect, test } from 'vitest';
import { civilDateFromISO } from './civil-date';
import {
  MAX_ALLOCATION_ITEMS,
  TooManyItemsToAllocateError,
  allocateUnitsPerItem,
  type AllocationItem,
  type AllocationUnit,
  type UnitOccupation,
} from './item-allocation';
import { blockedRangeFor, planItemSchedule, type ScheduleRules } from './item-schedule';
import type { BlockedRange } from './rental-engine';

const range = (from: string, untilExclusive: string): BlockedRange => ({ blockedFrom: civilDateFromISO(from), blockedUntilExclusive: civilDateFromISO(untilExclusive) });
const item = (id: string, variantId: string, from: string, untilExclusive: string): AllocationItem => ({ id, variantId, range: range(from, untilExclusive) });
const unit = (id: string, variantId: string): AllocationUnit => ({ id, variantId });
const busy = (unitId: string, from: string, untilExclusive: string): UnitOccupation => ({ unitId, range: range(from, untilExclusive) });

const assignments = (items: AllocationItem[], units: AllocationUnit[], occupations: UnitOccupation[] = []) => {
  const result = allocateUnitsPerItem(items, units, occupations);
  if (!result.ok) throw new Error(`esperava ok: ${JSON.stringify(result.failures)}`);
  return Object.fromEntries(result.assignments);
};
const failures = (items: AllocationItem[], units: AllocationUnit[], occupations: UnitOccupation[] = []) => {
  const result = allocateUnitsPerItem(items, units, occupations);
  if (result.ok) throw new Error('esperava falha');
  return result.failures.map((f) => `${f.itemId}:${f.reason}`).sort();
};

describe('uma peça por variante: cada uma com a sua janela', () => {
  test('variantes diferentes não disputam nada, mesmo com janelas iguais', () => {
    expect(assignments([item('a', 'V1', '2026-11-01', '2026-11-05'), item('b', 'V2', '2026-11-01', '2026-11-05')], [unit('u1', 'V1'), unit('u2', 'V2')])).toEqual({ a: 'u1', b: 'u2' });
  });

  test('ocupação de OUTRA reserva só impede a peça cuja janela colide', () => {
    const units = [unit('u1', 'V1'), unit('u2', 'V2')];
    const occupations = [busy('u1', '2026-11-10', '2026-11-14')];
    // a: janela livre; b (mesma unidade u1? não, V2) irrelevante; c colide com a ocupação
    expect(assignments([item('a', 'V1', '2026-11-01', '2026-11-05')], units, occupations)).toEqual({ a: 'u1' });
    expect(failures([item('c', 'V1', '2026-11-12', '2026-11-16')], units, occupations)).toEqual(['c:no_free_unit']);
  });

  test('janela encostando (meio-aberto) NÃO conflita: devolução+limpeza termina no dia em que a outra começa', () => {
    expect(assignments([item('a', 'V1', '2026-11-05', '2026-11-09')], [unit('u1', 'V1')], [busy('u1', '2026-11-01', '2026-11-05')])).toEqual({ a: 'u1' });
    expect(failures([item('a', 'V1', '2026-11-04', '2026-11-09')], [unit('u1', 'V1')], [busy('u1', '2026-11-01', '2026-11-05')])).toEqual(['a:no_free_unit']);
  });

  test('variante sem unidade ativa não tem como alocar', () => {
    expect(failures([item('a', 'V9', '2026-11-01', '2026-11-05')], [unit('u1', 'V1')])).toEqual(['a:no_free_unit']);
  });
});

describe('duas peças da MESMA variante com datas diferentes', () => {
  test('janelas que não se sobrepõem podem dividir UMA unidade', () => {
    expect(assignments([item('a', 'V1', '2026-11-01', '2026-11-06'), item('b', 'V1', '2026-11-06', '2026-11-12')], [unit('u1', 'V1')])).toEqual({ a: 'u1', b: 'u1' });
  });

  test('janelas sobrepostas exigem duas unidades distintas', () => {
    expect(assignments([item('a', 'V1', '2026-11-01', '2026-11-08'), item('b', 'V1', '2026-11-05', '2026-11-12')], [unit('u1', 'V1'), unit('u2', 'V1')])).toEqual({ a: 'u1', b: 'u2' });
  });

  test('sobrepostas com uma só unidade: conflito ENTRE as peças da própria reserva', () => {
    expect(failures([item('a', 'V1', '2026-11-01', '2026-11-08'), item('b', 'V1', '2026-11-05', '2026-11-12')], [unit('u1', 'V1')])).toEqual(['a:items_conflict_with_each_other', 'b:items_conflict_with_each_other']);
  });

  test('a limpeza/preparação embutidas na janela criam o conflito mesmo com datas de aluguel diferentes', () => {
    const rules: ScheduleRules = { prepDays: 3, cleaningDays: 2, minAdvanceHours: 0, timezone: 'America/Santiago', isOpenOn: () => true };
    const now = new Date('2026-10-01T12:00:00Z');
    const first = planItemSchedule({ pickupDate: civilDateFromISO('2026-11-10'), days: 2, pickupTime: { hour: 10, minute: 0 } }, rules, now);
    const second = planItemSchedule({ pickupDate: civilDateFromISO('2026-11-14'), days: 2, pickupTime: { hour: 10, minute: 0 } }, rules, now);
    if (!first.ok || !second.ok) throw new Error('cronograma inválido');
    // 1ª devolve dia 12 e fica bloqueada até 15 (limpeza); a 2ª começa a ser preparada em 11 → colidem
    const items: AllocationItem[] = [
      { id: 'a', variantId: 'V1', range: first.schedule.blockedRange },
      { id: 'b', variantId: 'V1', range: second.schedule.blockedRange },
    ];
    expect(failures(items, [unit('u1', 'V1')])).toContain('a:items_conflict_with_each_other');
    expect(assignments(items, [unit('u1', 'V1'), unit('u2', 'V1')])).toEqual({ a: 'u1', b: 'u2' });
  });

  test('prefere sempre a unidade de menor id livre (mesma preferência de hoje)', () => {
    expect(assignments([item('a', 'V1', '2026-11-01', '2026-11-03')], [unit('u3', 'V1'), unit('u1', 'V1'), unit('u2', 'V1')])).toEqual({ a: 'u1' });
    expect(assignments([item('a', 'V1', '2026-11-01', '2026-11-03')], [unit('u1', 'V1'), unit('u2', 'V1')], [busy('u1', '2026-10-30', '2026-11-02')])).toEqual({ a: 'u2' });
  });

  test('a busca é EXATA: um first-fit guloso deixaria a última peça sem unidade, mas há solução', () => {
    // u1 está ocupada de 10 a 14 por outra reserva. a [1,6) pode ir em u1 ou u2; b [8,12) só cabe em u2 (u1 ocupada);
    // c [4,9) conflita com a em u1 e com b em u2 se a tomar u2. Solução: a→u1, c→u2? c [4,9) × b [8,12) em u2 conflita.
    // Solução real: a→u2? a [1,6) × c [4,9) em u2 conflita. Então: a→u1, b→u2, c→? —
    // montamos um caso garantidamente solúvel: 3 unidades em que o guloso erra por ordem de id.
    const units = [unit('u1', 'V1'), unit('u2', 'V1')];
    const occupations = [busy('u1', '2026-11-08', '2026-11-12')];
    const items = [item('a', 'V1', '2026-11-01', '2026-11-05'), item('b', 'V1', '2026-11-09', '2026-11-13'), item('c', 'V1', '2026-11-02', '2026-11-04')];
    // a e c se sobrepõem (precisam de unidades diferentes); b só cabe em u2 (u1 ocupada 8–12) → c e a: u1 e u2 — b em u2 exige a e c fora de u2 no período 9–13 (não conflitam). Válido:
    const result = assignments(items, units, occupations);
    expect(result.b).toBe('u2');
    expect(new Set([result.a, result.c]).size).toBe(2);
  });

  test('backtracking: a primeira escolha de menor id inviabiliza a seguinte e a busca volta atrás', () => {
    // a [1,5) e b [5,9) cabem juntas em u1. c [3,7) sobrepõe as duas: precisa de outra unidade. d [1,9) precisa de unidade inteira.
    const units = [unit('u1', 'V1'), unit('u2', 'V1'), unit('u3', 'V1')];
    const items = [item('a', 'V1', '2026-11-01', '2026-11-05'), item('b', 'V1', '2026-11-05', '2026-11-09'), item('c', 'V1', '2026-11-03', '2026-11-07'), item('d', 'V1', '2026-11-01', '2026-11-09')];
    const result = assignments(items, units);
    const byUnit = new Map<string, string[]>();
    for (const [itemId, unitId] of Object.entries(result)) byUnit.set(unitId, [...(byUnit.get(unitId) ?? []), itemId]);
    expect(byUnit.size).toBeLessThanOrEqual(3);
    // nenhuma unidade recebeu peças de janelas sobrepostas
    for (const ids of byUnit.values()) {
      const ranges = ids.map((id) => items.find((i) => i.id === id)!.range);
      for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++) {
        const x = ranges[i];
        const y = ranges[j];
        expect(civilKey(x.blockedFrom) < civilKey(y.blockedUntilExclusive) && civilKey(y.blockedFrom) < civilKey(x.blockedUntilExclusive)).toBe(false);
      }
    }
  });

  test('resultado determinístico, independente da ordem em que as peças chegam', () => {
    const items = [item('a', 'V1', '2026-11-01', '2026-11-05'), item('b', 'V1', '2026-11-03', '2026-11-08'), item('c', 'V1', '2026-11-09', '2026-11-12')];
    const units = [unit('u1', 'V1'), unit('u2', 'V1')];
    const forward = assignments(items, units);
    expect(assignments([...items].reverse(), units)).toEqual(forward);
    expect(assignments([items[1], items[2], items[0]], [...units].reverse())).toEqual(forward);
  });
});

describe('reservas com muitas peças (até 6) e proteção', () => {
  test('6 peças, 3 variantes, datas todas diferentes, com ocupações de terceiros', () => {
    const units = ['V1', 'V1', 'V2', 'V2', 'V3'].map((variant, i) => unit(`u${i + 1}`, variant));
    const items = [
      item('p1', 'V1', '2026-12-01', '2026-12-05'),
      item('p2', 'V1', '2026-12-03', '2026-12-09'),
      item('p3', 'V2', '2026-12-01', '2026-12-04'),
      item('p4', 'V2', '2026-12-10', '2026-12-14'),
      item('p5', 'V3', '2026-12-20', '2026-12-24'),
      item('p6', 'V1', '2026-12-10', '2026-12-13'),
    ];
    const result = assignments(items, units, [busy('u3', '2026-12-09', '2026-12-12')]);
    expect(result.p1).toBe('u1');
    expect(result.p2).toBe('u2'); // sobrepõe p1
    expect(result.p3).toBe('u3');
    expect(result.p4).toBe('u4'); // u3 ocupada de 9 a 12
    expect(result.p5).toBe('u5');
    expect(result.p6).toBe('u1'); // volta para u1: a janela de p1 já terminou
  });

  test('uma peça sem unidade derruba o pedido inteiro, apontando qual (tudo ou nada)', () => {
    const items = [item('ok', 'V1', '2026-12-01', '2026-12-03'), item('sem', 'V2', '2026-12-01', '2026-12-03')];
    expect(failures(items, [unit('u1', 'V1')])).toEqual(['sem:no_free_unit']);
  });

  test('entrada absurda é recusada em vez de explodir a busca', () => {
    const items = Array.from({ length: MAX_ALLOCATION_ITEMS + 1 }, (_, i) => item(`p${i}`, 'V1', '2026-12-01', '2026-12-03'));
    expect(() => allocateUnitsPerItem(items, [unit('u1', 'V1')], [])).toThrow(TooManyItemsToAllocateError);
    expect(() => allocateUnitsPerItem([item('a', 'V1', '2026-12-01', '2026-12-03'), item('a', 'V1', '2026-12-05', '2026-12-07')], [unit('u1', 'V1')], [])).toThrow(/duplicados/);
  });

  test('janela de uma peça criada pelo cronograma bate com a ocupação já gravada no banco (mesmo intervalo meio-aberto)', () => {
    const stored = blockedRangeFor(civilDateFromISO('2026-12-10'), civilDateFromISO('2026-12-12'), { prepDays: 3, cleaningDays: 2 });
    const newcomer = blockedRangeFor(civilDateFromISO('2026-12-17'), civilDateFromISO('2026-12-18'), { prepDays: 3, cleaningDays: 2 });
    // gravada: [7, 15); nova: [14, 21) → colidem em 14
    expect(failures([{ id: 'n', variantId: 'V1', range: newcomer }], [unit('u1', 'V1')], [{ unitId: 'u1', range: stored }])).toEqual(['n:no_free_unit']);
  });
});

const civilKey = (d: { year: number; month: number; day: number }) => d.year * 10_000 + d.month * 100 + d.day;
