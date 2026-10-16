import { describe, expect, test } from 'vitest';
import { civilDate, civilDateFromISO, civilDateToISO, dayOfWeek, type CivilDate } from './civil-date';
import { calculateBlockedRange } from './rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from './rental-rule-config';
import { blockedRangeFor, meetsMinimumAdvance, planItemSchedule, planItemScheduleFromISO, zonedTimeToInstant, type ScheduleRules } from './item-schedule';

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

describe('R2: horário de verão em America/Santiago (2026: salto em 06/09, volta em 04/04)', () => {
  const at = (iso: string, hour: number, minute: number) => zonedTimeToInstant(day(iso), hour, minute, TZ).toISOString();

  test('hora INEXISTENTE (00:00–00:59 de 06/09, salto para 01:00) vale o relógio deslocado para frente pelo salto', () => {
    expect(at('2026-09-06', 0, 0)).toBe('2026-09-06T04:00:00.000Z'); // = 01:00 local (UTC−3)
    expect(at('2026-09-06', 0, 30)).toBe('2026-09-06T04:30:00.000Z'); // = 01:30 local
    expect(at('2026-09-06', 0, 59)).toBe('2026-09-06T04:59:00.000Z');
    // vizinhas que existem não mudam
    expect(at('2026-09-05', 23, 59)).toBe('2026-09-06T03:59:00.000Z'); // UTC−4
    expect(at('2026-09-06', 1, 0)).toBe('2026-09-06T04:00:00.000Z'); // UTC−3
    expect(at('2026-09-06', 1, 30)).toBe('2026-09-06T04:30:00.000Z');
  });

  test('hora REPETIDA (23:00–23:59 de 04/04) vale a PRIMEIRA ocorrência, a mais cedo', () => {
    expect(at('2026-04-04', 22, 59)).toBe('2026-04-05T01:59:00.000Z'); // UTC−3
    expect(at('2026-04-04', 23, 0)).toBe('2026-04-05T02:00:00.000Z'); // 1ª ocorrência (UTC−3), não 03:00Z
    expect(at('2026-04-04', 23, 30)).toBe('2026-04-05T02:30:00.000Z');
    expect(at('2026-04-04', 23, 59)).toBe('2026-04-05T02:59:00.000Z');
    expect(at('2026-04-05', 0, 0)).toBe('2026-04-05T04:00:00.000Z'); // já em UTC−4
  });

  test('o resultado é monotônico no tempo local nas horas que existem ao redor das duas transições', () => {
    // (a hora 00:xx de 06/09 não existe e fica de fora: ela é deslocada para 01:xx e, por construção, repete instantes)
    for (const [date, from, to] of [['2026-09-05', 20, 24], ['2026-09-06', 1, 4], ['2026-04-04', 20, 24], ['2026-04-05', 0, 4]] as const) {
      let previous = -Infinity;
      for (let hour = from; hour < to; hour++) {
        for (const minute of [0, 15, 30, 45]) {
          const ms = zonedTimeToInstant(day(date), hour, minute, TZ).getTime();
          expect(ms).toBeGreaterThanOrEqual(previous);
          previous = ms;
        }
      }
    }
  });

  test('a antecedência é em HORAS REAIS: atravessar o salto de setembro custa 1 h a menos de relógio', () => {
    // agora: sexta 04/09 12:00 local (UTC−4) = 16:00Z. Retirada dom 06/09 12:00 local (UTC−3) = 15:00Z → só 47 h reais.
    const nowAcrossGap = new Date('2026-09-04T16:00:00Z');
    expect(violations('2026-09-06', 1, RULES, nowAcrossGap, { hour: 12, minute: 0 })).toEqual(['pickup_before_minimum_advance']);
    expect(plan('2026-09-06', 1, RULES, nowAcrossGap, { hour: 13, minute: 0 }).ok).toBe(true); // 48 h exatas
  });

  test('a antecedência usa a 1ª ocorrência da hora repetida (lado conservador)', () => {
    // retirada sáb 04/04 23:30 → 02:30Z de 05/04 (1ª ocorrência). Agora = 02:30Z de 03/04 → exatamente 48 h → passa;
    // 1 min depois reprova. Pela 2ª ocorrência (03:30Z) o limite seria 1 h mais folgado — por isso a 1ª é a conservadora.
    expect(plan('2026-04-04', 1, RULES, new Date('2026-04-03T02:30:00Z'), { hour: 23, minute: 30 }).ok).toBe(true);
    expect(violations('2026-04-04', 1, RULES, new Date('2026-04-03T02:31:00Z'), { hour: 23, minute: 30 })).toEqual(['pickup_before_minimum_advance']);
  });

  test('retirada e janela do cronograma continuam corretas quando o aluguel atravessa a transição', () => {
    const result = plan('2026-09-04', 3, { ...RULES, minAdvanceHours: 0 }, new Date('2026-08-01T12:00:00Z'));
    expect(result.ok && iso(result.schedule.returnDate)).toBe('2026-09-07');
    expect(result.ok && result.schedule.pickupAt.toISOString()).toBe('2026-09-04T14:00:00.000Z'); // 10:00 em UTC−4
  });

  test('data ou hora inválida em zonedTimeToInstant lança RangeError (o cronograma valida antes)', () => {
    expect(() => zonedTimeToInstant({ year: 2026, month: 2, day: 31 }, 10, 0, TZ)).toThrow(RangeError);
    expect(() => zonedTimeToInstant(day('2026-10-26'), 24, 0, TZ)).toThrow(RangeError);
    expect(() => zonedTimeToInstant(day('2026-10-26'), 10, 60, TZ)).toThrow(RangeError);
  });
});

describe('B1: duração absurda e datas calculadas', () => {
  test('teto interno de sanidade: 3650 dias passa, 3651 não, com ou sem maxDays', () => {
    expect(plan('2026-10-26', 3650).ok).toBe(true);
    expect(violations('2026-10-26', 3651)).toEqual(['days_above_max']);
    for (const days of [1e9, Number.MAX_SAFE_INTEGER, 1e15]) expect(violations('2026-10-26', days)).toEqual(['days_above_max']);
    for (const days of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, Number.MAX_VALUE]) expect(violations('2026-10-26', days).length).toBeGreaterThan(0);
    // teto comercial menor continua valendo
    expect(violations('2026-10-26', 11, { ...RULES, maxDays: 10 })).toEqual(['days_above_max']);
    // teto comercial acima do de sanidade não o enfraquece
    expect(violations('2026-10-26', 4000, { ...RULES, maxDays: 100_000 })).toEqual(['days_above_max']);
  });

  test('nunca devolve ok com data inválida (NaN) em nenhum campo do cronograma', () => {
    for (const days of [1, 2, 30, 365, 3650]) {
      const result = plan('2026-10-26', days);
      if (!result.ok) throw new Error('esperava ok');
      const { schedule } = result;
      for (const d of [schedule.pickupDate, schedule.returnDate, schedule.blockedRange.blockedFrom, schedule.blockedRange.blockedUntilExclusive]) {
        expect(Number.isInteger(d.year) && Number.isInteger(d.month) && Number.isInteger(d.day)).toBe(true);
      }
      expect(Number.isNaN(schedule.pickupAt.getTime())).toBe(false);
    }
  });

  test('data calculada fora da faixa de anos aceita (perto de 2200) é recusada', () => {
    expect(violations('2199-12-31', 3650, { ...RULES, isOpenOn: () => true }, new Date('2199-01-01T00:00:00Z'))).toEqual(['invalid_computed_date']);
    expect(violations('2200-12-31', 1, RULES, new Date('2200-01-01T00:00:00Z'))).toEqual(['invalid_computed_date']);
    expect(violations('2201-01-01', 1, RULES, new Date('2200-01-01T00:00:00Z'))).toEqual(['invalid_pickup_date']);
  });
});

describe('B2: entradas inválidas viram violações estruturadas, nunca exceção', () => {
  const run = (request: unknown, rules: ScheduleRules = RULES, now: unknown = NOW) => planItemSchedule(request as Parameters<typeof planItemSchedule>[0], rules, now as Date);

  test('pickupDate NaN, nulo, ausente, texto ou com campos fora do calendário', () => {
    const pickupDates: unknown[] = [
      { year: NaN, month: NaN, day: NaN },
      { year: 2026, month: 13, day: 1 },
      { year: 2026, month: 0, day: 1 },
      { year: 2026, month: 2, day: 31 },
      { year: 2027, month: 2, day: 29 },
      { year: 2026.5, month: 1, day: 1 },
      { year: '2026', month: 1, day: 1 },
      { year: 1969, month: 12, day: 31 },
      null,
      undefined,
      '2026-10-26',
      42,
    ];
    for (const pickupDate of pickupDates) {
      expect(() => run({ pickupDate, days: 1, pickupTime: TEN_AM })).not.toThrow();
      expect(run({ pickupDate, days: 1, pickupTime: TEN_AM })).toEqual({ ok: false, violations: ['invalid_pickup_date'] });
    }
  });

  test('request, pickupTime, days e now malformados', () => {
    for (const request of [null, undefined, {}, 'x', 5]) expect(() => run(request)).not.toThrow();
    expect(run(null).ok).toBe(false);
    expect(run({ pickupDate: day('2026-10-26'), days: 1 })).toEqual({ ok: false, violations: ['invalid_pickup_time'] });
    expect(run({ pickupDate: day('2026-10-26'), days: 1, pickupTime: null })).toEqual({ ok: false, violations: ['invalid_pickup_time'] });
    expect(run({ pickupDate: day('2026-10-26'), days: '2', pickupTime: TEN_AM })).toEqual({ ok: false, violations: ['invalid_days'] });
    const request = { pickupDate: day('2026-10-26'), days: 1, pickupTime: TEN_AM };
    for (const bad of [new Date(Number.NaN), null, undefined, '2026-10-20', 0]) {
      // chamada direta: `undefined` não pode cair no valor padrão do helper `run`
      expect(() => planItemSchedule(request, RULES, bad as unknown as Date)).not.toThrow();
      expect(planItemSchedule(request, RULES, bad as unknown as Date)).toEqual({ ok: false, violations: ['pickup_before_minimum_advance'] });
    }
  });

  test('várias entradas inválidas juntas são todas reportadas', () => {
    expect(run({ pickupDate: null, days: 0, pickupTime: { hour: 99, minute: 0 } })).toEqual({ ok: false, violations: ['invalid_pickup_time', 'invalid_pickup_date', 'invalid_days'] });
  });

  test('regras com operationStartDate inválida são recusadas', () => {
    expect(run({ pickupDate: day('2026-10-26'), days: 1, pickupTime: TEN_AM }, { ...RULES, operationStartDate: { year: 2026, month: 2, day: 31 } })).toEqual({ ok: false, violations: ['invalid_rules'] });
  });
});

describe('R3: datas civis inexistentes são rejeitadas (parser estrito) sem mexer no legado', () => {
  const fromISO = (iso: unknown, days = 1) => planItemScheduleFromISO(iso as string, days, TEN_AM, RULES, NOW);

  test('formato inválido e datas que não existem', () => {
    for (const bad of ['2026-02-31', '2026-02-30', '2027-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-10-00', '2026-10-32', '2026-2-3', '26-10-26', '2026/10/26', ' 2026-10-26', '2026-10-26 ', '', 'abc', null, undefined, 20261026, '1969-12-31', '2201-01-01']) {
      expect(() => fromISO(bad)).not.toThrow();
      expect(fromISO(bad)).toEqual({ ok: false, violations: ['invalid_pickup_date'] });
    }
  });

  test('datas válidas, inclusive 29/02 de ano bissexto, passam', () => {
    for (const good of ['2028-02-29', '2026-10-26', '2026-12-31', '2027-01-01', '2032-02-29']) {
      const result = planItemScheduleFromISO(good, 1, TEN_AM, RULES, new Date('2026-01-01T12:00:00Z'));
      expect(result.ok).toBe(true);
    }
  });

  test('o comportamento do motor legado NÃO foi alterado: civilDateFromISO continua normalizando overflow', () => {
    expect(civilDateToISO(civilDateFromISO('2026-02-31'))).toBe('2026-03-03');
  });
});

describe('viradas de mês, ano e ano bissexto no cronograma', () => {
  const old = new Date('2020-01-01T12:00:00Z');
  const ret = (pickup: string, days: number) => {
    const result = plan(pickup, days, RULES, old);
    if (!result.ok) throw new Error(`esperava ok: ${result.violations}`);
    return [iso(result.schedule.returnDate), iso(result.schedule.blockedRange.blockedFrom), iso(result.schedule.blockedRange.blockedUntilExclusive)];
  };

  test('mês: 31→01, 30→01 e fevereiro de ano comum', () => {
    expect(ret('2026-10-31', 1)).toEqual(['2026-11-01', '2026-10-28', '2026-11-02']);
    expect(ret('2026-11-30', 2)).toEqual(['2026-12-02', '2026-11-27', '2026-12-03']);
    expect(ret('2027-02-28', 1)).toEqual(['2027-03-01', '2027-02-25', '2027-03-02']);
  });

  test('ano: 31/12→01/01 e preparação que volta para o ano anterior', () => {
    expect(ret('2026-12-31', 1)).toEqual(['2027-01-01', '2026-12-28', '2027-01-02']);
    expect(ret('2027-01-02', 2)).toEqual(['2027-01-04', '2026-12-30', '2027-01-05']);
    expect(ret('2026-12-30', 3)).toEqual(['2027-01-02', '2026-12-27', '2027-01-03']);
  });

  test('ano bissexto: 29/02 existe em 2028 e 2032, não em 2100', () => {
    expect(ret('2028-02-28', 1)).toEqual(['2028-02-29', '2028-02-25', '2028-03-01']);
    expect(ret('2028-02-28', 2)).toEqual(['2028-03-01', '2028-02-25', '2028-03-02']);
    expect(ret('2028-02-29', 1)).toEqual(['2028-03-01', '2028-02-26', '2028-03-02']);
    expect(ret('2032-02-27', 3)).toEqual(['2032-03-01', '2032-02-24', '2032-03-02']);
    expect(ret('2100-02-28', 1)).toEqual(['2100-03-01', '2100-02-25', '2100-03-02']); // 2100 não é bissexto
  });

  test('durações longas atravessam vários meses e anos', () => {
    expect(ret('2026-12-01', 61)).toEqual(['2027-01-31', '2026-11-28', '2027-02-01']);
    expect(ret('2026-01-01', 365)).toEqual(['2027-01-01', '2025-12-29', '2027-01-02']);
    expect(ret('2028-01-01', 366)).toEqual(['2029-01-01', '2027-12-29', '2029-01-02']);
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
