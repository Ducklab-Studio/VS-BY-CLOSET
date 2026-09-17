import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Sistema de autorização de funcionários — ações que contam como
 * "alteração, cancelamento, pagamento, permissões e exclusão" (item do
 * pedido) ficam só na auditoria privada do SUPER_ADMIN, nunca visíveis a
 * funcionários mesmo com o módulo AUDIT concedido. Lista fixa aqui —
 * nunca inferida por nome/heurística, pra nunca esquecer de marcar uma
 * ação nova como crítica por engano.
 */
const CRITICAL_ACTIONS = new Set([
  'RULE_MODIFIED',
  'UNIT_ACTIVATED',
  'UNIT_DEACTIVATED',
  'UNIT_UPDATED',
  'BLOCK_CREATED',
  'BLOCK_REMOVED',
  'SHOPIFY_UNITS_IMPORTED',
  'RESERVATIONS_ARCHIVED',
  'RESERVATION_RESTORED',
  'RESERVATION_MANUAL_STATUS_CORRECTION',
  'AUDIT_CLEARED',
  'EMPLOYEE_CREATED',
  'EMPLOYEE_BLOCKED',
  'EMPLOYEE_REACTIVATED',
  'EMPLOYEE_REMOVED',
  'EMPLOYEE_RESTORED',
  'EMPLOYEE_PERMISSIONS_CHANGED',
  'ADMIN_SEED_APPLIED',
]);

/**
 * Grava em `admin_audit_events` — ações de painel que não pertencem
 * naturalmente a uma Reservation (login, logout, regra alterada, peça
 * ativada/desativada, bloqueio criado/removido). Ações que JÁ são de uma
 * Reservation (criar/cancelar manual, override) continuam em
 * `ReservationEvent` (Fase 7/8) — não duplicadas aqui.
 *
 * `adminUserId` nullable de propósito: uma tentativa de login que falhou
 * (usuário inexistente/inativo/PIN errado) não tem AdminUser real pra
 * vincular, mas ainda precisa ser auditável (item 18 — "não permitir
 * enumeração" é sobre a RESPOSTA HTTP, não sobre deixar de auditar).
 *
 * `isCritical`/`isPrivileged` são computados AQUI, automaticamente —
 * nenhum dos ~15 lugares que chamam esta função precisa saber que esses
 * campos existem. `isCritical` vem da lista fixa acima; `isPrivileged`
 * é uma consulta rápida em AdminUser pra saber se quem agiu era
 * SUPER_ADMIN ou isTechnical NO MOMENTO da ação (por isso não é lido do
 * `input`, e sim do banco, aqui). Os dois só controlam VISIBILIDADE pra
 * funcionários (ver AdminAuditService) — a linha em si nunca é escondida
 * do SUPER_ADMIN nem apagada.
 *
 * NUNCA passe PIN/pinHash/cookie/token/secret em `detail`/`before`/
 * `after` — quem chama é responsável por sanitizar antes (mesma regra
 * já seguida em WebhooksService desde a Fase 7).
 */
export async function writeAdminAuditEvent(
  client: Pick<PrismaService | Prisma.TransactionClient, 'adminAuditEvent' | 'adminUser'>,
  input: {
    adminUserId: string | null;
    adminUserName: string | null;
    action: string;
    entityType?: string;
    entityId?: string;
    before?: unknown;
    after?: unknown;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  let isPrivileged = false;
  if (input.adminUserId) {
    const actor = await client.adminUser.findUnique({ where: { id: input.adminUserId }, select: { role: true, isTechnical: true } });
    isPrivileged = actor?.role === 'SUPER_ADMIN' || actor?.isTechnical === true;
  }

  await client.adminAuditEvent.create({
    data: {
      adminUserId: input.adminUserId,
      adminUserName: input.adminUserName,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      before: (input.before as Prisma.InputJsonValue) ?? undefined,
      after: (input.after as Prisma.InputJsonValue) ?? undefined,
      detail: (input.detail as Prisma.InputJsonValue) ?? undefined,
      isCritical: CRITICAL_ACTIONS.has(input.action),
      isPrivileged,
    },
  });
}
