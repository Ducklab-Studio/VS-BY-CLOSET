/**
 * Quem pode resgatar/reverter vouchers de qual estabelecimento (puro, sem banco). Regra de partida SEGURA:
 *  - SUPER_ADMIN (o proprietário): sempre as duas empresas.
 *  - STAFF: pode RESGATAR (decisão do Anderson, 26/10/2026: "funcionários também podem validar"), mas SOMENTE as empresas explicitamente vinculadas pelo
 *    proprietário; sem vínculo = nenhum resgate. Reversão, bloqueio/desbloqueio e conciliação continuam exclusivos de ADMIN/SUPER_ADMIN (guards das rotas E
 *    verificação dentro do serviço). Os guards das rotas de resgate e `staffMayRedeem` dizem a MESMA coisa (há teste que trava a divergência).
 *  - ADMIN: SEM vínculo mantém o acesso administrativo de hoje (as duas empresas) até a política de migração ser definida (`adminRequiresScope = false`);
 *    COM vínculo fica restrito às empresas vinculadas (restringir é sempre o lado seguro).
 * Ninguém recebe vínculo por padrão: o vínculo é sempre uma decisão registrada do proprietário.
 */
export type OperatorCompany = 'VALLE_SHOWROOM' | 'VS_BY_CLOSET';
export const OPERATOR_COMPANIES: readonly OperatorCompany[] = ['VALLE_SHOWROOM', 'VS_BY_CLOSET'];
export const COMPANY_NAMES: Record<OperatorCompany, string> = { VALLE_SHOWROOM: 'Valle Showroom', VS_BY_CLOSET: 'VS BY CLOSET' };

export interface OperatorPolicy {
  /** STAFF vinculado pode RESGATAR (nunca reverter/bloquear)? Sim, desde 26/10/2026 (decisão do Anderson). */
  readonly staffMayRedeem: boolean;
  /** ADMIN sem vínculo deixa de operar? Hoje não (migração segura dos administradores atuais ainda a definir). */
  readonly adminRequiresScope: boolean;
}
export const OPERATOR_POLICY: OperatorPolicy = { staffMayRedeem: true, adminRequiresScope: false };

export type AccessBasis = 'OWNER' | 'LEGACY_ADMIN' | 'SCOPE';
export type AccessDenial = 'NO_COMPANY_AUTHORIZED' | 'COMPANY_NOT_AUTHORIZED' | 'STAFF_NOT_ENABLED';
export type AccessDecision = { readonly allowed: true; readonly basis: AccessBasis } | { readonly allowed: false; readonly code: AccessDenial; readonly message: string };

type Role = 'SUPER_ADMIN' | 'ADMIN' | 'STAFF';

const NO_SCOPE_MESSAGE = 'Seu usuário não está autorizado a resgatar vouchers de nenhum estabelecimento. Peça ao proprietário.';
const STAFF_MESSAGE = 'O resgate por funcionários (STAFF) ainda não foi liberado. Peça a um administrador.';

export function decideCompanyAccess(role: Role, scopes: readonly OperatorCompany[], company: OperatorCompany, policy: OperatorPolicy = OPERATOR_POLICY): AccessDecision {
  if (role === 'SUPER_ADMIN') return { allowed: true, basis: 'OWNER' };
  if (role === 'STAFF') {
    if (scopes.length === 0) return { allowed: false, code: 'NO_COMPANY_AUTHORIZED', message: NO_SCOPE_MESSAGE };
    if (!policy.staffMayRedeem) return { allowed: false, code: 'STAFF_NOT_ENABLED', message: STAFF_MESSAGE };
  }
  if (scopes.includes(company)) return { allowed: true, basis: 'SCOPE' };
  if (role === 'ADMIN' && scopes.length === 0) {
    return policy.adminRequiresScope ? { allowed: false, code: 'NO_COMPANY_AUTHORIZED', message: NO_SCOPE_MESSAGE } : { allowed: true, basis: 'LEGACY_ADMIN' };
  }
  return { allowed: false, code: 'COMPANY_NOT_AUTHORIZED', message: `Seu usuário não está autorizado a resgatar vouchers da ${COMPANY_NAMES[company]}.` };
}

/** Empresas que o usuário pode operar (para mostrar na tela; a decisão de verdade é sempre `decideCompanyAccess`, no servidor). */
export function operableCompanies(role: Role, scopes: readonly OperatorCompany[], policy: OperatorPolicy = OPERATOR_POLICY): OperatorCompany[] {
  return OPERATOR_COMPANIES.filter((company) => decideCompanyAccess(role, scopes, company, policy).allowed);
}

/** Resumo em texto da situação do operador (tela do ClosetAdmin). */
export function describeOperatorAccess(role: Role, scopes: readonly OperatorCompany[], policy: OperatorPolicy = OPERATOR_POLICY): string {
  if (role === 'STAFF' && scopes.length > 0 && !policy.staffMayRedeem) return 'Vinculado, mas o resgate por funcionários (STAFF) ainda não foi liberado.';
  const companies = operableCompanies(role, scopes, policy);
  if (companies.length === 0) return 'Sem estabelecimento autorizado: não realiza resgates.';
  if (companies.length === OPERATOR_COMPANIES.length) return 'Autorizado nos dois estabelecimentos.';
  return `Autorizado apenas na ${COMPANY_NAMES[companies[0]]}.`;
}
