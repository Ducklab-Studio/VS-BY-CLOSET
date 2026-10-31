import { createHash } from 'node:crypto';
import { trustedClientIp, type ClientIpRequest } from '../client-ip';
import { extractBearerToken, verifyAnyAdminToken } from './admin-token';
import { resolveAdminApiTokens } from './admin-auth.config';

/**
 * Balde do limite de tentativas das rotas administrativas SENSÍVEIS (consulta de saldo, resgate, reversão, bloqueio): por SESSÃO administrativa, não por IP.
 *
 * Por quê: essas rotas são chamadas pelo SERVIDOR do site (a API enxerga o endereço da Vercel, igual para todos os funcionários) e a confiança no cabeçalho de IP da
 * borda da Railway é discutível (ver `client-ip.ts` e docs/VALLE-PASS-IP-CONFIAVEL.md). A identidade da sessão não depende de nenhum cabeçalho de IP: quem tenta
 * enumerar códigos precisa de uma sessão válida e gasta o limite DELA, de onde quer que venha.
 *
 * O throttler roda ANTES do guarda de autenticação, então o token de sessão só vira chave quando a chamada traz também o token interno do servidor do site (que
 * nunca chega ao navegador): sem ele, um cliente direto poderia trocar de balde a cada tentativa inventando um token. Sem o token do servidor a chamada vai ser
 * recusada (401) e conta pelo IP confiável da conexão. A chave guarda só um hash curto do token de sessão (nunca o token).
 */
export function adminSessionThrottleTracker(req: Record<string, unknown>): Promise<string> {
  const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>;
  const session = headers['x-admin-session'];
  const token = Array.isArray(session) ? session[0] : session;
  if (typeof token === 'string' && token.length >= 16 && token.length <= 256 && hasValidServerToken(headers.authorization)) {
    return Promise.resolve(`session:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`);
  }
  return Promise.resolve(`conn:${trustedClientIp(req as ClientIpRequest)}`);
}

function hasValidServerToken(authorization: string | string[] | undefined): boolean {
  try {
    return verifyAnyAdminToken(extractBearerToken(Array.isArray(authorization) ? authorization[0] : authorization), resolveAdminApiTokens());
  } catch {
    return false; // token do servidor não configurado: nunca confia no token de sessão como chave
  }
}
