// Núcleo do E2E de compras do Valle Pass: sobe a API COMPILADA (dist) em PostgreSQL local, com Shopify Admin e Resend FALSAS (fake-net.cjs),
// e conversa com ela só por HTTP (webhook assinado + rotas do ClosetAdmin). Nada de rede real; nada de serviço chamado direto.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-compras-'));

export const API_DIR = process.env.E2E_API_DIR ?? path.resolve(HERE, '../..').replaceAll('\\', '/'); // apps/reservations-api (precisa de `pnpm run build`)
const requireApi = createRequire(`${API_DIR}/package.json`);
const { PrismaClient } = requireApi('@prisma/client');
const { generateSessionToken, hashSessionToken } = requireApi('./dist/src/admin/admin-session-token.js');

export const SHOP = 'e2e-test.myshopify.com';
export const SECRET = 'e2e-webhook-secret-' + crypto.randomBytes(8).toString('hex');
export const ADMIN_TOKEN = crypto.randomBytes(32).toString('hex');
export const DB_URL = process.env.E2E_DATABASE_URL ?? '';
// Só roda contra um PostgreSQL LOCAL descartável de teste (o banco é TRUNCADO no início de cada rodada).
if (!/^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/?]*(test|audit|e2e)/i.test(DB_URL)) throw new Error('Defina E2E_DATABASE_URL apontando para um banco LOCAL de teste (nome com "test", "audit" ou "e2e").');
export const STATE_FILE = path.join(TMP, 'fake-state.json').replaceAll('\\', '/');
export const LOG_FILE = path.join(TMP, 'fake-log.jsonl').replaceAll('\\', '/');

export const db = new PrismaClient({ datasourceUrl: DB_URL, log: [] });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const results = [];
export function check(id, description, ok, detail = '') {
  results.push({ id, description, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? '  ✔' : '  ✘'} [${id}] ${description}${ok ? '' : `  ← ${String(detail).slice(0, 300)}`}`);
  return !!ok;
}

export function fakeState(patch) {
  const cur = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next));
}
export const fakeLog = () => (fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** Sobe a API compilada. `flags` = chaves do Valle Pass; `port` distinto por instância. */
export async function startApi({ port, flags = {}, extraEnv = {} }) {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    DATABASE_URL: DB_URL,
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    SHOPIFY_CLIENT_SECRET: SECRET,
    SHOPIFY_CLIENT_ID: 'e2e-client-id',
    SHOPIFY_STORE_DOMAIN: SHOP,
    SHOPIFY_STOREFRONT_TOKEN: 'e2e-storefront-token',
    SHOPIFY_STORE_CURRENCY: 'BRL',
    RESERVATION_BINDING_SECRET: 'e2e-binding-secret-' + 'x'.repeat(32),
    CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
    TERMS_VERSION: 'v1',
    PAYMENT_WINDOW_MINUTES: '60',
    RESEND_API_KEY: 're_e2e_fake_key',
    VALE_PASS_EMAIL_DOMAIN_VERIFIED: 'true',
    VALE_PASS_EMAIL_WORKER_INTERVAL_SECONDS: '2',
    VALE_PASS_EMAIL_DAILY_LIMIT: '1000',
    E2E_FAKE_STATE: STATE_FILE,
    E2E_FAKE_LOG: LOG_FILE,
    NODE_OPTIONS: `--require ${path.join(HERE, 'fake-net.cjs').replaceAll('\\', '/')}`,
    ...flags,
    ...extraEnv,
  };
  for (const k of ['AI_AGENT', 'CLAUDECODE']) delete env[k];
  const proc = spawn(process.execPath, ['dist/src/main.js'], { cwd: API_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  proc.stdout.on('data', (d) => (output += d));
  proc.stderr.on('data', (d) => (output += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* ainda subindo */ }
    await sleep(500);
    if (i === 79) throw new Error('API não subiu:\n' + output.slice(-1500));
  }
  return { base, logs: () => output, stop: async () => { proc.kill(); await sleep(500); } };
}

/** Usuários do painel (papel + sessão) criados direto no banco local, como os testes de navegador fazem. */
export async function makeUser(role, name, { storeLinked = false } = {}) {
  const user = await db.adminUser.create({ data: { name, phone: `${Date.now()}${Math.floor(Math.random() * 1e6)}`, pinHash: 'synthetic', role, moduleAccess: ['VALLE_PASS'] } });
  const token = generateSessionToken();
  await db.adminSession.create({ data: { adminUserId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 6 * 3_600_000) } });
  return { id: user.id, name, role, token };
}

export function adminClient(api, user) {
  return async (method, path, body) => {
    const withUser = method === 'GET' ? `${path}${path.includes('?') ? '&' : '?'}adminUserId=${user.id}` : path;
    const res = await fetch(api.base + withUser, {
      method,
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'X-Admin-Session': user.token, 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({ ...(body ?? {}) }),
    });
    let json = null;
    try { json = await res.json(); } catch { /* sem corpo */ }
    return { status: res.status, body: json };
  };
}

let orderSeq = 0;
export const money = (amount) => ({ shop_money: { amount, currency_code: 'BRL' }, presentment_money: { amount, currency_code: 'BRL' } });
/** Pedido pago de Valle Pass como a Shopify entrega (valores do preço oficial: R$ 350 por unidade). */
export function orderPayload({ variant, quantity = 1, status = 'paid', email, orderId, paidAt = new Date(), over = {} }) {
  const id = orderId ?? String(7_000_000_000_000 + Date.now() % 1e9 * 10 + (orderSeq++ % 10));
  const total = ((35_000 * quantity) / 100).toFixed(2);
  return {
    id, admin_graphql_api_id: `gid://shopify/Order/${id}`, name: `#E2E${orderSeq}`, financial_status: status, cancelled_at: null, currency: 'BRL', presentment_currency: 'BRL',
    created_at: new Date(paidAt.getTime() - 60_000).toISOString(), updated_at: paidAt.toISOString(),
    current_total_price: total, total_outstanding: status === 'paid' ? '0.00' : total, total_discounts: '0.00', discount_codes: [], refunds: [],
    total_shipping_price_set: money('0.00'), email: email ?? `cliente.${id}@exemplo.invalid`, customer: { first_name: 'Maria', last_name: 'Teste E2E', email: email ?? `cliente.${id}@exemplo.invalid` },
    line_items: [{ variant_id: Number(variant), product_id: null, quantity, current_quantity: quantity, price: '350.00', price_set: money('350.00'), discount_allocations: [] }],
    ...over,
  };
}
/** A transação financeira que a Shopify Admin (falsa) devolve para esse pedido. */
export function setPaid(order, { test = false, processedAt, total } = {}) {
  fakeState((s) => ({ ...s, orders: { ...(s.orders ?? {}), [order.admin_graphql_api_id]: { total: total ?? order.current_total_price, currency: 'BRL', transactions: [{ id: `gid://shopify/OrderTransaction/${order.id}`, kind: 'SALE', status: 'SUCCESS', test, gateway: 'shopify_payments', processedAt: processedAt ?? order.updated_at, amountSet: { shopMoney: { amount: total ?? order.current_total_price, currencyCode: 'BRL' } } }] } } }));
}

export async function webhook(api, topic, body, { webhookId = crypto.randomUUID(), triggeredAt, secret = SECRET, shop = SHOP } = {}) {
  const raw = JSON.stringify(body);
  const hmac = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  const res = await fetch(`${api.base}/webhooks/shopify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-hmac-sha256': hmac, 'x-shopify-topic': topic, 'x-shopify-webhook-id': webhookId, 'x-shopify-shop-domain': shop, ...(triggeredAt === null ? {} : { 'x-shopify-triggered-at': triggeredAt ?? body.updated_at ?? new Date().toISOString() }) },
    body: raw,
  });
  return res.status;
}

export async function newCampaign({ name, variant, validFrom, validUntil, globalLimit = 1000 }) {
  const campaign = await db.valePassCampaign.create({ data: { name, amountCents: 35_000, validityDays: 30, shopifyVariantId: String(variant), globalLimit, voucherValidFrom: new Date(`${validFrom}T00:00:00.000Z`), voucherValidUntil: new Date(`${validUntil}T00:00:00.000Z`) } });
  await db.valePassCampaignBenefit.createMany({
    data: [
      { campaignId: campaign.id, code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 },
      { campaignId: campaign.id, code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 },
      { campaignId: campaign.id, code: 'passeios_10', kind: 'DISCOUNT', label: '10% em passeios e transfers Valle Experience', discountPercent: 10, sortOrder: 2 },
    ],
  });
  return campaign;
}
export const vouchersOfOrder = (orderId) => db.valePass.findMany({ where: { shopifyOrderId: String(orderId) }, orderBy: { company: 'asc' } });
export async function waitFor(fn, { timeout = 20_000, step = 500 } = {}) {
  const end = Date.now() + timeout;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); }
}

/** Começa cada rodada com o banco de TESTE limpo dos dados do Valle Pass (nada de pedidos retidos de rodadas anteriores). */
export async function resetDb() {
  const rows = await db.$queryRawUnsafe(`select table_name from information_schema.tables where table_schema='public' and (table_name like 'vale_pass%' or table_name in ('webhook_events','admin_audit_events','admin_sessions','admin_users'))`);
  const names = rows.map((r) => `public."${r.table_name}"`);
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRawUnsafe(`TRUNCATE ${names.join(', ')} RESTART IDENTITY CASCADE`);
  }, { timeout: 60_000 });
  return names.length;
}
