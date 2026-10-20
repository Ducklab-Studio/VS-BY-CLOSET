import { describe, expect, test } from 'vitest';
import { decideCompanyAccess, describeOperatorAccess, operableCompanies } from './operator-scope';

describe('autorização por estabelecimento (regra pura)', () => {
  test('SUPER_ADMIN opera as duas empresas, com ou sem vínculo', () => {
    expect(decideCompanyAccess('SUPER_ADMIN', [], 'VALLE_SHOWROOM')).toEqual({ allowed: true, basis: 'OWNER' });
    expect(decideCompanyAccess('SUPER_ADMIN', ['VS_BY_CLOSET'], 'VALLE_SHOWROOM')).toEqual({ allowed: true, basis: 'OWNER' });
  });

  test('STAFF sem nenhum vínculo não opera nenhuma empresa (regra segura de partida)', () => {
    for (const company of ['VALLE_SHOWROOM', 'VS_BY_CLOSET'] as const) {
      expect(decideCompanyAccess('STAFF', [], company)).toMatchObject({ allowed: false, code: 'NO_COMPANY_AUTHORIZED' });
    }
    expect(operableCompanies('STAFF', [])).toEqual([]);
    expect(describeOperatorAccess('STAFF', [])).toMatch(/não realiza resgates/);
  });

  test('STAFF só opera a empresa em que foi autorizado; em outra é recusado', () => {
    expect(decideCompanyAccess('STAFF', ['VALLE_SHOWROOM'], 'VALLE_SHOWROOM')).toEqual({ allowed: true, basis: 'SCOPE' });
    expect(decideCompanyAccess('STAFF', ['VALLE_SHOWROOM'], 'VS_BY_CLOSET')).toMatchObject({ allowed: false, code: 'COMPANY_NOT_AUTHORIZED' });
  });

  test('funcionário autorizado nas duas lojas opera as duas, cada voucher na sua empresa', () => {
    const both = ['VALLE_SHOWROOM', 'VS_BY_CLOSET'] as const;
    expect(operableCompanies('STAFF', both)).toEqual(['VALLE_SHOWROOM', 'VS_BY_CLOSET']);
    expect(describeOperatorAccess('STAFF', both)).toMatch(/dois estabelecimentos/);
  });

  test('ADMIN sem vínculo mantém o acesso atual (legado, até a política de migração); com vínculo fica restrito a ele', () => {
    expect(decideCompanyAccess('ADMIN', [], 'VS_BY_CLOSET')).toEqual({ allowed: true, basis: 'LEGACY_ADMIN' });
    expect(decideCompanyAccess('ADMIN', ['VALLE_SHOWROOM'], 'VALLE_SHOWROOM')).toEqual({ allowed: true, basis: 'SCOPE' });
    expect(decideCompanyAccess('ADMIN', ['VALLE_SHOWROOM'], 'VS_BY_CLOSET')).toMatchObject({ allowed: false, code: 'COMPANY_NOT_AUTHORIZED' });
  });
});
