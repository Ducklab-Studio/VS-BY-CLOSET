import { describe, expect, test } from 'vitest';
import { ARCHIVABLE_TERMINAL_STATUSES, OCCUPYING_RESERVATION_STATUSES } from './reservation-status';

/**
 * Unit puro (sem banco) — trava por escrito a lista de status
 * arquiváveis, pra qualquer alteração futura em `reservation-status.ts`
 * quebrar este teste em vez de silenciosamente mudar o que "Limpar
 * históricos" considera terminal.
 */
describe('ARCHIVABLE_TERMINAL_STATUSES', () => {
  test('contém exatamente os status terminais pedidos', () => {
    expect([...ARCHIVABLE_TERMINAL_STATUSES].sort()).toEqual(['cancelled', 'completed', 'expired'].sort());
  });

  test('nunca inclui um status ainda "ocupando" a unidade', () => {
    for (const status of ARCHIVABLE_TERMINAL_STATUSES) {
      expect(OCCUPYING_RESERVATION_STATUSES as readonly string[]).not.toContain(status);
    }
  });

  test('nunca inclui hold, pending_payment ou problem', () => {
    for (const forbidden of ['hold', 'pending_payment', 'confirmed', 'preparing', 'ready_for_pickup', 'picked_up', 'returned', 'cleaning', 'problem', 'late_payment_conflict', 'pending']) {
      expect(ARCHIVABLE_TERMINAL_STATUSES as readonly string[]).not.toContain(forbidden);
    }
  });
});
