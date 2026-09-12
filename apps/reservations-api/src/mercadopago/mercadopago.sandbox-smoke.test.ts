import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MercadoPagoClient } from './mercadopago.client';

// Este arquivo deliberadamente NUNCA instancia PrismaService (é o único
// teste desta pasta que não precisa de banco) — por isso não pode
// contar com o efeito colateral de dotenv do Prisma Client pra carregar
// `.env`. Carrega manualmente aqui, sem depender do pacote `dotenv`
// (não é dependência direta deste projeto).
const envPath = join(__dirname, '..', '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

/**
 * Smoke test REAL contra o sandbox do Mercado Pago — usa
 * MERCADOPAGO_TEST_ACCESS_TOKEN de verdade (nunca produção, ver
 * mercadopago.config.ts — falha se o valor não começar com "TEST-").
 * Só cria PREFERÊNCIAS (nenhum pagamento é efetivado; isso exigiria
 * completar o checkout manualmente com cartão de teste, o que este
 * teste automatizado nunca faz).
 *
 * BRL é a moeda DEFINITIVA do checkout — contexto comercial confirmado:
 * cliente brasileiro paga em BRL pelo site; a retirada presencial da
 * peça acontece numa loja no Chile, mas isso é só logística de entrega,
 * nunca a moeda do pagamento. A conta de teste fornecida (Mercado Pago
 * Brasil) já é compatível — confirmado ao vivo abaixo.
 */
const hasCredentials = !!process.env.MERCADOPAGO_TEST_ACCESS_TOKEN;
const client = new MercadoPagoClient();

describe.skipIf(!hasCredentials)('MercadoPagoClient — smoke real contra o sandbox', () => {
  test('cria uma preferência real em BRL (moeda definitiva do checkout)', async () => {
    const result = await client.createPreference({
      items: [{ title: 'Smoke test VS by Closet (sandbox)', quantity: 1, unitPrice: 1, currencyId: 'BRL' }],
      externalReference: `smoke-brl-${Date.now()}`,
    });
    expect(result.preferenceId).toBeTruthy();
    expect(result.checkoutUrl).toContain('mercadopago');
  }, 15_000);

  test('consultar um pagamento inexistente retorna null, nunca lança', async () => {
    const payment = await client.getPayment('999999999999999');
    expect(payment).toBeNull();
  }, 15_000);
});

describe.skipIf(hasCredentials)('MercadoPagoClient — smoke real (pulado)', () => {
  test('MERCADOPAGO_TEST_ACCESS_TOKEN não configurado neste ambiente — smoke real pulado', () => {
    expect(true).toBe(true);
  });
});
