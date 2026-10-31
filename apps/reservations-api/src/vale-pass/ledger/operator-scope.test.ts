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

  test('ADMIN sem vínculo NÃO opera nenhuma empresa (política padrão estrita); com vínculo fica restrito a ele', () => {
    expect(decideCompanyAccess('ADMIN', [], 'VS_BY_CLOSET')).toMatchObject({ allowed: false, code: 'NO_COMPANY_AUTHORIZED' });
    expect(decideCompanyAccess('ADMIN', [], 'VALLE_SHOWROOM')).toMatchObject({ allowed: false, code: 'NO_COMPANY_AUTHORIZED' });
    expect(decideCompanyAccess('ADMIN', ['VALLE_SHOWROOM'], 'VALLE_SHOWROOM')).toEqual({ allowed: true, basis: 'SCOPE' });
    expect(decideCompanyAccess('ADMIN', ['VALLE_SHOWROOM'], 'VS_BY_CLOSET')).toMatchObject({ allowed: false, code: 'COMPANY_NOT_AUTHORIZED' });
  });

  test('política ATUAL (decisão do Anderson, 26/10/2026): STAFF resgata, mas só nas empresas vinculadas; sem vínculo nada; o ADMIN também precisa de vínculo', () => {
    expect(OPERATOR_POLICY).toEqual({ staffMayRedeem: true, adminRequiresScope: true });
    expect(decideCompanyAccess('STAFF', ['VALLE_SHOWROOM'], 'VALLE_SHOWROOM')).toEqual({ allowed: true, basis: 'SCOPE' });
    expect(decideCompanyAccess('STAFF', ['VALLE_SHOWROOM'], 'VS_BY_CLOSET')).toMatchObject({ allowed: false, code: 'COMPANY_NOT_AUTHORIZED' });
    expect(decideCompanyAccess('STAFF', [], 'VALLE_SHOWROOM')).toMatchObject({ allowed: false, code: 'NO_COMPANY_AUTHORIZED' });
    expect(describeOperatorAccess('STAFF', ['VALLE_SHOWROOM'])).toMatch(/apenas na Valle Showroom/);
    expect(decideCompanyAccess('ADMIN', [], 'VS_BY_CLOSET')).toMatchObject({ allowed: false, code: 'NO_COMPANY_AUTHORIZED' });
    expect(decideCompanyAccess('SUPER_ADMIN', [], 'VS_BY_CLOSET')).toEqual({ allowed: true, basis: 'OWNER' });
    expect(decideCompanyAccess('SUPER_ADMIN', [], 'VALLE_SHOWROOM')).toEqual({ allowed: true, basis: 'OWNER' });
  });

  test('com o STAFF desligado (a trava continua testável) o vinculado também é recusado', () => {
    const OFF: OperatorPolicy = { staffMayRedeem: false, adminRequiresScope: false };
    expect(decideCompanyAccess('STAFF', ['VALLE_SHOWROOM', 'VS_BY_CLOSET'], 'VALLE_SHOWROOM', OFF)).toMatchObject({ allowed: false, code: 'STAFF_NOT_ENABLED' });
    expect(describeOperatorAccess('STAFF', ['VALLE_SHOWROOM'], OFF)).toMatch(/ainda não foi liberado/);
  });

  test('modo estrito (migração concluída): ADMIN sem vínculo deixa de operar; o proprietário nunca é bloqueado', () => {
    expect(decideCompanyAccess('ADMIN', [], 'VALLE_SHOWROOM', STRICT)).toMatchObject({ allowed: false, code: 'NO_COMPANY_AUTHORIZED' });
    expect(decideCompanyAccess('ADMIN', ['VALLE_SHOWROOM'], 'VALLE_SHOWROOM', STRICT)).toEqual({ allowed: true, basis: 'SCOPE' });
    expect(decideCompanyAccess('SUPER_ADMIN', [], 'VALLE_SHOWROOM', STRICT)).toEqual({ allowed: true, basis: 'OWNER' });
  });
});
