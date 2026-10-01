import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, type ReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { reservationAttentionSql } from './reservation-attention';

/**
 * Contador de novas reservas de aluguel (menu do ClosetAdmin) e a marcação
 * de "vista". Só lê e grava os campos de leitura (`viewed_*`): status,
 * pagamento, datas, peças, HOLD e `updated_at` nunca mudam aqui.
 */
@Injectable()
export class ReservationAttentionService {
  private readonly logger = new Logger(ReservationAttentionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Global para a equipe (quem tem o módulo de reservas vê o mesmo número). */
  async attentionCount(): Promise<{ count: number }> {
    try {
      const rows = await this.prisma.$queryRaw<{ count: number }[]>(
        Prisma.sql`SELECT count(*)::int AS count FROM reservations r WHERE ${reservationAttentionSql('r')}`,
      );
      return { count: rows[0]?.count ?? 0 };
    } catch (err) {
      this.logger.error(`Falha ao contar novas reservas: ${err instanceof Error ? err.name : 'unknown'}`);
      throw new ServiceUnavailableException('Não foi possível contar as novas reservas no momento.');
    }
  }

  /**
   * Marca como vistas as reservas que a tela EXIBIU, no status exibido. O
   * UPDATE é condicional (mesmo status ainda + ainda "nova"): se a reserva
   * mudou de status enquanto a tela estava aberta, continua contando; duas
   * abas ou duas pessoas marcando juntas gravam uma vez só (a segunda espera
   * o lock da linha, reavalia o WHERE e não acha mais nada) e o evento de
   * histórico sai uma vez só.
   */
  async markViewed(reservations: readonly { id: string; status: ReservationStatus }[], actor: { id: string; name: string }): Promise<{ marked: number }> {
    const unique = [...new Map(reservations.map((r) => [r.id, r])).values()];
    return this.prisma.$transaction(async (tx) => {
      let marked = 0;
      for (const reservation of unique) {
        const updated = await tx.$executeRaw(Prisma.sql`
          UPDATE reservations r
          SET viewed_at = now(), viewed_status = r.status, viewed_by = ${actor.id}::uuid
          WHERE r.id = ${reservation.id}::uuid
            AND r.status = ${reservation.status}::"reservation_status"
            AND ${reservationAttentionSql('r')}
        `);
        if (updated !== 1) continue;
        marked++;
        await tx.reservationEvent.create({
          data: { reservationId: reservation.id, type: 'RESERVATION_VIEWED', detail: { status: reservation.status, adminUserId: actor.id, adminUserName: actor.name } },
        });
      }
      return { marked };
    });
  }
}
