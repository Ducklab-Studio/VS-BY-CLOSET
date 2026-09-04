import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';

/**
 * Origens que podem chamar esta API a partir do navegador do cliente.
 *
 * Não usa `*`: essa API vai, na Fase 5, criar HOLD e mexer em reserva —
 * um `Access-Control-Allow-Origin: *` deixaria QUALQUER site do mundo
 * fazer essas chamadas usando a sessão do navegador de um cliente
 * (o header CORS não é autenticação, mas é a primeira camada; não faz
 * sentido abrir mão dela sem necessidade).
 *
 * Vem de variável de ambiente — nunca hardcoded — porque muda por
 * ambiente (localhost em dev, o domínio da Vercel em produção) e porque
 * trocar de domínio não pode exigir rebuild do código.
 */
function allowedOrigins(): string[] {
  const raw = process.env.CORS_ALLOWED_ORIGINS ?? '';
  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    // Falha alto em produção — API sem CORS configurado bloquearia o
    // site de verdade silenciosamente, e o sintoma (erro de CORS no
    // navegador do cliente) é péssimo de diagnosticar à distância. Em
    // dev, sem a variável setada, cai pro localhost padrão do Next.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'CORS_ALLOWED_ORIGINS não configurada. Defina os domínios permitidos (separados por vírgula) antes de subir em produção.',
      );
    }
    return ['http://localhost:3000'];
  }

  return origins;
}

async function bootstrap() {
  // rawBody: true — item 3 da Fase 7, OBRIGATÓRIO pro webhook Shopify:
  // a assinatura HMAC cobre os bytes CRUS do corpo, não o JSON já
  // parseado/reserializado. O Nest continua populando `req.body`
  // normalmente pra todo o resto da API — isto só ADICIONA `req.rawBody`
  // (Buffer), não muda nada pras rotas existentes.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.use(helmet());

  app.enableCors({
    origin: allowedOrigins(),
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
