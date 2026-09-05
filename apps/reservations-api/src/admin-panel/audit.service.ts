import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
 * Fase 9, item 14 — /closetadmin/auditoria. União de duas fontes já
 * existentes (nenhuma tabela nova): `admin_audit_events` (login/logout/
 * regra/peça/bloqueio — ver ../admin/admin-audit.ts) e o subconjunto de
 * `reservation_events` que é de origem manual/admin (criar/cancelar
 * reserva manual — ver AdminReservationsService). Somente ADMIN
 * ("auditoria completa" no RBAC da Fase 9) — STAFF não vê auditoria.
 *
 * Nunca expõe PIN/pinHash/cookie/ADMIN_API_TOKEN/secrets — nenhuma das
 * duas fontes grava esses valores (ver comentários em admin-audit.ts e
 * no WebhooksService), então não há sanitização adicional a fazer aqui.
 */
@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(filters: AuditFilters): Promise<AuditEntry[]> {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);

    try {
      const [panelEvents, reservationEvents] = await Promise.all([
        this.prisma.adminAuditEvent.findMany({
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),
        this.prisma.reservationEvent.findMany({
          where: { type: { in: ['MANUAL_RESERVATION_CREATED', 'MANUAL_RESERVATION_CANCELLED'] } },
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),
      ]);

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
        ...reservationEvents.map((e): AuditEntry => {
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
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
