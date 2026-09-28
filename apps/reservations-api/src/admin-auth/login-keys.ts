import { createHash } from 'node:crypto';
import { normalizeClientIp } from '../client-ip';

export { normalizeClientIp };

/**
 * Header com o IP de quem digitou, repassado pelo SERVIDOR do site. A API só
 * lê isto em `/admin/auth/*`, que exige o token do servidor (AdminAuthGuard):
 * um navegador não chega aqui direto, então não consegue escolher o próprio
 * IP. Valor ausente ou inválido vira "unknown" — nunca é usado cru.
 */
export const CLIENT_IP_HEADER = 'x-closetadmin-client-ip';

/** Chaves de contagem de tentativas: só hash, nunca telefone ou IP crus na auditoria. */
export function loginKey(kind: 'id' | 'ip', value: string): string {
  return createHash('sha256').update(`admin-login-${kind}:${value}`, 'utf8').digest('hex').slice(0, 32);
}
