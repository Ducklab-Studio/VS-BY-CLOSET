import { describe, expect, test } from 'vitest';
import { OCCUPYING_RESERVATION_STATUSES } from '../reservation-status';
import {
  HELD_UNTIL_COMPLETED_STATUSES,
  heldUntilCompleted,
  itemPickupDate,
  itemReturnDate,
  occupiedBounds,
  occupiesWindow,
  occupyingStatus,
  type ItemAlias,
  type ReservationAlias,
} from './occupancy-sql';

/** Forma do SQL gerado (sem banco). A equivalência de RESULTADO com o SQL antigo está em occupancy.equivalence.integration. */
const flat = (sql: { text: string }) => sql.text.replace(/\s+/g, ' ').trim();

describe('fragmentos de ocupação', () => {
  test('a regra "até concluir" cobre exatamente returned e cleaning (nem completed, nem cancelled)', () => {
    expect([...HELD_UNTIL_COMPLETED_STATUSES]).toEqual(['returned', 'cleaning']);
    expect(flat(heldUntilCompleted())).toBe("status IN ('returned', 'cleaning')");
    expect(flat(heldUntilCompleted('ri'))).toBe("ri.status IN ('returned', 'cleaning')");
    // ambos os status seguem na lista de ocupantes da EXCLUDE; completed/cancelled/expired não
    for (const status of HELD_UNTIL_COMPLETED_STATUSES) expect(OCCUPYING_RESERVATION_STATUSES).toContain(status);
    for (const status of ['completed', 'cancelled', 'expired', 'late_payment_conflict']) expect(OCCUPYING_RESERVATION_STATUSES).not.toContain(status);
  });

  test('occupiesWindow: status ocupante E (janela cruza OU peça recebida/em limpeza cuja janela começou até o fim)', () => {
    const query = occupiesWindow('2027-03-01', '2027-03-11');
    expect(flat(query)).toBe(
      'status = ANY($1::"reservation_status"[]) AND ( blocked_range && daterange($2::date, $3::date, \'[)\') ' +
        "OR (status IN ('returned', 'cleaning') AND lower(blocked_range) <= $4::date) )",
    );
    expect(query.values).toEqual([[...OCCUPYING_RESERVATION_STATUSES], '2027-03-01', '2027-03-11', '2027-03-11']);
  });

  test('com alias: todas as colunas levam o alias', () => {
    const query = flat(occupiesWindow('2027-03-01', '2027-03-11', 'ri'));
    expect(query).toContain('ri.status = ANY(');
    expect(query).toContain('ri.blocked_range && daterange(');
    expect(query).toContain("ri.status IN ('returned', 'cleaning')");
    expect(query).toContain('lower(ri.blocked_range) <=');
    expect(query).not.toMatch(/(^|[^.\w])blocked_range/); // nenhuma coluna sem alias
  });

  test('occupiedBounds: peça recebida/em limpeza ocupa TODO o intervalo pedido; as demais, a janela gravada', () => {
    const { lo, hi } = occupiedBounds('2027-03-01', '2027-03-11', 'ri');
    expect(flat(lo)).toBe("CASE WHEN ri.status IN ('returned', 'cleaning') THEN $1::date ELSE lower(ri.blocked_range) END");
    expect(flat(hi)).toBe("CASE WHEN ri.status IN ('returned', 'cleaning') THEN $1::date ELSE upper(ri.blocked_range) END");
    expect(lo.values).toEqual(['2027-03-01']);
    expect(hi.values).toEqual(['2027-03-11']);
  });

  test('occupyingStatus usa a MESMA lista da EXCLUDE (uma só fonte)', () => {
    expect(occupyingStatus().values).toEqual([[...OCCUPYING_RESERVATION_STATUSES]]);
  });

  test('datas por peça: COALESCE do item para a reserva (item legado lê a reserva)', () => {
    expect(flat(itemPickupDate('ri', 'r'))).toBe('COALESCE(ri.pickup_date, r.pickup_date)');
    expect(flat(itemReturnDate('ri', 'rs'))).toBe('COALESCE(ri.return_date, rs.return_date)');
  });
});

describe('segurança do SQL gerado', () => {
  test('alias fora da lista fechada é recusado (nada de entrada externa vira SQL)', () => {
    const evil = ["ri; DROP TABLE reservations; --", 'x', 'ri.', 'RI', ' ri'];
    for (const alias of evil) {
      expect(() => heldUntilCompleted(alias as ItemAlias)).toThrow(/alias/);
      expect(() => occupiesWindow('2027-03-01', '2027-03-11', alias as ItemAlias)).toThrow(/alias/);
      expect(() => itemPickupDate(alias as ItemAlias, 'r')).toThrow(/alias/);
      expect(() => itemReturnDate('ri', alias as ReservationAlias)).toThrow(/alias/);
    }
  });

  test('datas viram PARÂMETROS ($n), nunca texto no SQL', () => {
    const hostile = "2027-03-01'; DROP TABLE reservation_items; --";
    const query = occupiesWindow(hostile, hostile);
    expect(query.text).not.toContain('DROP');
    expect(query.values).toContain(hostile);
  });
});
