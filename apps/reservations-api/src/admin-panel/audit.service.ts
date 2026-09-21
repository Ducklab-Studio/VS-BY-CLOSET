import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { AdminRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';

/** Mesma classificação de admin-audit.ts, mas pro lado de
 *  ReservationEvent (criar/cancelar reserva manual não passa por
 *  writeAdminAuditEvent — ver comentário no topo de AdminAuditEvent no
 *  schema). Só cancelamento é "crítico" pela definição do pedido
 *  (alteração/cancelamento/pagamento/permissões/exclusão); criar uma
 *  reserva manual não está nessa lista. */
const CRITICAL_RESERVATION_EVENT_TYPES = new Set([
  'MANUAL_RESERVATION_CANCELLED', 'RESERVATION_ITEM_RETURNED',
  'RESERVATION_ITEM_CLEANING_STARTED', 'RESERVATION_ITEM_CLEANING_COMPLETED',
]);

export interface AuditEntry {
  readonly id: string;
  readonly source: 'PANEL' | 'RESERVATION';
  readonly adminUserId: string | null;
  readonly adminUserName: string | null;
  readonly action: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly detail: unknown;
  readonly createdAt: string;
}

export interface AuditFilters {
  readonly limit?: number;
}

/**
 * A tela de auditoria une os eventos do painel com os eventos de reservas
 * manuais. O botão "Limpar logs" NÃO apaga histórico operacional do banco:
 * grava um marcador AUDIT_CLEARED e a listagem passa a mostrar somente os
 * eventos posteriores a esse marcador. Assim a tela fica limpa sem destruir
 * evidência de reserva, cancelamento, login ou alteração administrativa.
 */
@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Sistema de autorização de funcionários — "Funcionários não podem
   * visualizar ações do proprietário/técnico" + "Ações críticas...
   * devem continuar registradas em auditoria privada... acessível
   * somente ao Anderson/proprietário". `viewerRole` decide o filtro:
   * SUPER_ADMIN vê tudo (comportamento idêntico a antes deste sistema
   * existir); qualquer outro papel nunca recebe uma linha crítica
   * (`isCritical`) nem uma linha cujo autor era SUPER_ADMIN/técnico
   * (`isPrivileged`, ou o equivalente calculado aqui pro lado de
   * ReservationEvent). Nada é apagado nem escondido do SUPER_ADMIN —
   * só fora da resposta pra quem não pode ver.
   */
  async list(filters: AuditFilters, viewerRole: AdminRole): Promise<AuditEntry[]> {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const isSuperAdmin = viewerRole === 'SUPER_ADMIN';

    try {
      const cleared = await this.prisma.adminAuditEvent.findFirst({
        where: { action: 'AUDIT_CLEARED' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const afterClear = cleared ? { gt: cleared.createdAt } : undefined;

      const [panelEvents, reservationEvents] = await Promise.all([
        this.prisma.adminAuditEvent.findMany({
          where: {
            action: { not: 'AUDIT_CLEARED' },
            ...(afterClear ? { createdAt: afterClear } : {}),
            ...(isSuperAdmin ? {} : { isCritical: false, isPrivileged: false }),
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),
        this.prisma.reservationEvent.findMany({
          where: {
            // Cancelamento manual é "crítico" pela definição do pedido —
            // nunca visível a funcionário, mesmo com o módulo concedido.
            type: {
              in: isSuperAdmin
                ? ['MANUAL_RESERVATION_CREATED', ...CRITICAL_RESERVATION_EVENT_TYPES]
                : ['MANUAL_RESERVATION_CREATED'],
            },
            ...(afterClear ? { createdAt: afterClear } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),
      ]);

      // ReservationEvent não tem isPrivileged próprio (não passa por
      // writeAdminAuditEvent) — calculado aqui via lookup em lote dos
      // autores encontrados em detail.adminUserId, nunca N+1.
      let visibleReservationEvents = reservationEvents;
      if (!isSuperAdmin) {
        const actorIds = [
          ...new Set(
            reservationEvents
              .map((e) => (e.detail as Record<string, unknown> | null)?.adminUserId)
              .filter((id): id is string => typeof id === 'string'),
          ),
        ];
        const privilegedActors = actorIds.length
          ? await this.prisma.adminUser.findMany({
              where: { id: { in: actorIds }, OR: [{ role: 'SUPER_ADMIN' }, { isTechnical: true }] },
              select: { id: true },
            })
          : [];
        const privilegedIds = new Set(privilegedActors.map((u) => u.id));
        visibleReservationEvents = reservationEvents.filter((e) => {
          const actorId = (e.detail as Record<string, unknown> | null)?.adminUserId;
          return !(typeof actorId === 'string' && privilegedIds.has(actorId));
        });
      }

      const merged: AuditEntry[] = [
        ...panelEvents.map((e): AuditEntry => ({
          id: e.id,
          source: 'PANEL',
          adminUserId: e.adminUserId,
          adminUserName: e.adminUserName,
          action: e.action,
          entityType: e.entityType,
          entityId: e.entityId,
          before: e.before,
          after: e.after,
          detail: e.detail,
          createdAt: e.createdAt.toISOString(),
        })),
        ...visibleReservationEvents.map((e): AuditEntry => {
          const detail = (e.detail ?? {}) as Record<string, unknown>;
          return {
            id: e.id,
            source: 'RESERVATION',
            adminUserId: typeof detail.adminUserId === 'string' ? detail.adminUserId : null,
            adminUserName: typeof detail.adminUserName === 'string' ? detail.adminUserName : null,
            action: e.type,
            entityType: 'Reservation',
            entityId: e.reservationId,
            before: null,
            after: null,
            detail: e.detail,
            createdAt: e.createdAt.toISOString(),
          };
        }),
      ];

      merged.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      return merged.slice(0, limit);
    } catch (err) {
      this.logger.error(`Falha ao consultar auditoria: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível consultar a auditoria no momento.');
    }
  }

  async clear(adminUserId: string, adminUserName: string): Promise<{ clearedAt: string }> {
    try {
      await writeAdminAuditEvent(this.prisma, {
        adminUserId,
        adminUserName,
        action: 'AUDIT_CLEARED',
        entityType: 'AuditLog',
        entityId: 'global',
      });
      const marker = await this.prisma.adminAuditEvent.findFirstOrThrow({
        where: { action: 'AUDIT_CLEARED', adminUserId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      return { clearedAt: marker.createdAt.toISOString() };
    } catch (err) {
      this.logger.error(`Falha ao limpar visualização da auditoria: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível limpar os logs no momento.');
    }
  }
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
