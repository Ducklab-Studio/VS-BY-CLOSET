import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Sondas de saúde para orquestradores.
 *
 * A separação importa: `live` responde enquanto o processo estiver de pé, e
 * `ready` só passa quando o banco responde. Se as duas fossem a mesma sonda,
 * uma queda momentânea do Postgres faria o orquestrador matar e reiniciar
 * todos os containers — exatamente o oposto do que se quer nesse cenário.
 */
@Controller('health')
class HealthController {
  constructor(private prisma: PrismaService) {}

  /** Liveness: o processo está vivo? Nunca toca no banco. */
  @Public()
  @SkipThrottle()
  @Get('live')
  live() {
    return { status: 'ok', uptime: Math.floor(process.uptime()) };
  }

  /** Readiness: pode receber tráfego? Responde 503 se o banco não responde. */
  @Public()
  @SkipThrottle()
  @Get('ready')
  async ready() {
    const startedAt = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }
    return { status: 'ok', db: 'up', latencyMs: Date.now() - startedAt };
  }

  /** Compatibilidade com checagens genéricas de plataforma. */
  @Public()
  @SkipThrottle()
  @Get()
  async check() {
    let db = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = 'up';
    } catch {
      db = 'down';
    }
    return { status: 'ok', db, timestamp: new Date().toISOString() };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
