import { describe, expect, test } from 'vitest';
import { civilDate, civilDateToISO } from '../rental-rules/civil-date';
import { daysLate, effectiveReturnPgDate, expectedReturnDate, hasOwnSchedule, readItemDates } from './item-schedule-read';

/** Datas como o Postgres devolve `date` ao Prisma: meia-noite UTC. */
const pg = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (d: ReturnType<typeof civilDate> | null) => (d ? civilDateToISO(d) : null);
const RESERVATION = { pickupDate: pg('2026-12-10'), returnDate: pg('2026-12-20') };

describe('readItemDates — fallback para a reserva (item legado)', () => {
  test('item legado (colunas nulas) lê EXATAMENTE as datas da reserva', () => {
    const read = readItemDates({ pickupDate: null, returnDate: null }, RESERVATION);
    expect(read.origin).toBe('reservation');
    expect([iso(read.pickupDate), iso(read.returnDate)]).toEqual(['2026-12-10', '2026-12-20']);
  });

  test('item ausente, indefinido ou sem os campos também cai na reserva', () => {
    for (const item of [null, undefined, {}, { pickupDate: undefined, returnDate: undefined }]) {
      const read = readItemDates(item, RESERVATION);
      expect(read.origin).toBe('reservation');
      expect(iso(read.returnDate)).toBe('2026-12-20');
    }
  });

  test('reserva sem datas (HOLD antigo, dado legado incompleto): null, sem inventar data', () => {
    const read = readItemDates({ pickupDate: null, returnDate: null }, { pickupDate: null, returnDate: null });
    expect([read.pickupDate, read.returnDate, read.origin]).toEqual([null, null, 'reservation']);
    expect(expectedReturnDate(null, { pickupDate: null, returnDate: null })).toBeNull();
    expect(effectiveReturnPgDate(null, { pickupDate: null, returnDate: null })).toBeNull();
  });
});

describe('readItemDates — cronograma por peça', () => {
  const item = { pickupDate: pg('2026-12-12'), returnDate: pg('2026-12-14') };

  test('item com cronograma próprio usa as datas DELE, não as da reserva', () => {
    const read = readItemDates(item, RESERVATION);
    expect(read.origin).toBe('item');
    expect([iso(read.pickupDate), iso(read.returnDate)]).toEqual(['2026-12-12', '2026-12-14']);
    expect(iso(expectedReturnDate(item, RESERVATION))).toBe('2026-12-14');
    expect(effectiveReturnPgDate(item, RESERVATION)).toEqual(pg('2026-12-14'));
  });

  test('duas peças da MESMA reserva com períodos diferentes não se confundem', () => {
    const a = { pickupDate: pg('2026-12-02'), returnDate: pg('2026-12-05') };
    const b = { pickupDate: pg('2026-12-20'), returnDate: pg('2026-12-22') };
    const reservation = { pickupDate: pg('2026-12-02'), returnDate: pg('2026-12-22') }; // mín. / máx. dos itens
    expect(iso(readItemDates(a, reservation).returnDate)).toBe('2026-12-05');
    expect(iso(readItemDates(b, reservation).returnDate)).toBe('2026-12-22');
    expect(iso(readItemDates(b, reservation).pickupDate)).toBe('2026-12-20');
  });

  test('cronograma "pela metade" (impossível pelo CHECK) cai no fallback seguro: nunca mistura item e reserva', () => {
    for (const partial of [{ pickupDate: pg('2026-12-12'), returnDate: null }, { pickupDate: null, returnDate: pg('2026-12-14') }]) {
      expect(hasOwnSchedule(partial)).toBe(false);
      const read = readItemDates(partial, RESERVATION);
      expect(read.origin).toBe('reservation');
      expect([iso(read.pickupDate), iso(read.returnDate)]).toEqual(['2026-12-10', '2026-12-20']);
    }
  });

  test('virada de mês, ano e ano bissexto', () => {
    const cases = [
      { item: { pickupDate: pg('2026-12-30'), returnDate: pg('2027-01-02') }, ret: '2027-01-02' },
      { item: { pickupDate: pg('2028-02-28'), returnDate: pg('2028-03-01') }, ret: '2028-03-01' },
      { item: { pickupDate: pg('2028-02-27'), returnDate: pg('2028-02-29') }, ret: '2028-02-29' },
    ];
    for (const { item: it, ret } of cases) expect(iso(readItemDates(it, RESERVATION).returnDate)).toBe(ret);
  });
});

describe('daysLate — mesma conta de antes (hoje − prevista, nunca negativa)', () => {
  const today = civilDate(2026, 12, 20);
  test('atrasado, no dia, adiantado e sem data prevista', () => {
    expect(daysLate(civilDate(2026, 12, 15), today)).toBe(5);
    expect(daysLate(civilDate(2026, 12, 20), today)).toBe(0);
    expect(daysLate(civilDate(2026, 12, 25), today)).toBe(0);
    expect(daysLate(null, today)).toBe(0);
  });
  test('atravessa mês e ano', () => {
    expect(daysLate(civilDate(2026, 12, 30), civilDate(2027, 1, 3))).toBe(4);
    expect(daysLate(civilDate(2028, 2, 28), civilDate(2028, 3, 1))).toBe(2); // 2028 é bissexto
    expect(daysLate(civilDate(2027, 2, 28), civilDate(2027, 3, 1))).toBe(1);
  });
  test('equivalência com a fórmula antiga para qualquer par de datas', () => {
    const legacy = (expected: ReturnType<typeof civilDate> | null, t: ReturnType<typeof civilDate>) =>
      expected ? Math.max(0, Math.round((Date.UTC(t.year, t.month - 1, t.day) - Date.UTC(expected.year, expected.month - 1, expected.day)) / 86_400_000)) : 0;
    for (let offset = -40; offset <= 40; offset++) {
      const expected = civilDate(2026, 12, 20 + offset);
      expect(daysLate(expected, today)).toBe(legacy(expected, today));
    }
  });
});
