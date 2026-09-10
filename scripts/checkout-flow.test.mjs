import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const activeFiles = (path) => readdirSync(new URL(path, root), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => readFileSync(`${entry.parentPath}/${entry.name}`, 'utf8'));
const require = createRequire(new URL('apps/marketing/package.json', root));
const ts = require('typescript');

// Exercise the actual framework-independent client module without adding a runner.
function load(path, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  runInNewContext(code, { exports, crypto: { randomUUID }, ...globals }, { filename: path });
  return exports;
}
const input = { items: [{ shopifyVariantId: '123', quantity: 1 }], pickupDate: '2030-10-15', termsAccepted: true };
const held = { ok: true, reservationId: 'reservation-fixture', holdToken: 'credential-fixture' };
const ready = { ok: true, checkoutUrl: 'https://example.test/checkout' };

function fixture(overrides = {}) {
  const calls = [];
  const deps = {
    async createHold(value) { calls.push(['hold', value]); return held; },
    async createCheckout(...args) { calls.push(['checkout', ...args]); return ready; },
    storeLastReservation(...args) { calls.push(['store', ...args]); },
    ...overrides,
  };
  const { createCheckoutAttempt } = load('apps/marketing/src/lib/checkout-attempt.ts', { require: () => deps });
  return { flow: createCheckoutAttempt(), calls, before: async () => { calls.push(['stock']); } };
}

test('stock -> HOLD -> store credential -> checkout, never checkout first', async () => {
  const { flow, calls, before } = fixture();
  assert.equal((await flow.run(input, before)).ok, true);
  assert.deepEqual(calls.map(([kind]) => kind), ['stock', 'hold', 'store', 'checkout']);
  assert.deepEqual(calls[3], ['checkout', held.reservationId, held.holdToken]);
});
test('checkout retry keeps the credential and skips stock occupied by its own HOLD', async () => {
  let attempts = 0;
  const { flow, calls, before } = fixture({ async createCheckout(id, token) {
    assert.equal(id, held.reservationId);
    assert.equal(token, held.holdToken);
    return ++attempts === 1 ? { ok: false, message: 'temporary' } : ready;
  } });
  assert.equal((await flow.run(input, before)).ok, false);
  assert.equal((await flow.run(input, before)).ok, true);
  assert.deepEqual(calls.map(([kind]) => kind), ['stock', 'hold', 'store']);
});
test('HOLD failure never opens checkout and preserves the idempotency key', async () => {
  const keys = [];
  const { flow, calls, before } = fixture({ async createHold(value) {
    keys.push(value.idempotencyKey);
    return { ok: false, reason: 'error', message: 'unavailable' };
  } });
  await flow.run(input, before);
  await flow.run(input, before);
  assert.equal(keys[0], keys[1]);
  assert.equal(calls.some(([kind]) => kind === 'checkout'), false);
});
test('Sunday choice must be resolved before a HOLD can open checkout', async () => {
  const keys = [];
  const { flow, calls, before } = fixture({ async createHold(value) {
    keys.push(value.idempotencyKey);
    return value.sundayReturnOption ? held : { ok: false, reason: 'needs_sunday_choice', returnOptions: [] };
  } });
  assert.equal((await flow.run(input, before)).reason, 'needs_sunday_choice');
  assert.equal(calls.some(([kind]) => kind === 'checkout'), false);
  assert.equal((await flow.run({ ...input, sundayReturnOption: 'saturday' }, before)).ok, true);
  assert.notEqual(keys[0], keys[1]);
});
test('quantity, pickup or Sunday option changes cannot reuse the previous HOLD', async () => {
  const { flow, calls, before } = fixture();
  await flow.run(input, before);
  await flow.run({ ...input, items: [{ shopifyVariantId: '123', quantity: 2 }] }, before);
  await flow.run({ ...input, pickupDate: '2030-10-16' }, before);
  await flow.run({ ...input, sundayReturnOption: 'mondayMorning' }, before);
  assert.equal(new Set(calls.filter(([kind]) => kind === 'hold').map(([, value]) => value.idempotencyKey)).size, 4);
});
test('parallel clicks cannot create parallel checkout attempts', async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const { flow, calls } = fixture();
  const first = flow.run(input, () => wait);
  assert.equal((await flow.run(input, async () => {})).ok, false);
  release();
  assert.equal((await first).ok, true);
  assert.equal(calls.filter(([kind]) => kind === 'hold').length, 1);
});
test('reset while checkout is in flight discards the late redirect', async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const { flow, before } = fixture({ async createCheckout() { flow.reset(); await wait; return ready; } });
  const pending = flow.run(input, before);
  release();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal('checkoutUrl' in result, false);
});
test('only authoritative expiration releases the cached HOLD for a new attempt', async () => {
  const { flow, calls, before } = fixture({ async createCheckout() { return { ok: false, expired: true, message: 'expired' }; } });
  await flow.run(input, before);
  await flow.run(input, before);
  const keys = calls.filter(([kind]) => kind === 'hold').map(([, value]) => value.idempotencyKey);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});
test('stock failure and unaccepted terms fail closed', async () => {
  const { flow, calls, before } = fixture();
  assert.equal((await flow.run({ ...input, termsAccepted: false }, before)).ok, false);
  assert.equal((await flow.run(input, async () => { throw new Error('stock failure'); })).ok, false);
  assert.equal(calls.length, 0);
  assert.equal((await flow.run(input, before)).ok, true);
});
test('HTTP 410 is distinguished from transient checkout failures', async () => {
  const { createCheckout } = load('apps/marketing/src/lib/checkout.ts', {
    process: { env: { NEXT_PUBLIC_CHECKOUT_URL: 'https://api.example.test/checkout' } },
    fetch: async () => ({ ok: false, status: 410, json: async () => ({ message: 'expired' }) }),
  });
  assert.equal((await createCheckout('id', 'token')).expired, true);
});
test('legacy calendar cannot fetch, invent availability or mutate Shopify carts', () => {
  const buttons = [{ disabled: false }];
  const panels = [{ hidden: false }];
  const status = {};
  const root = {
    dataset: { retiredMessage: 'Retired' },
    querySelectorAll: (selector) => selector === 'button' ? buttons : panels,
    querySelector: () => status,
  };
  const handlers = {};
  const document = { readyState: 'complete', querySelectorAll: () => [root], addEventListener: (event, handler) => { handlers[event] = handler; } };
  runInNewContext(read('apps/shopify-app/extensions/rental-calendar/assets/rental-calendar.js'), {
    document, fetch: () => { assert.fail('Legacy calendar must not access the network'); },
  });
  assert.equal(buttons[0].disabled, true);
  assert.equal(panels[0].hidden, true);
  assert.equal(status.textContent, 'Retired');
  buttons[0].disabled = false;
  handlers['shopify:section:load']({ target: document });
  assert.equal(buttons[0].disabled, true);
});
test('shopping cart never exposes checkoutUrl; only the HOLD checkout client does', () => {
  assert.doesNotMatch(read('apps/marketing/src/lib/cart.ts'), /checkoutUrl/);
});
test('Railway uses the package start command and preserves migrations and health', () => {
  const railway = JSON.parse(read('apps/reservations-api/railway.json'));
  const pkg = JSON.parse(read('apps/reservations-api/package.json'));
  assert.equal(railway.deploy.startCommand, 'pnpm --filter @valle/reservations-api run start');
  assert.equal(pkg.scripts.start, 'node dist/src/main.js');
  assert.equal(railway.deploy.healthcheckPath, '/health');
  assert.deepEqual(railway.deploy.preDeployCommand, ['pnpm --filter @valle/reservations-api run db:migrate']);
});
test('Shopify production config audits order creation before payment', () => {
  const config = read('apps/shopify-app/shopify.app.production.toml');
  assert.match(config, /topics\s*=\s*\[\s*"orders\/create",\s*"orders\/paid",\s*"orders\/cancelled",\s*"refunds\/create"\s*\]/);
});
test('active application code has no direct Mercado Pago integration', () => {
  const source = [
    ...activeFiles('apps/marketing/src'),
    ...activeFiles('apps/reservations-api/src'),
    ...activeFiles('apps/shopify-app/app'),
  ].join('\n');
  assert.doesNotMatch(source, /mercado\s*pago|mercadopago|preference_id|notification_url|mp_access_token|mp_public_key/i);
});
test('reservation confirmation never mutates Shopify inventory or captures/refunds payment', () => {
  const webhook = read('apps/reservations-api/src/webhooks/webhooks.service.ts');
  assert.match(webhook, /case 'orders\/paid'/);
  assert.doesNotMatch(webhook, /mutation\s+\w*(?:inventory|refund|paymentCapture|orderEdit)/i);
});
