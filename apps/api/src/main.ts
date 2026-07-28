// Ordem dos dois primeiros imports é significativa: o .env precisa estar em
// process.env antes de qualquer módulo ler configuração.
import './config/load-env';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { JsonLogger } from './common/logger/json-logger.service';
import { env } from './config/configuration';

async function bootstrap() {
  // Valida o ambiente antes de qualquer coisa: em produção, um segredo de
  // exemplo ou DATABASE_URL sem SSL derruba o processo aqui.
  const cfg = env();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new JsonLogger(),
    bufferLogs: false,
  });

  // ── Atrás de proxy reverso ───────────────────────────────────────────────
  // Sem isso req.ip vira o IP do load balancer: rate limit passa a contar todo
  // mundo como um cliente só e o log de auditoria registra o IP errado.
  if (cfg.trustProxy) {
    app.set('trust proxy', 1);
  }

  // ── Segurança ────────────────────────────────────────────────────────────
  app.use(
    helmet({
      // A API só devolve JSON; CSP é responsabilidade do Next.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      hsts: cfg.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );
  app.use(compression());
  app.use(cookieParser());

  // ── CORS ─────────────────────────────────────────────────────────────────
  // Com proxy de mesmo domínio a lista fica vazia e o CORS nem entra em ação,
  // porque o browser trata tudo como same-origin.
  if (cfg.corsOrigins.length > 0) {
    app.enableCors({
      origin: cfg.corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      maxAge: 86_400,
    });
  }

  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      // Em produção o erro não ecoa o valor recebido — evita vazar dado
      // sensível de volta pro cliente e pro agregador de log.
      validationError: { target: false, value: !cfg.isProduction },
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());

  // ── Encerramento gracioso ────────────────────────────────────────────────
  // Orquestradores mandam SIGTERM e esperam. Sem isso, cada deploy corta as
  // requisições em voo e deixa conexão de banco pendurada.
  app.enableShutdownHooks();

  // Escuta em 0.0.0.0: dentro de um container, ouvir só em localhost torna o
  // serviço inalcançável de fora, mesmo com a porta publicada.
  await app.listen(cfg.port, '0.0.0.0');

  Logger.log(
    {
      message: 'API pronta',
      port: cfg.port,
      env: cfg.nodeEnv,
      cors: cfg.corsOrigins.length > 0 ? cfg.corsOrigins.join(',') : 'same-origin (proxy)',
      redis: cfg.redisUrl ? 'conectado' : 'em memória',
      storage: cfg.storage ? cfg.storage.bucket : 'desabilitado',
    },
    'Bootstrap',
  );
}

bootstrap().catch((err) => {
  // Falha de boot precisa sair pelo stderr com código != 0 para o orquestrador
  // marcar o deploy como quebrado em vez de deixar o container reiniciando mudo.
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
