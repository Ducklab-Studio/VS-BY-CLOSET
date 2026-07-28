import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@loja/database';

const MAX_CONNECT_ATTEMPTS = 5;
const RETRY_BASE_MS = 500;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: process.env.NODE_ENV === 'production' ? ['warn', 'error'] : ['error'],
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
  }

  async onModuleInit() {
    // Em nuvem a API quase sempre sobe junto com o banco. Uma tentativa única
    // de conexão faz o container morrer em loop enquanto o Postgres ainda está
    // inicializando — o backoff cobre essa janela.
    for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
      try {
        await this.$connect();
        this.logger.log('Conectado ao banco de dados');
        return;
      } catch (err) {
        if (attempt === MAX_CONNECT_ATTEMPTS) throw err;
        const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
        this.logger.warn(
          `Banco indisponível (tentativa ${attempt}/${MAX_CONNECT_ATTEMPTS}). Nova tentativa em ${delay}ms.`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
