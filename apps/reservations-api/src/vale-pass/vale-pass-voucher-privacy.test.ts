import { describe, expect, test } from 'vitest';
import { forRole } from './vale-pass-voucher-privacy';

const item = { code: 'VALLE-ABCD-EFGH', amountCents: 50_000, customerName: 'Maria Teste Souza', customerPhone: '+56 9 1234 5678', customerEmail: 'maria.souza@exemplo.invalid' };

describe('lista/consulta de vouchers: dados do cliente por papel', () => {
  test('ADMIN e SUPER_ADMIN veem tudo', () => {
    expect(forRole(item, 'ADMIN')).toEqual(item);
    expect(forRole(item, 'SUPER_ADMIN')).toEqual(item);
  });

  test('STAFF vê só dados mascarados; código, valor e demais campos continuam iguais', () => {
    const masked = forRole(item, 'STAFF');
    expect(masked).toEqual({ ...item, customerName: 'Maria S.', customerPhone: '***78', customerEmail: 'm***@exemplo.invalid' });
    expect(JSON.stringify(masked)).not.toContain('maria.souza');
    expect(JSON.stringify(masked)).not.toContain('5678');
    expect(JSON.stringify(masked)).not.toContain('Teste');
  });

  test('campos vazios continuam vazios (sem inventar máscara)', () => {
    expect(forRole({ ...item, customerName: null, customerPhone: null, customerEmail: null }, 'STAFF')).toMatchObject({ customerName: null, customerPhone: null, customerEmail: null });
  });
});
