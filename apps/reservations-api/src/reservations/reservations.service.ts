import { ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { verifyHoldToken } from '../holds/hold-token';
import { civilDateFromPgDate, civilDateToISO } from '../rental-rules/civil-date';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReservationStatusResponse {
  readonly status: string;
  readonly paymentStatus?: string;
  readonly pickupDate: string | null;
  readonly effectiveReturnDate: string | null;
}

/**
 * Item 18 da Fase 7 — a página pós-checkout consulta ISTO pra saber se
 * pode dizer "confirmada", nunca o redirect por si (item 7/19: "jamais
 * window.location voltou = confirmed"). Mesma prova de posse da Fase 6
 * (reservationId + holdToken) — reservationId sozinho não é suficiente
 * pra ler status de outro cliente.
 */
@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getStatus(reservationId: string, holdToken: string | undefined): Promise<ReservationStatusResponse> {
    if (!UUID_RE.test(reservationId)) {
      throw new NotFoundException('Reserva não encontrada.');
    }
    if (!holdToken) {
      throw new ForbiddenException('Token de posse ausente.');
    }

    let reservation;
    try {
      reservation = await this.prisma.reservation.findUnique({ where: { id: reservationId } });
    } catch (err) {
      this.logger.error(`Falha ao consultar reserva para status: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível consultar a reserva no momento.');
    }

    if (!reservation) {
      throw new NotFoundException('Reserva não encontrada.');
    }
    if (!verifyHoldToken(holdToken, reservation.holdTokenHash)) {
      throw new ForbiddenException('Token de posse inválido.');
    }

    return {
      status: reservation.status,
      paymentStatus: derivePaymentStatus(reservation.status),
      pickupDate: reservation.pickupDate ? civilDateToISO(civilDateFromPgDate(reservation.pickupDate)) : null,
      effectiveReturnDate: reservation.returnDate ? civilDateToISO(civilDateFromPgDate(reservation.returnDate)) : null,
    };
  }
}

/** Resumo grosseiro pro frontend não precisar conhecer todo o enum
 *  operacional — `status` (o valor real) já vai na resposta pra quem
 *  precisar de mais detalhe. */
function derivePaymentStatus(status: string): string | undefined {
  switch (status) {
    case 'pending_payment':
      return 'pending';
    case 'confirmed':
    case 'preparing':
    case 'ready_for_pickup':
    case 'picked_up':
    case 'returned':
    case 'cleaning':
      return 'paid';
    case 'problem':
      return 'needs_review';
    case 'cancelled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    default:
      return undefined;
  }
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
