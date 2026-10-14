import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { expireDueReservations, type ExpiryResult } from './reservation-expiry';

const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 15;
const FIRST_RUN_DELAY_MS = 10_000;

/**
 * Expiração por tempo, sem depender de alguém criar um HOLD. Antes, a única coisa que
 * expirava um HOLD/pagamento vencido era a PRÓXIMA criação de HOLD, reserva manual ou
 * checkout: uma reserva aguardando pagamento cuja janela já passou seguia como "Aguardando
 * pagamento" e ocupando a peça no calendário e na disponibilidade pública por tempo
 * indeterminado. Este agendador aplica a MESMA regra (`expireDueReservations`) a cada
 * rodada. Nunca cancela reserva paga: só `hold` e `pending_payment` vencidos.
 */
@Injectable()
export class ReservationExpirySchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReservationExpirySchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  /** `env` só existe para testar o boot; o Nest chama sem argumento (usa o ambiente do processo). */
  onModuleInit(env: Record<string, string | undefined> = process.env): void {
    const seconds = reservationExpiryIntervalSeconds(env);
    if (seconds === null) {
      this.logger.log('Expiração automática de reservas vencidas desativada.');
      return;
    }
    this.logger.log(`Expiração automática de HOLDs e pagamentos vencidos a cada ${seconds} s.`);
    this.first = setTimeout(() => void this.runOnce(), FIRST_RUN_DELAY_MS);
    this.timer = setInterval(() => void this.runOnce(), seconds * 1000);
    this.first.unref?.();
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }

  /** Uma rodada; nunca duas ao mesmo tempo e nunca derruba o processo. */
  async runOnce(): Promise<ExpiryResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const result = await expireDueReservations(this.prisma);
      if (result.payments > 0) this.logger.log(`${result.payments} reserva(s) com janela de pagamento vencida expirada(s); peça(s) liberada(s).`);
      return result;
    } catch (err) {
      this.logger.warn(`Expiração automática não concluída: ${err instanceof Error ? err.name : 'unknown'}`);
      return null;
    } finally {
      this.running = false;
    }
  }
}

/** `null` = desligada (testes ou `RESERVATION_EXPIRY_INTERVAL_SECONDS=0`). Padrão 60 s; nunca menos de 15. */
export function reservationExpiryIntervalSeconds(env: Record<string, string | undefined>): number | null {
  if (env.VITEST || env.NODE_ENV === 'test') return null;
  const raw = env.RESERVATION_EXPIRY_INTERVAL_SECONDS?.trim();
  if (!raw) return DEFAULT_INTERVAL_SECONDS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.max(MIN_INTERVAL_SECONDS, Math.floor(seconds));
}
