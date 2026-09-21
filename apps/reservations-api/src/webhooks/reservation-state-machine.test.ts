import { describe, expect, test } from 'vitest';
import { canTransition } from './reservation-state-machine';

describe('canTransition', () => {
  test('caminho normal: pending_payment → confirmed', () => {
    expect(canTransition('pending_payment', 'confirmed')).toBe(true);
  });

  test('expiração da janela de pagamento: pending_payment → expired', () => {
    expect(canTransition('pending_payment', 'expired')).toBe(true);
  });

  test('late payment recuperado: expired → confirmed', () => {
    expect(canTransition('expired', 'confirmed')).toBe(true);
  });

  test('late payment em conflito de CAPACIDADE: expired → late_payment_conflict (não "problem" genérico — ver schema.prisma)', () => {
    expect(canTransition('expired', 'late_payment_conflict')).toBe(true);
  });

  test('late payment com correlação INVÁLIDA (assinatura/linhas não batem): expired → problem', () => {
    expect(canTransition('expired', 'problem')).toBe(true);
  });

  test('correlação inválida chegando ainda em hold (antes do checkout terminar): hold → problem', () => {
    expect(canTransition('hold', 'problem')).toBe(true);
  });

  test('cancelamento antes da retirada: confirmed → cancelled', () => {
    expect(canTransition('confirmed', 'cancelled')).toBe(true);
  });

  test('ciclo físico: recebimento, higienização e liberação são transições separadas', () => {
    expect(canTransition('confirmed', 'returned')).toBe(true);
    expect(canTransition('picked_up', 'returned')).toBe(true);
    expect(canTransition('returned', 'cleaning')).toBe(true);
    expect(canTransition('cleaning', 'completed')).toBe(true);
    expect(canTransition('returned', 'completed')).toBe(false);
    expect(canTransition('confirmed', 'cleaning')).toBe(false);
  });

  test.each([
    ['completed', 'pending_payment'],
    ['cancelled', 'hold'],
    ['confirmed', 'hold'],
    ['problem', 'confirmed'],
    ['cancelled', 'confirmed'],
    ['picked_up', 'cancelled'], // item 11: nunca cancela automaticamente depois da retirada
    ['returned', 'cancelled'],
    ['cleaning', 'cancelled'],
    ['expired', 'hold'],
    ['expired', 'pending_payment'],
    ['late_payment_conflict', 'confirmed'],
  ] as const)('transição absurda proibida: %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  test('picked_up/returned/cleaning também podem ir para problem (revisão)', () => {
    expect(canTransition('picked_up', 'problem')).toBe(true);
    expect(canTransition('returned', 'problem')).toBe(true);
    expect(canTransition('cleaning', 'problem')).toBe(true);
  });

  test('estados terminais desta fase não têm saída', () => {
    expect(canTransition('problem', 'confirmed')).toBe(false);
    expect(canTransition('problem', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'confirmed')).toBe(false);
  });

  test('mesmo estado → mesmo estado nunca é uma transição válida', () => {
    expect(canTransition('confirmed', 'confirmed')).toBe(false);
    expect(canTransition('pending_payment', 'pending_payment')).toBe(false);
  });
});
