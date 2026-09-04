import { describe, expect, test } from 'vitest';
import {
  civilDate,
  civilDateFromISO,
  civilDateToISO,
  civilDateInZone,
  addDays,
  diffDays,
  compareCivilDates,
  dayOfWeek,
  isSunday,
} from './civil-date';

describe('civilDate — ISO round-trip', () => {
  test('civilDateFromISO/civilDateToISO são inversas', () => {
    expect(civilDateToISO(civilDateFromISO('2026-10-15'))).toBe('2026-10-15');
  });

  test('rejeita formato inválido', () => {
    expect(() => civilDateFromISO('15/10/2026')).toThrow();
  });
});

describe('addDays — fronteiras de calendário', () => {
  test('fim de mês (31/jan + 1 = 01/fev)', () => {
    expect(addDays(civilDate(2026, 1, 31), 1)).toEqual(civilDate(2026, 2, 1));
  });

  test('fim de ano (31/dez + 1 = 01/jan do ano seguinte)', () => {
    expect(addDays(civilDate(2026, 12, 31), 1)).toEqual(civilDate(2027, 1, 1));
  });

  test('ano bissexto reconhece 29/fev (2028)', () => {
    // 2028 é bissexto. 28/fev + 1 tem que ser 29/fev, não 01/mar.
    expect(addDays(civilDate(2028, 2, 28), 1)).toEqual(civilDate(2028, 2, 29));
  });

  test('ano NÃO bissexto pula 29/fev (2026)', () => {
    // 2026 não é bissexto. 28/fev + 1 tem que ir direto pra 01/mar.
    expect(addDays(civilDate(2026, 2, 28), 1)).toEqual(civilDate(2026, 3, 1));
  });

  test('subtração de dias (negativo) atravessa mês corretamente', () => {
    expect(addDays(civilDate(2026, 3, 2), -3)).toEqual(civilDate(2026, 2, 27));
  });
});

describe('diffDays / compareCivilDates', () => {
  test('diferença em dias, positiva quando a>b', () => {
    expect(diffDays(civilDate(2026, 10, 18), civilDate(2026, 10, 3))).toBe(15);
  });

  test('diferença em dias, negativa quando a<b', () => {
    expect(diffDays(civilDate(2026, 10, 3), civilDate(2026, 10, 18))).toBe(-15);
  });

  test('compareCivilDates ordena corretamente', () => {
    expect(compareCivilDates(civilDate(2026, 1, 1), civilDate(2026, 1, 2))).toBe(-1);
    expect(compareCivilDates(civilDate(2026, 1, 2), civilDate(2026, 1, 1))).toBe(1);
    expect(compareCivilDates(civilDate(2026, 1, 1), civilDate(2026, 1, 1))).toBe(0);
  });
});

describe('dayOfWeek / isSunday — âncora auto-verificável', () => {
  // 1970-01-01 (epoch) foi uma quinta-feira — fato bem estabelecido da
  // computação, não depende de eu saber de cabeça o dia da semana de
  // nenhuma data de 2026. 0=domingo..6=sábado, então quinta = 4.
  const epoch = civilDate(1970, 1, 1);

  test('âncora: 1970-01-01 é quinta-feira (dayOfWeek === 4)', () => {
    expect(dayOfWeek(epoch)).toBe(4);
  });

  test('sábado → domingo na conta (epoch+2=sábado, +3=domingo)', () => {
    const saturday = addDays(epoch, 2);
    const sunday = addDays(epoch, 3);
    expect(dayOfWeek(saturday)).toBe(6);
    expect(isSunday(sunday)).toBe(true);
    expect(dayOfWeek(sunday)).toBe(0);
  });

  test('domingo → segunda (epoch+3=domingo, +4=segunda)', () => {
    const sunday = addDays(epoch, 3);
    const monday = addDays(epoch, 4);
    expect(isSunday(sunday)).toBe(true);
    expect(isSunday(monday)).toBe(false);
    expect(dayOfWeek(monday)).toBe(1);
  });

  test('isSunday é falso pros outros 6 dias da semana', () => {
    for (let offset = 4; offset <= 9; offset++) {
      // offset 3 é domingo (já testado acima); 4..9 cobre seg..sáb da
      // semana seguinte, nenhum deve ser domingo.
      expect(isSunday(addDays(epoch, offset)), `offset ${offset} não deveria ser domingo`).toBe(false);
    }
  });
});

describe('civilDateInZone — America/Santiago', () => {
  test('meia-noite UTC de 2026-10-15 cai no dia 14 em Santiago (fuso negativo)', () => {
    // Santiago está atrás de UTC (UTC-3 ou UTC-4 conforme a época) — um
    // instante às 00:00 UTC ainda é o dia ANTERIOR lá. Isto prova que a
    // conversão realmente usa o fuso informado, não trata o instante
    // como se já fosse a data civil.
    const instant = new Date('2026-10-15T00:00:00Z');
    const result = civilDateInZone(instant, 'America/Santiago');
    expect(civilDateToISO(result)).toBe('2026-10-14');
  });

  test('meio-dia UTC de 2026-10-15 já cai no dia 15 em Santiago', () => {
    const instant = new Date('2026-10-15T12:00:00Z');
    const result = civilDateInZone(instant, 'America/Santiago');
    expect(civilDateToISO(result)).toBe('2026-10-15');
  });

  test(
    'varredura de um ano inteiro (2015, ano com mudança de DST confirmada ' +
      'no Chile) não pula nem repete dia civil ao redor da transição',
    () => {
      // Não presumo a data exata da transição de memória — em vez disso,
      // percorro 366 instantes consecutivos (24h exatas de diferença, em
      // UTC) e confiro que a data civil em Santiago avança exatamente 1
      // dia a cada passo, sem falha em NENHUM ponto do ano — inclusive
      // no dia em que o relógio de Santiago mudou. Se houvesse um bug de
      // deslocamento por DST, apareceria aqui como um dia repetido ou
      // pulado, sem eu precisar saber a data exata de antemão.
      let previous = civilDateInZone(new Date('2015-01-01T12:00:00Z'), 'America/Santiago');
      for (let day = 1; day <= 365; day++) {
        const instant = new Date(Date.UTC(2015, 0, 1, 12) + day * 86_400_000);
        const current = civilDateInZone(instant, 'America/Santiago');
        expect(
          diffDays(current, previous),
          `dia ${day}: esperava avançar exatamente 1 dia civil (de ${civilDateToISO(previous)}), ` +
            `obtive ${civilDateToISO(current)}`,
        ).toBe(1);
        previous = current;
      }
    },
  );
});
