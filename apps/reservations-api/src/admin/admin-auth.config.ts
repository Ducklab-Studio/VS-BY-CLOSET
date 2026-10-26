import { Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * Segredo compartilhado que autentica os endpoints administrativos da
 * Fase 8 (POST /admin/reservations/manual, POST /admin/reservations/:id/cancel).
 * Não é autenticação de usuário/sessão (isso é trabalho da Fase 9, quando
 * existir painel) — é o mínimo real e seguro pedido explicitamente: um
 * bearer token comparado em tempo constante no servidor, nunca um header
 * arbitrário tipo `x-admin: true` que qualquer requisição pode forjar.
 *
 * Sem fallback de dev — mesmo padrão de SHOPIFY_CLIENT_SECRET/
 * RESERVATION_BINDING_SECRET: um endpoint administrativo sem credencial
 * real configurada não deveria aceitar NADA, em nenhum ambiente. Testes
 * setam ADMIN_API_TOKEN explicitamente, nunca dependem de um valor
 * previsível.
 */
export function resolveAdminApiToken(): string {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) {
    throw new ServiceUnavailableException('Endpoint administrativo não configurado.');
  }
  return token;
}

/** Tamanho mínimo do token "próximo" (rotação): valores curtos/previsíveis nunca são aceitos como segundo segredo. */
export const MIN_NEXT_TOKEN_LENGTH = 32;

/**
 * Tokens aceitos AGORA: o principal (`ADMIN_API_TOKEN`) e, só durante uma rotação, o "próximo" (`ADMIN_API_TOKEN_NEXT`), para que a troca entre a API e o site
 * (Vercel) não derrube o ClosetAdmin: a API passa a aceitar os DOIS, o site muda para o novo, e só então o principal vira o novo e o "próximo" é removido.
 * Sem `ADMIN_API_TOKEN_NEXT` o comportamento é exatamente o de sempre. O "próximo" é ignorado se for curto demais ou igual ao principal (erro de configuração
 * nunca amplia o acesso). Principal ausente continua falhando fechado (503), mesmo que o "próximo" exista.
 */
export function resolveAdminApiTokens(): readonly string[] {
  const primary = resolveAdminApiToken();
  const next = process.env.ADMIN_API_TOKEN_NEXT;
  if (!next) return [primary];
  if (next.length < MIN_NEXT_TOKEN_LENGTH || next === primary) {
    announce('ignored', 'ADMIN_API_TOKEN_NEXT está definido mas foi IGNORADO (curto demais ou igual ao principal): só o ADMIN_API_TOKEN é aceito.');
    return [primary];
  }
  announce('active', 'Rotação do ADMIN_API_TOKEN em andamento: a API aceita o token principal e o ADMIN_API_TOKEN_NEXT. Remova o NEXT ao concluir a rotação.');
  return [primary, next];
}

const rotationLogger = new Logger('AdminTokenRotation');
const announced = new Set<string>();

/** Aviso de configuração, uma vez por tipo e por processo. NUNCA inclui valores de token (só o nome das variáveis). */
function announce(kind: 'ignored' | 'active', message: string): void {
  if (announced.has(kind)) return;
  announced.add(kind);
  if (kind === 'ignored') rotationLogger.warn(message);
  else rotationLogger.log(message);
}

/** Só para testes: permite observar o aviso de novo. */
export function resetAdminTokenRotationAnnouncementsForTest(): void {
  announced.clear();
}
