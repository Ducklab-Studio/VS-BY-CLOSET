import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Controller()
export class AppController {
  constructor(private readonly prisma: PrismaService) {}

  // Confirma não só que o processo subiu, mas que a conexão com o Postgres
  // (e a extensão btree_gist / constraint EXCLUDE) está de pé — é o que
  // importa checar num sistema cujo trabalho todo é uma trava de banco.
  @Get('health')
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  }
}
