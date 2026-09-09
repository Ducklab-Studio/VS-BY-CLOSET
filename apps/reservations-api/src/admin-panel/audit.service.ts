import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';

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

  async list(filters: AuditFilters): Promise<AuditEntry[]> {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);

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
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),
        this.prisma.reservationEvent.findMany({
          where: {
            type: { in: ['MANUAL_RESERVATION_CREATED', 'MANUAL_RESERVATION_CANCELLED'] },
            ...(afterClear ? { createdAt: afterClear } : {}),
          },
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
