import { ServiceUnavailableException } from '@nestjs/common';

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
