import { describe, expect, test } from 'vitest';
import {
  canonicalItemsFingerprint,
  computeReservationSignature,
  generateReservationBindingId,
  groupAndSortVariantQuantities,
  normalizeVariantId,
  verifyReservationSignature,
  type ReservationBindingPayload,
} from './reservation-binding';

const SECRET = 'test-binding-secret';

function payload(overrides: Partial<ReservationBindingPayload> = {}): ReservationBindingPayload {
  return {
    reservationId: '11111111-1111-1111-1111-111111111111',
    reservationBindingId: 'abc123',
    itemsFingerprint: '447654529:1',
    pickupDate: '2027-01-10',
    effectiveReturnDate: '2027-01-12',
    ...overrides,
  };
}

describe('normalizeVariantId', () => {
  test('extrai o número de um GID completo', () => {
    expect(normalizeVariantId('gid://shopify/ProductVariant/447654529')).toBe('447654529');
  });
  test('número cru passa direto', () => {
    expect(normalizeVariantId('447654529')).toBe('447654529');
  });
});

describe('groupAndSortVariantQuantities / canonicalItemsFingerprint', () => {
  test('agrupa a mesma variante (GID e número cru) e soma quantidade', () => {
    const grouped = groupAndSortVariantQuantities([
      { variantId: 'gid://shopify/ProductVariant/1', quantity: 1 },
      { variantId: '1', quantity: 1 },
    ]);
    expect(grouped).toEqual([{ variantId: '1', quantity: 2 }]);
  });

  test('fingerprint é determinístico independente da ordem de entrada', () => {
    const a = canonicalItemsFingerprint([
      { variantId: '2', quantity: 1 },
      { variantId: '1', quantity: 3 },
    ]);
    const b = canonicalItemsFingerprint([
      { variantId: '1', quantity: 3 },
      { variantId: '2', quantity: 1 },
    ]);
    expect(a).toBe(b);
    expect(a).toBe('1:3|2:1');
  });
});

describe('generateReservationBindingId', () => {
  test('gera valores diferentes a cada chamada', () => {
    expect(generateReservationBindingId()).not.toBe(generateReservationBindingId());
  });
});

describe('computeReservationSignature / verifyReservationSignature', () => {
  test('assinatura correta → válida', () => {
    const sig = computeReservationSignature(SECRET, payload());
    expect(verifyReservationSignature(SECRET, payload(), sig)).toBe(true);
  });

  test('segredo errado → inválida', () => {
    const sig = computeReservationSignature(SECRET, payload());
    expect(verifyReservationSignature('wrong-secret', payload(), sig)).toBe(false);
  });

  test('reservationId diferente → inválida (não dá pra reaproveitar assinatura pra outra reserva)', () => {
    const sig = computeReservationSignature(SECRET, payload());
    expect(verifyReservationSignature(SECRET, payload({ reservationId: '22222222-2222-2222-2222-222222222222' }), sig)).toBe(false);
  });

  test('itemsFingerprint alterado (linhas trocadas) → inválida', () => {
    const sig = computeReservationSignature(SECRET, payload());
    expect(verifyReservationSignature(SECRET, payload({ itemsFingerprint: '999999999:5' }), sig)).toBe(false);
  });

  test('reservationBindingId diferente → inválida', () => {
    const sig = computeReservationSignature(SECRET, payload());
    expect(verifyReservationSignature(SECRET, payload({ reservationBindingId: 'different' }), sig)).toBe(false);
  });

  test('data alterada → inválida', () => {
    const sig = computeReservationSignature(SECRET, payload());
    expect(verifyReservationSignature(SECRET, payload({ effectiveReturnDate: '2027-01-13' }), sig)).toBe(false);
  });

  test('assinatura ausente → inválida, nunca lança', () => {
    expect(verifyReservationSignature(SECRET, payload(), undefined)).toBe(false);
    expect(verifyReservationSignature(SECRET, payload(), null)).toBe(false);
  });

  test('assinatura malformada (não-hex) → inválida, nunca lança', () => {
    expect(() => verifyReservationSignature(SECRET, payload(), 'not-hex-!!!')).not.toThrow();
    expect(verifyReservationSignature(SECRET, payload(), 'not-hex-!!!')).toBe(false);
  });
});
