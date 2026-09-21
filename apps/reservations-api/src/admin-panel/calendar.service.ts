import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OCCUPYING_RESERVATION_STATUSES } from '../reservation-status';
import { civilDateFromISO, civilDateToISO, diffDays } from '../rental-rules/civil-date';

const MAX_RANGE_DAYS = 120;

export interface CalendarItem {
  readonly reservationId: string;
  readonly status: string;
  readonly source: string;
  readonly customerName: string | null;
  readonly rentalUnitId: string;
  readonly rentalUnitCode: string;
  readonly pickupDate: string | null;
  readonly effectiveReturnDate: string | null;
  readonly blockedFrom: string;
  readonly blockedUntilExclusive: string;
}

/**
 * Fase 9, item 5 — /closetadmin/calendario. Uma consulta só, sempre
 * escopada ao intervalo pedido (nunca "toda reserva do banco" — item 5:
 * "Não carregar todas as reservas sem necessidade"). O frontend deriva
 * visualmente as fases (preparação/retirada/aluguel/devolução/limpeza) a
 * partir de `pickupDate`/`effectiveReturnDate`/`blockedFrom`/
 * `blockedUntilExclusive` — o backend só entrega os fatos reais, nunca
 * uma segunda cópia da lógica de fases (mesmo princípio já documentado
 * em AvailabilityService).
 */
@Injectable()
export class AdminCalendarService {
  private readonly logger = new Logger(AdminCalendarService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getCalendar(fromIso: string, toIso: string): Promise<CalendarItem[]> {
    const from = civilDateFromISO(fromIso);
    const to = civilDateFromISO(toIso);
    if (diffDays(to, from) < 0) {
      throw new BadRequestException('"to" não pode ser anterior a "from".');
    }
    if (diffDays(to, from) > MAX_RANGE_DAYS) {
      throw new BadRequestException(`Período solicitado excede o máximo de ${MAX_RANGE_DAYS} dias.`);
    }

    try {
      return await this.prisma.$queryRaw<CalendarItem[]>`
        SELECT
          ri.reservation_id AS "reservationId", ri.status, r.source, r.customer_name AS "customerName",
          ri.rental_unit_id AS "rentalUnitId", ru.code AS "rentalUnitCode",
          r.pickup_date::text AS "pickupDate", r.return_date::text AS "effectiveReturnDate",
          (CASE WHEN ri.status IN ('returned', 'cleaning') THEN ${civilDateToISO(from)}::date ELSE lower(ri.blocked_range) END)::text AS "blockedFrom",
          (CASE WHEN ri.status IN ('returned', 'cleaning') THEN ${civilDateToISO(to)}::date ELSE upper(ri.blocked_range) END)::text AS "blockedUntilExclusive"
        FROM reservation_items ri
        JOIN reservations r ON r.id = ri.reservation_id
        JOIN rental_units ru ON ru.id = ri.rental_unit_id
        WHERE ri.status = ANY(${OCCUPYING_RESERVATION_STATUSES}::"reservation_status"[])
          AND (
            ri.blocked_range && daterange(${civilDateToISO(from)}::date, ${civilDateToISO(to)}::date, '[)')
            OR (ri.status IN ('returned', 'cleaning') AND lower(ri.blocked_range) <= ${civilDateToISO(to)}::date)
          )
        ORDER BY "blockedFrom"
      `;
    } catch (err) {
      this.logger.error(`Falha ao consultar calendário: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível consultar o calendário no momento.');
    }
  }
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
