import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

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
 * NUNCA passe PIN/pinHash/cookie/token/secret em `detail`/`before`/
 * `after` — quem chama é responsável por sanitizar antes (mesma regra
 * já seguida em WebhooksService desde a Fase 7).
 */
export async function writeAdminAuditEvent(
  client: Pick<PrismaService | Prisma.TransactionClient, 'adminAuditEvent'>,
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
    },
  });
}
