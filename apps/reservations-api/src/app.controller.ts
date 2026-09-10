import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Controller()
export class AppController {
  constructor(private readonly prisma: PrismaService) {}

  // Confirma não só que o processo subiu, mas que a conexão com o Postgres
  // (e a extensão btree_gist / constraint EXCLUDE) está de pé — é o que
  // importa checar num sistema cujo trabalho todo é uma trava de banco.
  @Get('health')
  async health() {
    try {
      const [checks] = await this.prisma.$queryRaw<{ ready: boolean }[]>`
        SELECT (
          EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist')
          AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservation_items_no_overlap_per_unit' AND contype = 'x' AND convalidated AND conrelid = 'reservation_items'::regclass)
          AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'reservation_status_sync' AND tgenabled IN ('O', 'A') AND tgrelid = 'reservations'::regclass)
          AND EXISTS (SELECT 1 FROM rental_rule_config WHERE id = 'default')
        ) AS ready
      `;
      if (!checks?.ready) throw new Error('Database invariants unavailable');
    } catch {
      throw new ServiceUnavailableException('Serviço indisponível.');
    }
    return { status: 'ok' };
  }
}
