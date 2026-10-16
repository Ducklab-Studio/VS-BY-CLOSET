import { describe, expect, test } from 'vitest';
import { civilDate, civilDateFromISO, civilDateToISO, dayOfWeek, type CivilDate } from './civil-date';
import { calculateBlockedRange } from './rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from './rental-rule-config';
import { blockedRangeFor, meetsMinimumAdvance, planItemSchedule, zonedTimeToInstant, type ScheduleRules } from './item-schedule';

/**
 * Cronograma por peça. Os números de preparação/limpeza/antecedência abaixo são DADOS DE TESTE (a regra comercial
 * final ainda não foi confirmada); o motor não embute nenhum deles.
 */
const TZ = 'America/Santiago';
const ALWAYS_OPEN = () => true;
const RULES: ScheduleRules = { prepDays: 3, cleaningDays: 0, minAdvanceHours: 48, timezone: TZ, isOpenOn: ALWAYS_OPEN };
const TEN_AM = { hour: 10, minute: 0 };
const iso = (d: CivilDate) => civilDateToISO(d);
const day = (s: string) => civilDateFromISO(s);
const NOW = new Date('2026-10-20T15:00:00Z'); // terça 12:00 em Santiago (UTC−3)

const plan = (pickup: string, days: number, rules: ScheduleRules = RULES, now: Date = NOW, time = TEN_AM) => planItemSchedule({ pickupDate: day(pickup), days, pickupTime: time }, rules, now);
const violations = (pickup: string, days: number, rules?: ScheduleRules, now?: Date, time?: { hour: number; minute: number }) => {
  const result = plan(pickup, days, rules, now, time);
  if (result.ok) throw new Error('esperava violação');
  return result.violations;
};

describe('fuso horário: data + hora local → instante', () => {
  test('Santiago no horário de verão (UTC−3) e no inverno (UTC−4)', () => {
    expect(zonedTimeToInstant(day('2026-10-26'), 10, 0, TZ).toISOString()).toBe('2026-10-26T13:00:00.000Z');
    expect(zonedTimeToInstant(day('2026-07-15'), 10, 0, TZ).toISOString()).toBe('2026-07-15T14:00:00.000Z');
    expect(zonedTimeToInstant(day('2026-12-31'), 23, 59, TZ).toISOString()).toBe('2027-01-01T02:59:00.000Z');
  });

  test('virada do horário de verão (setembro e abril) resolve para o instante correto', () => {
    // 2026-09-06 00:00 local não existe (salto para 01:00): cai no instante equivalente depois do salto
    const afterGap = zonedTimeToInstant(day('2026-09-06'), 12, 0, TZ);
    expect(afterGap.toISOString()).toBe('2026-09-06T15:00:00.000Z'); // já em UTC−3
    const beforeGap = zonedTimeToInstant(day('2026-09-05'), 12, 0, TZ);
    expect(beforeGap.toISOString()).toBe('2026-09-05T16:00:00.000Z'); // ainda UTC−4
    // abril: volta ao inverno
    expect(zonedTimeToInstant(day('2026-04-05'), 12, 0, TZ).toISOString()).toBe('2026-04-05T16:00:00.000Z');
  });

  test('outro fuso funciona igual (Brasília UTC−3)', () => {
    expect(zonedTimeToInstant(day('2026-10-26'), 10, 0, 'America/Sao_Paulo').toISOString()).toBe('2026-10-26T13:00:00.000Z');
  });
});

describe('cronograma por peça: retirada própria, duração própria', () => {
  test('1 dia: devolução no dia seguinte', () => {
    const result = plan('2026-10-26', 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(iso(result.schedule.returnDate)).toBe('2026-10-27');
    expect(result.schedule.days).toBe(1);
    expect(result.schedule.pickupAt.toISOString()).toBe('2026-10-26T13:00:00.000Z');
  });

  test('N dias: devolução = retirada + N, para qualquer N', () => {
    for (const [days, expected] of [[2, '2026-10-28'], [3, '2026-10-29'], [7, '2026-11-02'], [10, '2026-11-05']] as const) {
      const result = plan('2026-10-26', days);
      expect(result.ok && iso(result.schedule.returnDate)).toBe(expected);
    }
  });

  test('duas peças da mesma reserva com datas e durações diferentes não interferem entre si', () => {
    const a = plan('2026-10-26', 1);
    const b = plan('2026-11-03', 5);
    expect(a.ok && iso(a.schedule.returnDate)).toBe('2026-10-27');
    expect(b.ok && iso(b.schedule.returnDate)).toBe('2026-11-08');
    expect(a.ok && b.ok && iso(a.schedule.blockedRange.blockedFrom)).toBe('2026-10-23');
    expect(a.ok && b.ok && iso(b.schedule.blockedRange.blockedFrom)).toBe('2026-10-31');
  });
});

describe('janela bloqueada: mesma fórmula do motor atual', () => {
  test('preparação antes, limpeza depois, intervalo meio-aberto', () => {
    const range = blockedRangeFor(day('2026-10-26'), day('2026-10-28'), { prepDays: 3, cleaningDays: 2 });
    expect([iso(range.blockedFrom), iso(range.blockedUntilExclusive)]).toEqual(['2026-10-23', '2026-10-31']);
  });

  test('limpeza noturna = 0 dia de limpeza: a peça volta a ficar livre logo no dia seguinte à devolução', () => {
    const result = plan('2026-10-26', 2);
    expect(result.ok && iso(result.schedule.blockedRange.blockedUntilExclusive)).toBe('2026-10-29'); // devolução 28 → livre em 29
  });

  test('equivalente ao calculateBlockedRange do motor atual para as mesmas regras (sem divergência)', () => {
    for (const prep of [0, 1, 3, 5]) {
      for (const cleaning of [0, 2, 4]) {
        for (const days of [1, 2, 5]) {
          const pickup = day('2026-11-02');
          const returnDate = civilDate(2026, 11, 2 + days);
          const legacy = calculateBlockedRange(pickup, returnDate, { ...DEFAULT_RENTAL_RULE_CONFIG, prepDays: prep, cleaningDays: cleaning });
          expect(blockedRangeFor(pickup, returnDate, { prepDays: prep, cleaningDays: cleaning })).toEqual(legacy);
        }
      }
    }
  });
});

describe('antecedência mínima em HORAS (contra o instante da retirada)', () => {
  test('exatamente 48 h passa; 1 minuto a menos reprova', () => {
    // retirada qui 22/10 10:00 Santiago = 13:00Z; agora = ter 20/10 13:00Z → exatamente 48 h
    expect(plan('2026-10-22', 1, RULES, new Date('2026-10-20T13:00:00Z')).ok).toBe(true);
    expect(violations('2026-10-22', 1, RULES, new Date('2026-10-20T13:01:00Z'))).toEqual(['pickup_before_minimum_advance']);
  });

  test('depende do HORÁRIO de retirada, não só do dia: o mesmo dia pode passar às 18h e reprovar às 08h', () => {
    const now = new Date('2026-10-20T20:00:00Z'); // ter 17:00 Santiago
    expect(plan('2026-10-22', 1, RULES, now, { hour: 18, minute: 0 }).ok).toBe(true); // 49 h
    expect(violations('2026-10-22', 1, RULES, now, { hour: 8, minute: 0 })).toEqual(['pickup_before_minimum_advance']); // 39 h
  });

  test('a antecedência vale por peça: uma peça pode estar dentro do prazo e outra fora', () => {
    expect(plan('2026-10-23', 2).ok).toBe(true);
    expect(plan('2026-10-21', 2).ok).toBe(false);
  });

  test('é parâmetro: 0 h aceita retirada imediata; 72 h reprova o que 48 h aceitaria', () => {
    expect(plan('2026-10-20', 1, { ...RULES, minAdvanceHours: 0 }, new Date('2026-10-20T12:00:00Z')).ok).toBe(true);
    expect(violations('2026-10-23', 1, { ...RULES, minAdvanceHours: 72 }, new Date('2026-10-20T14:00:00Z'))).toEqual(['pickup_before_minimum_advance']);
  });

  test('meetsMinimumAdvance puro', () => {
    const at = new Date('2026-10-22T13:00:00Z');
    expect(meetsMinimumAdvance(at, new Date('2026-10-20T13:00:00Z'), 48)).toBe(true);
    expect(meetsMinimumAdvance(at, new Date('2026-10-20T13:00:00.001Z'), 48)).toBe(false);
  });
});

describe('calendário de funcionamento injetado (domingo e fechamentos)', () => {
  const sunday = (d: CivilDate) => dayOfWeek(d) === 0;

  test('domingo permitido quando o calendário de funcionamento abre no domingo', () => {
    const rules = { ...RULES, isOpenOn: ALWAYS_OPEN };
    const result = plan('2026-10-25', 1, rules); // domingo
    expect(dayOfWeek(day('2026-10-25'))).toBe(0);
    expect(result.ok && iso(result.schedule.returnDate)).toBe('2026-10-26');
  });

  test('domingo fechado: retirada e devolução em domingo viram violações explícitas (a regra de deslocamento é decisão comercial)', () => {
    const closedSundays = { ...RULES, isOpenOn: (d: CivilDate) => !sunday(d) };
    expect(violations('2026-10-25', 1, closedSundays)).toEqual(['pickup_closed']);
    expect(violations('2026-10-24', 1, closedSundays)).toEqual(['return_closed']); // sábado → domingo
    expect(plan('2026-10-26', 1, closedSundays).ok).toBe(true);
  });

  test('período de funcionamento: fora do intervalo informado, tudo fechado', () => {
    const season = { ...RULES, isOpenOn: (d: CivilDate) => iso(d) >= '2026-11-01' && iso(d) <= '2026-12-20' };
    expect(violations('2026-10-30', 1, season)).toEqual(['pickup_closed', 'return_closed']);
    expect(violations('2026-10-31', 1, season)).toEqual(['pickup_closed']);
    expect(plan('2026-11-05', 3, season).ok).toBe(true);
    expect(violations('2026-12-19', 3, season)).toEqual(['return_closed']);
  });

  test('início da operação', () => {
    const rules = { ...RULES, operationStartDate: day('2026-11-01') };
    expect(violations('2026-10-30', 1, rules)).toEqual(['pickup_before_operation_start']);
    expect(plan('2026-11-01', 1, rules).ok).toBe(true);
  });
});

describe('fail closed', () => {
  test('duração e horário inválidos', () => {
    for (const days of [0, -2, 1.5, Number.NaN]) expect(violations('2026-10-26', days)).toEqual(['invalid_days']);
    for (const time of [{ hour: 24, minute: 0 }, { hour: -1, minute: 0 }, { hour: 10, minute: 60 }, { hour: 10.5, minute: 0 }]) expect(violations('2026-10-26', 1, RULES, NOW, time)).toEqual(['invalid_pickup_time']);
  });

  test('teto de dias é opcional e explícito', () => {
    expect(plan('2026-10-26', 30).ok).toBe(true); // sem teto: o motor não inventa um
    expect(violations('2026-10-26', 8, { ...RULES, maxDays: 7 })).toEqual(['days_above_max']);
    expect(plan('2026-10-26', 7, { ...RULES, maxDays: 7 }).ok).toBe(true);
  });

  test('regras inválidas nunca produzem cronograma', () => {
    const bad: ScheduleRules[] = [
      { ...RULES, prepDays: -1 },
      { ...RULES, cleaningDays: 1.5 },
      { ...RULES, minAdvanceHours: -1 },
      { ...RULES, timezone: 'Nao/Existe' },
      { ...RULES, isOpenOn: undefined as unknown as ScheduleRules['isOpenOn'] },
      { ...RULES, maxDays: 0 },
    ];
    for (const rules of bad) expect(plan('2026-10-26', 1, rules)).toEqual({ ok: false, violations: ['invalid_rules'] });
  });

  test('várias violações juntas', () => {
    const rules: ScheduleRules = { ...RULES, isOpenOn: () => false };
    expect(violations('2026-10-20', 1, rules, new Date('2026-10-20T15:00:00Z'))).toEqual(['pickup_closed', 'return_closed', 'pickup_before_minimum_advance']);
  });

  test('o motor não lê o relógio: o mesmo "agora" dá sempre o mesmo resultado', () => {
    const first = plan('2026-10-26', 3);
    const second = plan('2026-10-26', 3);
    expect(second).toEqual(first);
  });
});
