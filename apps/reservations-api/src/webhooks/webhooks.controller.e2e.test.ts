import { ShopifyOrderSyncService } from './shopify-order-sync.service';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';
import { ValePassWebhookService } from '../vale-pass/vale-pass-webhook.service';

/**
 * Item 3 da Fase 7 — "Teste explicitamente: assinatura correta;
 * assinatura incorreta; corpo alterado depois da assinatura; header
 * ausente." Isto é fundamentalmente uma preocupação de camada HTTP (o
 * corpo CRU só existe como bytes de rede) — webhooks.service.test.ts já
 * cobre a lógica de negócio, este arquivo cobre especificamente a fiação
 * HTTP: captura do corpo cru e verificação HMAC contra bytes reais que
 * atravessaram uma conexão de verdade.
 *
 * NÃO usa `NestFactory.create(AppModule)` — achado real ao tentar: o
 * Vitest transforma TypeScript via esbuild, que não implementa
 * `emitDecoratorMetadata` (a metainformação de tipo que o container de
 * DI do Nest usa pra resolver `constructor(private readonly x: Y)`)
 * igual ao `tsc` real; subir a aplicação inteira assim deixa
 * `this.webhooks` undefined no controller sem erro nenhum no boot
 * (confirmado rodando, não suposto). Em vez de lutar contra a
 * ferramenta, instancia o controller DIRETO (mesmo padrão já usado em
 * todo o resto da suíte — `new HoldsService(...)`, etc.) sobre um
 * servidor HTTP `node:http` de verdade, capturando o corpo cru
 * manualmente — exatamente o que `rawBody: true` do Nest faz por baixo
 * dos panos. Prova o mesmo caminho de bytes; só não depende do
 * container de DI.
 */
const SECRET = 'e2e-test-webhook-secret';
const STORE_DOMAIN = 'e2e-webhooks.myshopify.com';
const originalSecret = process.env.SHOPIFY_CLIENT_SECRET;
const originalDomain = process.env.SHOPIFY_STORE_DOMAIN;
const originalCurrency = process.env.SHOPIFY_STORE_CURRENCY;

const prisma = new PrismaService();
const controller = new WebhooksController(new WebhooksService(prisma, new ValePassWebhookService(), new ShopifyOrderSyncService()));

let server: Server;
let baseUrl: string;

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('base64');
}

beforeAll(async () => {
  process.env.SHOPIFY_CLIENT_SECRET = SECRET;
  process.env.SHOPIFY_STORE_DOMAIN = STORE_DOMAIN;
  process.env.SHOPIFY_STORE_CURRENCY = 'CLP';
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks);
      try {
        const result = await controller.receive(
          { rawBody },
          asHeader(req.headers['x-shopify-hmac-sha256']),
          asHeader(req.headers['x-shopify-topic']),
          asHeader(req.headers['x-shopify-webhook-id']),
          asHeader(req.headers['x-shopify-shop-domain']),
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        const status = (err as { status?: number }).status ?? 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: (err as { message?: string }).message ?? 'error' }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/webhooks/shopify`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await prisma.store.deleteMany({ where: { id: STORE_DOMAIN } });
  await prisma.$disconnect();
  restoreEnv('SHOPIFY_CLIENT_SECRET', originalSecret);
  restoreEnv('SHOPIFY_STORE_DOMAIN', originalDomain);
  restoreEnv('SHOPIFY_STORE_CURRENCY', originalCurrency);
});

function asHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function signedHeaders(body: string, webhookId: string, extra: Record<string, string> = {}) {
  return {
    'Content-Type': 'application/json',
    'X-Shopify-Hmac-Sha256': sign(body),
    'X-Shopify-Topic': 'orders/paid',
    'X-Shopify-Webhook-Id': webhookId,
    'X-Shopify-Shop-Domain': STORE_DOMAIN,
    ...extra,
  };
}

async function cleanupEvent(webhookId: string) {
  const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM webhook_events WHERE shopify_webhook_id = ${webhookId}`;
  const ids = rows.map((r) => r.id);
  if (ids.length) await prisma.$executeRaw`DELETE FROM reservation_events WHERE webhook_event_id = ANY(${ids}::uuid[])`;
  await prisma.$executeRaw`DELETE FROM webhook_events WHERE shopify_webhook_id = ${webhookId}`;
}

describe('POST /webhooks/shopify — e2e real (HMAC + corpo cru, servidor HTTP de verdade)', () => {
  test('1) assinatura correta → 200, processado', async () => {
    const webhookId = `e2e-${Date.now()}-ok`;
    const body = JSON.stringify({ id: 999001, admin_graphql_api_id: 'gid://shopify/Order/999001', note_attributes: [] });
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': sign(body),
        'X-Shopify-Topic': 'orders/paid',
        'X-Shopify-Webhook-Id': webhookId,
        'X-Shopify-Shop-Domain': STORE_DOMAIN,
      },
      body,
    });
    expect(res.status, await res.text()).toBe(200);
    await cleanupEvent(webhookId);
  }, 15_000); // primeira query real do arquivo — conexão fria com o Neon fica perto do timeout padrão de 5s

  test('2) assinatura incorreta → rejeitado, nunca processa', async () => {
    const webhookId = `e2e-${Date.now()}-bad-sig`;
    const body = JSON.stringify({ id: 999002 });
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': 'aW52YWxpZC1zaWduYXR1cmU=',
        'X-Shopify-Topic': 'orders/paid',
        'X-Shopify-Webhook-Id': webhookId,
        'X-Shopify-Shop-Domain': STORE_DOMAIN,
      },
      body,
    });
    expect(res.status).toBe(401);
    const count = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM webhook_events WHERE shopify_webhook_id = ${webhookId}`;
    expect(Number(count[0].count)).toBe(0);
  });

  test('3) corpo alterado depois de assinado → rejeitado (a assinatura não cobre o corpo que efetivamente chegou)', async () => {
    const webhookId = `e2e-${Date.now()}-tampered`;
    const original = JSON.stringify({ id: 999003, financial_status: 'pending' });
    const tampered = JSON.stringify({ id: 999003, financial_status: 'paid' });
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': sign(original), // assina UMA coisa
        'X-Shopify-Topic': 'orders/paid',
        'X-Shopify-Webhook-Id': webhookId,
        'X-Shopify-Shop-Domain': STORE_DOMAIN,
      },
      body: tampered, // envia OUTRA
    });
    expect(res.status).toBe(401);
  });

  test('5) assinada com o secret ERRADO (não o configurado no servidor) → rejeitado', async () => {
    const webhookId = `e2e-${Date.now()}-wrong-secret`;
    const body = JSON.stringify({ id: 999007 });
    const wrongSignature = createHmac('sha256', 'este-nao-e-o-secret-do-servidor').update(Buffer.from(body, 'utf8')).digest('base64');
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': wrongSignature,
        'X-Shopify-Topic': 'orders/paid',
        'X-Shopify-Webhook-Id': webhookId,
        'X-Shopify-Shop-Domain': STORE_DOMAIN,
      },
      body,
    });
    expect(res.status).toBe(401);
    const count = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM webhook_events WHERE shopify_webhook_id = ${webhookId}`;
    expect(Number(count[0].count)).toBe(0);
  });

  test('assinatura de tamanho inválido (base64 válido, curto demais pra ser um SHA-256) → rejeitado, 401 nunca 500', async () => {
    const webhookId = `e2e-${Date.now()}-short-sig`;
    const body = JSON.stringify({ id: 999008 });
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': 'AAAA', // decodifica pra só 3 bytes — nunca pode bater com um HMAC-SHA256 real (32 bytes)
        'X-Shopify-Topic': 'orders/paid',
        'X-Shopify-Webhook-Id': webhookId,
        'X-Shopify-Shop-Domain': STORE_DOMAIN,
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  test('4) header de assinatura ausente → rejeitado', async () => {
    const webhookId = `e2e-${Date.now()}-no-header`;
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Topic': 'orders/paid', 'X-Shopify-Webhook-Id': webhookId, 'X-Shopify-Shop-Domain': STORE_DOMAIN },
      body: JSON.stringify({ id: 999004 }),
    });
    expect(res.status).toBe(401);
  });

  test('X-Shopify-Topic ausente (mesmo com assinatura válida) → rejeitado, 400', async () => {
    const body = JSON.stringify({ id: 999005 });
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': sign(body), 'X-Shopify-Webhook-Id': 'e2e-no-topic', 'X-Shopify-Shop-Domain': STORE_DOMAIN },
      body,
    });
    expect(res.status).toBe(400);
  });

  test('30) payload malformado (JSON inválido, assinatura válida pro corpo cru enviado) → 400, não 500', async () => {
    const body = '{not valid json';
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': sign(body),
        'X-Shopify-Topic': 'orders/paid',
        'X-Shopify-Webhook-Id': 'e2e-malformed',
        'X-Shopify-Shop-Domain': STORE_DOMAIN,
      },
      body,
    });
    expect(res.status).toBe(400);
  });

  test('6) duplicado via HTTP real (mesmo X-Shopify-Webhook-Id duas vezes) → 200 nas duas, sem erro', async () => {
    const webhookId = `e2e-${Date.now()}-dup`;
    const body = JSON.stringify({ id: 999006, admin_graphql_api_id: 'gid://shopify/Order/999006', note_attributes: [] });
    const headers = {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': sign(body),
      'X-Shopify-Topic': 'orders/paid',
      'X-Shopify-Webhook-Id': webhookId,
      'X-Shopify-Shop-Domain': STORE_DOMAIN,
    };
    const first = await fetch(baseUrl, { method: 'POST', headers, body });
    const second = await fetch(baseUrl, { method: 'POST', headers, body });
    expect(first.status, await first.text()).toBe(200);
    expect(second.status, await second.text()).toBe(200);

    const count = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM webhook_events WHERE shopify_webhook_id = ${webhookId}`;
    expect(Number(count[0].count)).toBe(1);
    await cleanupEvent(webhookId);
  });

  test('webhook assinado de outra loja é rejeitado antes de processar', async () => {
    const webhookId = `e2e-${Date.now()}-wrong-shop`;
    const body = JSON.stringify({ id: 999009, financial_status: 'paid' });
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: signedHeaders(body, webhookId, { 'X-Shopify-Shop-Domain': 'outra-loja.myshopify.com' }),
      body,
    });
    expect(res.status).toBe(401);
    const count = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM webhook_events WHERE shopify_webhook_id = ${webhookId}`;
    expect(Number(count[0].count)).toBe(0);
  });

  test('domínio da loja ausente é rejeitado mesmo com HMAC válido', async () => {
    const webhookId = `e2e-${Date.now()}-no-shop`;
    const body = JSON.stringify({ id: 999010 });
    const headers = signedHeaders(body, webhookId);
    delete (headers as Partial<typeof headers>)['X-Shopify-Shop-Domain'];
    const res = await fetch(baseUrl, { method: 'POST', headers, body });
    expect(res.status).toBe(400);
  });
});
