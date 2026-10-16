import { describe, expect, test } from 'vitest';
import { civilDateFromISO } from './civil-date';
import {
  MAX_ALLOCATION_ITEMS,
  MAX_SEARCH_NODES,
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
    // u2 está ocupada de 3 a 5 por outra reserva. `a` [1,3) cabe em u1 ou u2; `d` [2,5) só cabe em u1 (a janela de d
    // bate com a ocupação de u2) e se sobrepõe a `a`. Um first-fit por data põe a→u1 e deixa d sem unidade.
    const units = [unit('u1', 'V1'), unit('u2', 'V1')];
    const occupations = [busy('u2', '2026-11-03', '2026-11-05')];
    const items = [item('a', 'V1', '2026-11-01', '2026-11-03'), item('d', 'V1', '2026-11-02', '2026-11-05')];

    const naiveFirstFit = (): boolean => {
      const placed: { unitId: string; range: BlockedRange }[] = [];
      for (const it of [...items].sort((x, y) => civilKey(x.range.blockedFrom) - civilKey(y.range.blockedFrom))) {
        const free = units.filter((u) => {
          const taken = [...occupations, ...placed].filter((o) => o.unitId === u.id);
          return !taken.some((o) => civilKey(o.range.blockedFrom) < civilKey(it.range.blockedUntilExclusive) && civilKey(it.range.blockedFrom) < civilKey(o.range.blockedUntilExclusive));
        });
        if (free.length === 0) return false;
        placed.push({ unitId: free[0].id, range: it.range });
      }
      return true;
    };
    expect(naiveFirstFit()).toBe(false); // prova de que o caso derrota a estratégia gulosa
    expect(assignments(items, units, occupations)).toEqual({ a: 'u2', d: 'u1' });
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

  test('B3: o limite é de 6 peças físicas, validado ANTES da busca combinatória (sem exceção, sem travar)', () => {
    expect(MAX_ALLOCATION_ITEMS).toBe(6);
    const many = (count: number) => Array.from({ length: count }, (_, i) => item(`p${i}`, 'V1', '2026-12-01', '2026-12-03'));
    const manyUnits = Array.from({ length: 30 }, (_, i) => unit(`u${String(i).padStart(2, '0')}`, 'V1'));
    for (const count of [7, 11, 20, 1000]) {
      const started = Date.now();
      expect(failures(many(count), manyUnits)).toEqual(['undefined:too_many_items']);
      expect(Date.now() - started).toBeLessThan(200); // nem chegou a montar candidatas: não há busca
    }
    expect(assignments(many(6), manyUnits)).toEqual({ p0: 'u00', p1: 'u01', p2: 'u02', p3: 'u03', p4: 'u04', p5: 'u05' });
  });

  test('performance: o pior caso de 6 peças é imediato, e uma peça impossível é detectada sem varrer combinações', () => {
    const w1 = range('2026-12-01', '2026-12-05');
    const w2 = range('2026-12-10', '2026-12-14');
    const manyUnits = Array.from({ length: 60 }, (_, i) => unit(`u${String(i).padStart(2, '0')}`, 'V1'));
    // 3 peças só cabem em {u00,u01} (as outras 58 unidades estão ocupadas em w1) → impossível; as outras 3 têm 60 candidatas
    const busyAll = manyUnits.slice(2).map((u) => ({ unitId: u.id, range: w1 }));
    const items: AllocationItem[] = [
      ...['x1', 'x2', 'x3'].map((id) => ({ id, variantId: 'V1', range: w1 })),
      ...['y1', 'y2', 'y3'].map((id) => ({ id, variantId: 'V1', range: w2 })),
    ];
    const started = Date.now();
    const result = allocateUnitsPerItem(items, manyUnits, busyAll);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failures.every((f) => f.reason === 'items_conflict_with_each_other')).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
    // 6 peças que se sobrepõem todas, com exatamente 6 unidades
    const sixUnits = manyUnits.slice(0, 6);
    const sixItems = Array.from({ length: 6 }, (_, i) => item(`q${i}`, 'V1', '2026-12-01', '2026-12-05'));
    const t0 = Date.now();
    expect(Object.keys(assignments(sixItems, sixUnits))).toHaveLength(6);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(MAX_SEARCH_NODES).toBeGreaterThan(0);
  });

  test('B2: entradas malformadas viram falhas estruturadas, nunca exceção', () => {
    const run = (items: unknown, units: unknown = [unit('u1', 'V1')], occupations: unknown = []) =>
      allocateUnitsPerItem(items as AllocationItem[], units as AllocationUnit[], occupations as UnitOccupation[]);
    const good = item('a', 'V1', '2026-12-01', '2026-12-03');
    const cases: [unknown, unknown, unknown, string][] = [
      [[], [unit('u1', 'V1')], [], 'no_items'],
      [null, [], [], 'invalid_item'],
      [[null], [unit('u1', 'V1')], [], 'invalid_item'],
      [[{ id: '', variantId: 'V1', range: good.range }], [unit('u1', 'V1')], [], 'invalid_item'],
      [[{ id: 'a', variantId: 7, range: good.range }], [unit('u1', 'V1')], [], 'invalid_item'],
      [[good, good], [unit('u1', 'V1')], [], 'duplicate_item_id'],
      [[good], [null], [], 'invalid_unit'],
      [[good], [unit('u1', 'V1'), unit('u1', 'V1')], [], 'duplicate_unit_id'],
      [[good], [unit('u1', 'V1')], [null], 'invalid_occupation'],
      [[good], [unit('u1', 'V1')], [{ unitId: '', range: good.range }], 'invalid_occupation'],
    ];
    for (const [items, units, occupations, reason] of cases) {
      expect(() => run(items, units, occupations)).not.toThrow();
      const result = run(items, units, occupations);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.failures.map((f) => f.reason)).toContain(reason);
    }
  });

  test('R4: janela vazia, invertida ou com data inexistente é recusada (peça e ocupação)', () => {
    const badRanges: BlockedRange[] = [
      range('2026-12-05', '2026-12-05'), // vazia
      range('2026-12-10', '2026-12-05'), // invertida
      { blockedFrom: { year: 2026, month: 2, day: 31 }, blockedUntilExclusive: { year: 2026, month: 3, day: 5 } }, // data inexistente
      { blockedFrom: { year: NaN, month: 1, day: 1 }, blockedUntilExclusive: { year: 2026, month: 3, day: 5 } },
    ];
    for (const bad of badRanges) {
      expect(failures([{ id: 'a', variantId: 'V1', range: bad }], [unit('u1', 'V1')])).toEqual(['a:invalid_range']);
      // ocupação inválida NUNCA é ignorada: ignorá-la liberaria uma unidade possivelmente ocupada
      expect(failures([item('a', 'V1', '2026-12-01', '2026-12-03')], [unit('u1', 'V1')], [{ unitId: 'u1', range: bad }])).toEqual(['undefined:invalid_occupation']);
    }
    // janela de 1 dia ([d, d+1)) é válida
    expect(assignments([item('a', 'V1', '2026-12-05', '2026-12-06')], [unit('u1', 'V1')])).toEqual({ a: 'u1' });
  });

  test('viradas de mês, ano e ano bissexto: janelas que encostam não conflitam, sobrepostas conflitam', () => {
    const units = [unit('u1', 'V1')];
    // mês: [28/02, 01/03) em ano bissexto contém 29/02
    expect(failures([item('a', 'V1', '2028-02-27', '2028-03-01'), item('b', 'V1', '2028-02-29', '2028-03-03')], units)).toEqual(['a:items_conflict_with_each_other', 'b:items_conflict_with_each_other']);
    expect(assignments([item('a', 'V1', '2028-02-27', '2028-03-01'), item('b', 'V1', '2028-03-01', '2028-03-05')], units)).toEqual({ a: 'u1', b: 'u1' });
    // ano: [28/12, 02/01) e [02/01, 06/01) encostam
    expect(assignments([item('a', 'V1', '2026-12-28', '2027-01-02'), item('b', 'V1', '2027-01-02', '2027-01-06')], units)).toEqual({ a: 'u1', b: 'u1' });
    expect(failures([item('a', 'V1', '2026-12-28', '2027-01-03'), item('b', 'V1', '2027-01-02', '2027-01-06')], units)).toEqual(['a:items_conflict_with_each_other', 'b:items_conflict_with_each_other']);
    // 2027 não é bissexto: 29/02/2027 não existe
    expect(failures([{ id: 'a', variantId: 'V1', range: { blockedFrom: { year: 2027, month: 2, day: 29 }, blockedUntilExclusive: { year: 2027, month: 3, day: 2 } } }], units)).toEqual(['a:invalid_range']);
  });

  test('janela de uma peça criada pelo cronograma bate com a ocupação já gravada no banco (mesmo intervalo meio-aberto)', () => {
    const stored = blockedRangeFor(civilDateFromISO('2026-12-10'), civilDateFromISO('2026-12-12'), { prepDays: 3, cleaningDays: 2 });
    const newcomer = blockedRangeFor(civilDateFromISO('2026-12-17'), civilDateFromISO('2026-12-18'), { prepDays: 3, cleaningDays: 2 });
    // gravada: [7, 15); nova: [14, 21) → colidem em 14
    expect(failures([{ id: 'n', variantId: 'V1', range: newcomer }], [unit('u1', 'V1')], [{ unitId: 'u1', range: stored }])).toEqual(['n:no_free_unit']);
  });
});

const civilKey = (d: { year: number; month: number; day: number }) => d.year * 10_000 + d.month * 100 + d.day;
