import { describe, expect, test } from 'vitest';
import { decideCompanyAccess, describeOperatorAccess, OPERATOR_POLICY, operableCompanies, type OperatorPolicy } from './operator-scope';

/** Política FUTURA (STAFF liberado): só para provar que a regra por loja está pronta; a política real de hoje é `OPERATOR_POLICY`. */
const STAFF_ENABLED: OperatorPolicy = { staffMayRedeem: true, adminRequiresScope: false };
const STRICT: OperatorPolicy = { staffMayRedeem: true, adminRequiresScope: true };

describe('autorização por estabelecimento (regra pura)', () => {
  test('SUPER_ADMIN opera as duas empresas, com ou sem vínculo', () => {
    expect(decideCompanyAccess('SUPER_ADMIN', [], 'VALLE_SHOWROOM')).toEqual({ allowed: true, basis: 'OWNER' });
    expect(decideCompanyAccess('SUPER_ADMIN', ['VS_BY_CLOSET'], 'VALLE_SHOWROOM')).toEqual({ allowed: true, basis: 'OWNER' });
  });

  test('STAFF sem nenhum vínculo não opera nenhuma empresa (regra segura de partida)', () => {
    for (const company of ['VALLE_SHOWROOM', 'VS_BY_CLOSET'] as const) {
      expect(decideCompanyAccess('STAFF', [], company, STAFF_ENABLED)).toMatchObject({ allowed: false, code: 'NO_COMPANY_AUTHORIZED' });
    }
    expect(operableCompanies('STAFF', [], STAFF_ENABLED)).toEqual([]);
    expect(describeOperatorAccess('STAFF', [], STAFF_ENABLED)).toMatch(/não realiza resgates/);
  });

  test('STAFF só opera a empresa em que foi autorizado; em outra é recusado', () => {
    expect(decideCompanyAccess('STAFF', ['VALLE_SHOWROOM'], 'VALLE_SHOWROOM', STAFF_ENABLED)).toEqual({ allowed: true, basis: 'SCOPE' });
    expect(decideCompanyAccess('STAFF', ['VALLE_SHOWROOM'], 'VS_BY_CLOSET', STAFF_ENABLED)).toMatchObject({ allowed: false, code: 'COMPANY_NOT_AUTHORIZED' });
  });

  test('funcionário autorizado nas duas lojas opera as duas, cada voucher na sua empresa', () => {
    const both = ['VALLE_SHOWROOM', 'VS_BY_CLOSET'] as const;
    expect(operableCompanies('STAFF', both, STAFF_ENABLED)).toEqual(['VALLE_SHOWROOM', 'VS_BY_CLOSET']);
    expect(describeOperatorAccess('STAFF', both, STAFF_ENABLED)).toMatch(/dois estabelecimentos/);
  });

  test('ADMIN sem vínculo mantém o acesso atual (legado, até a política de migração); com vínculo fica restrito a ele', () => {
    expect(decideCompanyAccess('ADMIN', [], 'VS_BY_CLOSET')).toEqual({ allowed: true, basis: 'LEGACY_ADMIN' });
    expect(decideCompanyAccess('ADMIN', ['VALLE_SHOWROOM'], 'VALLE_SHOWROOM')).toEqual({ allowed: true, basis: 'SCOPE' });
    expect(decideCompanyAccess('ADMIN', ['VALLE_SHOWROOM'], 'VS_BY_CLOSET')).toMatchObject({ allowed: false, code: 'COMPANY_NOT_AUTHORIZED' });
  });

  test('política ATUAL: STAFF nunca opera, nem vinculado (decisão comercial pendente); a política padrão é a mais restritiva para STAFF e preserva o ADMIN', () => {
    expect(OPERATOR_POLICY).toEqual({ staffMayRedeem: false, adminRequiresScope: false });
    expect(decideCompanyAccess('STAFF', ['VALLE_SHOWROOM', 'VS_BY_CLOSET'], 'VALLE_SHOWROOM')).toMatchObject({ allowed: false, code: 'STAFF_NOT_ENABLED' });
    expect(decideCompanyAccess('STAFF', [], 'VALLE_SHOWROOM')).toMatchObject({ allowed: false, code: 'NO_COMPANY_AUTHORIZED' });
    expect(describeOperatorAccess('STAFF', ['VALLE_SHOWROOM'])).toMatch(/ainda não foi liberado/);
    expect(decideCompanyAccess('ADMIN', [], 'VS_BY_CLOSET')).toEqual({ allowed: true, basis: 'LEGACY_ADMIN' });
  });

  test('modo estrito (migração concluída): ADMIN sem vínculo deixa de operar; o proprietário nunca é bloqueado', () => {
    expect(decideCompanyAccess('ADMIN', [], 'VALLE_SHOWROOM', STRICT)).toMatchObject({ allowed: false, code: 'NO_COMPANY_AUTHORIZED' });
    expect(decideCompanyAccess('ADMIN', ['VALLE_SHOWROOM'], 'VALLE_SHOWROOM', STRICT)).toEqual({ allowed: true, basis: 'SCOPE' });
    expect(decideCompanyAccess('SUPER_ADMIN', [], 'VALLE_SHOWROOM', STRICT)).toEqual({ allowed: true, basis: 'OWNER' });
  });
});
