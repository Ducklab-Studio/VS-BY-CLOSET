import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { allowedOrigins, isOriginAllowed } from './cors-origins';

async function bootstrap() {
  // rawBody: true — item 3 da Fase 7, OBRIGATÓRIO pro webhook Shopify:
  // a assinatura HMAC cobre os bytes CRUS do corpo, não o JSON já
  // parseado/reserializado. O Nest continua populando `req.body`
  // normalmente pra todo o resto da API — isto só ADICIONA `req.rawBody`
  // (Buffer), não muda nada pras rotas existentes.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  app.use(helmet());

  // Railway/Vercel põem um proxy na frente: sem isto o Express reporta o
  // IP do proxy pra TODO request, e o ThrottlerGuard (app.module.ts)
  // vira um balde único global — medido de verdade: esgotado o limite
  // por um cliente, outro IP tomava 429 na primeira tentativa. Na
  // prática isso derrubava cliente da vitrine e webhook da Shopify por
  // causa de tráfego alheio. `1` = confia só no proxy imediato (o da
  // plataforma), nunca numa cadeia de X-Forwarded-For arbitrária.
  app.set('trust proxy', 1);

  const staticOrigins = allowedOrigins();
  app.enableCors({
    origin(origin, callback) {
      // Sem header Origin = chamada server-to-server (curl, healthcheck,
      // webhook da Shopify) — CORS é uma restrição do navegador, não se
      // aplica aqui.
      if (!origin || isOriginAllowed(origin, staticOrigins)) {
        callback(null, true);
        return;
      }
      callback(new Error('Origem não permitida por CORS.'));
    },
    methods: ['GET', 'POST'],
  });

  // whitelist: descarta campos não declarados no DTO em vez de repassar.
  // transform: query params chegam como string sempre (mesmo `?n=2`) —
  // sem isso, um @IsInt() num DTO rejeitaria "2" (string) como inválido.
  // forbidNonWhitelisted: campo extra não declarado é erro, não é
  // silenciosamente ignorado — evita que alguém mande um campo a mais
  // achando que ele faz algo e a API finja que processou.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT ?? 3333;
  await app.listen(port);
}

bootstrap();
