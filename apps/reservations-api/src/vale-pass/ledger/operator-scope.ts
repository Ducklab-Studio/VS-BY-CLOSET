/**
 * Quem pode resgatar/reverter vouchers de qual estabelecimento (puro, sem banco). Regra de partida SEGURA:
 *  - SUPER_ADMIN (o proprietário): sempre as duas empresas.
 *  - STAFF: só as empresas explicitamente autorizadas; sem nenhuma autorização = nenhum resgate.
 *  - ADMIN: SEM autorização explícita mantém o acesso administrativo de hoje (as duas empresas) até a política de migração ser definida;
 *    COM autorização explícita fica restrito às empresas autorizadas (restringir é sempre o lado seguro).
 * Ninguém recebe autorização por padrão: o vínculo é sempre uma decisão registrada do proprietário.
 */
export type OperatorCompany = 'VALLE_SHOWROOM' | 'VS_BY_CLOSET';
export const OPERATOR_COMPANIES: readonly OperatorCompany[] = ['VALLE_SHOWROOM', 'VS_BY_CLOSET'];
export const COMPANY_NAMES: Record<OperatorCompany, string> = { VALLE_SHOWROOM: 'Valle Showroom', VS_BY_CLOSET: 'VS BY CLOSET' };

export type AccessBasis = 'OWNER' | 'LEGACY_ADMIN' | 'SCOPE';
export type AccessDenial = 'NO_COMPANY_AUTHORIZED' | 'COMPANY_NOT_AUTHORIZED';
export type AccessDecision = { readonly allowed: true; readonly basis: AccessBasis } | { readonly allowed: false; readonly code: AccessDenial; readonly message: string };

type Role = 'SUPER_ADMIN' | 'ADMIN' | 'STAFF';

export function decideCompanyAccess(role: Role, scopes: readonly OperatorCompany[], company: OperatorCompany): AccessDecision {
  if (role === 'SUPER_ADMIN') return { allowed: true, basis: 'OWNER' };
  if (scopes.includes(company)) return { allowed: true, basis: 'SCOPE' };
  if (role === 'ADMIN' && scopes.length === 0) return { allowed: true, basis: 'LEGACY_ADMIN' };
  if (scopes.length === 0) {
    return { allowed: false, code: 'NO_COMPANY_AUTHORIZED', message: 'Seu usuário não está autorizado a resgatar vouchers de nenhum estabelecimento. Peça ao proprietário.' };
  }
  return { allowed: false, code: 'COMPANY_NOT_AUTHORIZED', message: `Seu usuário não está autorizado a resgatar vouchers da ${COMPANY_NAMES[company]}.` };
}

/** Empresas que o usuário pode operar (para mostrar na tela; a decisão de verdade é sempre `decideCompanyAccess`, no servidor). */
export function operableCompanies(role: Role, scopes: readonly OperatorCompany[]): OperatorCompany[] {
  return OPERATOR_COMPANIES.filter((company) => decideCompanyAccess(role, scopes, company).allowed);
}

/** Resumo em texto da situação do operador (tela do ClosetAdmin). */
export function describeOperatorAccess(role: Role, scopes: readonly OperatorCompany[]): string {
  const companies = operableCompanies(role, scopes);
  if (companies.length === 0) return 'Sem estabelecimento autorizado: não realiza resgates.';
  if (companies.length === OPERATOR_COMPANIES.length) return 'Autorizado nos dois estabelecimentos.';
  return `Autorizado apenas na ${COMPANY_NAMES[companies[0]]}.`;
}
