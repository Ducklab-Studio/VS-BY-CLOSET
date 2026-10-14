import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Janela de pagamento: um prazo só, em todos os lugares, e nunca renovado.
const here = path.dirname(fileURLToPath(import.meta.url));
const api = path.resolve(here, '../../reservations-api');
const read = (file) => readFileSync(path.join(file), 'utf8').replace(/\r\n/g, '\n');
/** Só o código: comentários podem (e devem) citar o SQL para explicar. */
const code = (file) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const apiSrc = path.join(api, 'src');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const productionFiles = walk(apiSrc).filter((f) => f.endsWith('.ts') && !/\.test\.ts$/.test(f));

test('o padrão da API é 60 min e o texto mostrado à cliente diz o mesmo número', () => {
  const config = read(path.join(apiSrc, 'checkout/checkout.config.ts'));
  const apiDefault = Number(/const DEFAULT_PAYMENT_WINDOW_MINUTES = (\d+);/.exec(config)?.[1]);
  assert.equal(apiDefault, 60);
  const label = Number(/PAYMENT_WINDOW_MINUTES_LABEL = (\d+);/.exec(read(path.join(here, '../src/lib/payment-window.ts')))?.[1]);
  assert.equal(label, apiDefault, 'o texto do carrinho precisa dizer o mesmo prazo do padrão da API');
  const cart = read(path.join(here, '../src/app/carrinho/page.tsx'));
  assert.match(cart, /Reserva garantida por \{PAYMENT_WINDOW_MINUTES_LABEL\} minutos/);
  assert.doesNotMatch(cart, /garantida por 30 minutos/);
});

test('.env.example documenta 60 min, a origem da contagem e que a variável do Railway sobrescreve o padrão', () => {
  const env = read(path.join(api, '.env.example'));
  assert.match(env, /^PAYMENT_WINDOW_MINUTES=60$/m);
  assert.match(env, /CRIAÇÃO DO CHECKOUT/);
  assert.match(env, /nunca renovada/);
  assert.match(env, /Railway/);
  assert.match(env, /Pix\/Mercado Pago/);
});

test('o HOLD (30 min) é uma fase separada, definida em uma constante e usada pelo SQL do HOLD', () => {
  const config = read(path.join(apiSrc, 'checkout/checkout.config.ts'));
  assert.match(config, /export const HOLD_WINDOW_MINUTES = 30;/);
  const holds = read(path.join(apiSrc, 'holds/holds.service.ts'));
  assert.match(holds, /now\(\) \+ \$\{HOLD_WINDOW_MINUTES\} \* interval '1 minute'/);
  assert.doesNotMatch(holds, /interval '30 minutes'/);
});

test('o prazo NUNCA é renovado: só o CheckoutService grava payment_expires_at (webhook, agendador e painel só leem)', () => {
  const writers = productionFiles.filter((f) => /payment_expires_at\s*=\s*(?!=)/.test(code(f).replace(/<=|>=|!=/g, '')));
  assert.deepEqual(writers.map((f) => path.relative(apiSrc, f).replace(/\\/g, '/')), ['checkout/checkout.service.ts']);
  const checkout = read(path.join(apiSrc, 'checkout/checkout.service.ts'));
  // gravado uma vez, na transição hold → pending_payment
  assert.equal((checkout.match(/payment_expires_at = now\(\)/g) ?? []).length, 1);
  assert.match(checkout, /WHERE id = \$\{reservation\.id\}::uuid AND status = 'hold'/);
  const prismaWriters = productionFiles.filter((f) => /paymentExpiresAt\s*:/.test(code(f)) && /data\s*:/.test(code(f)) && !/checkout\.service/.test(f));
  assert.deepEqual(prismaWriters, []);
});

test('a expiração usa o prazo GRAVADO, só em hold/pending_payment, e não conhece a Shopify', () => {
  const sweep = read(path.join(apiSrc, 'reservation-expiry/reservation-expiry.ts'));
  assert.match(sweep, /status = 'hold' AND expires_at <= now\(\)/);
  assert.match(sweep, /status = 'pending_payment' AND payment_expires_at <= now\(\)/);
  assert.match(sweep, /FOR UPDATE SKIP LOCKED/);
  assert.doesNotMatch(code(path.join(apiSrc, 'reservation-expiry/reservation-expiry.ts')), /'confirmed'|shopify|fetch\(/i); // nunca menciona reserva paga nem Shopify
  for (const f of ['reservation-expiry.ts', 'reservation-expiry-scheduler.service.ts', 'reservation-expiry.module.ts']) {
    assert.doesNotMatch(read(path.join(apiSrc, 'reservation-expiry', f)), /ShopifyAdminClient|shopify-admin\.client|https?:\/\//i, f);
  }
});

test('a auditoria de produção é estritamente somente leitura e sem dados pessoais', () => {
  const sql = read(path.join(api, 'scripts/audit-payment-expiry.readonly.sql'));
  const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  assert.match(code.trim(), /^BEGIN READ ONLY;/);
  assert.match(code.trim(), /ROLLBACK;$/);
  assert.doesNotMatch(code, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|VACUUM|SET\s+(?!READ)|COMMIT|CALL|DO)\b/i);
  assert.doesNotMatch(code, /customer_name|customer_email|customer_phone|internal_note|payload/i);
});
