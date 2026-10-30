// Sonda de PRIVACIDADE: com uma compra de cliente "sentinela" (e-mail, telefone e sobrenome inconfundíveis), percorre TODAS as rotas de leitura do Valle Pass
// como STAFF e como ADMIN e procura os dados completos do cliente no corpo de cada resposta. STAFF não pode ver nenhum; ADMIN continua vendo o que precisa.
import fs from 'node:fs';
import * as L from './lib.mjs';
const { db, check } = L;

const RUN = Date.now();
const EMAIL = `sentinela.${RUN}@dominio-sentinela.invalid`;
const PHONE_DIGITS = '5511987654321';
const PHONE = '+55 11 98765-4321';
const LAST = 'Sentinela';
const sentinels = [EMAIL, EMAIL.split('@')[0], PHONE_DIGITS, '98765-4321', '987654321', LAST];
const leaks = (value) => sentinels.filter((s) => JSON.stringify(value ?? '').includes(s));

fs.rmSync(L.LOG_FILE, { force: true });
fs.writeFileSync(L.STATE_FILE, '{}');
await L.resetDb();
const api = await L.startApi({ port: 3421, flags: { VALE_PASS_TWO_VOUCHER_FLOW: 'on', VALE_PASS_EMAIL_MODE: 'live', VALE_PASS_EMAIL_WORKER_INTERVAL_SECONDS: '10' } });
try {
  const admin = await L.makeUser('ADMIN', 'Admin Sonda');
  const owner = await L.makeUser('SUPER_ADMIN', 'Proprietário Sonda');
  const staff = await L.makeUser('STAFF', 'Funcionário Sonda');
  const A = L.adminClient(api, admin);
  const S = L.adminClient(api, staff);
  const O = L.adminClient(api, owner);
  const variant = 900_000_000_000 + Math.floor(Math.random() * 9e10);
  const campaign = await L.newCampaign({ name: `Sonda ${RUN}`, variant, validFrom: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) });
  const customer = { first_name: 'Maria', last_name: LAST, email: EMAIL, phone: PHONE };
  const over = { phone: PHONE, customer, contact_email: EMAIL, shipping_address: { first_name: 'Maria', last_name: LAST, phone: PHONE }, billing_address: { first_name: 'Maria', last_name: LAST, phone: PHONE, name: `Maria ${LAST}` } };

  // 1) uma compra emitida (com e-mail na fila) e 2) uma retida (horário não comprovado) — ambas com os dados do cliente sentinela
  const paid = L.orderPayload({ variant, email: EMAIL, over });
  await L.webhook(api, 'orders/paid', paid);
  L.setPaid(paid);
  await A('POST', '/admin/vale-pass/flow/payment-time/verify', { orderId: String(paid.id), note: 'conferido na Shopify (sonda)' });
  await A('POST', '/admin/vale-pass/flow/resume', { limit: 25, note: 'retomar retenções da sonda' });
  const held = L.orderPayload({ variant, email: EMAIL, over });
  await L.webhook(api, 'orders/paid', held);
  const vs = await L.vouchersOfOrder(paid.id);
  const show = vs.find((v) => v.company === 'VALLE_SHOWROOM');
  check('P0', 'preparo: compra emitida (2 vouchers) e outra retida, ambas com os dados do cliente sentinela', vs.length === 2 && !!show);
  await L.waitFor(() => L.fakeLog().find((x) => x.type === 'resend.send'), { timeout: 40_000 });
  const outbox = await db.valePassEmailOutbox.findFirst({ where: { shopifyOrderId: String(paid.id) } });
  const hold = await db.valePassIssuanceHold.findFirst({ where: { shopifyOrderId: String(held.id) } });

  const routes = [
    ['GET', '/admin/vale-pass/vouchers'],
    ['GET', `/admin/vale-pass/vouchers?search=${encodeURIComponent(EMAIL)}`],
    ['GET', `/admin/vale-pass/vouchers?search=${PHONE_DIGITS}`],
    ['GET', `/admin/vale-pass/vouchers?search=${LAST}`],
    ['GET', `/admin/vale-pass/vouchers/${show.code}`],
    ['GET', `/admin/vale-pass/vouchers/${show.code}/balance`],
    ['GET', `/admin/vale-pass/vouchers/${show.code}/ledger`],
    ['POST', `/admin/vale-pass/vouchers/${show.code}/redeem/prepare`, { company: 'VALLE_SHOWROOM', amountCents: 1000, reference: 'sonda' }],
    ['GET', '/admin/vale-pass/ledger/reconcile'],
    ['GET', '/admin/vale-pass/orders'],
    ['GET', '/admin/vale-pass/orders/attention'],
    ['GET', '/admin/vale-pass/holds'],
    ...(hold ? [['GET', `/admin/vale-pass/holds/${hold.id}/preview`]] : []),
    ['GET', '/admin/vale-pass/emails/summary'],
    ['GET', '/admin/vale-pass/emails'],
    ...(outbox ? [['GET', `/admin/vale-pass/emails/${outbox.id}/events`]] : []),
    ['GET', '/admin/vale-pass/flow'],
    ['GET', '/admin/vale-pass/flow/alerts'],
    ['GET', '/admin/vale-pass/refund-reviews'],
    ['GET', '/admin/vale-pass/cancellation-alerts'],
    ['GET', '/admin/vale-pass/campaigns'],
    ['GET', `/admin/vale-pass/campaigns/${campaign.id}/benefits`],
    ['GET', `/admin/vale-pass/campaigns/${campaign.id}/capacity`],
    ['GET', '/admin/vale-pass/launch-readiness'],
    ['GET', '/admin/vale-pass/operators'],
  ];
  let adminSees = 0;
  for (const [method, path, body] of routes) {
    const rs = await S(method, path, body);
    const ra = await A(method, path, body);
    const leaked = rs.status === 200 || rs.status === 201 ? leaks(rs.body) : [];
    const adminLeaks = ra.status === 200 || ra.status === 201 ? leaks(ra.body) : [];
    if (adminLeaks.length) adminSees += 1;
    check(`STAFF ${method} ${path.replace(show.code, '<code>').replace(campaign.id, '<campanha>').slice(0, 78)}`, `STAFF (HTTP ${rs.status}) não recebe dados completos do cliente`, leaked.length === 0, `VAZOU: ${leaked.join(' | ')}`);
  }
  check('ADMIN', 'ADMIN continua vendo os dados completos nas telas operacionais (lista/consulta de vouchers)', adminSees >= 2, `rotas com dados completos para ADMIN: ${adminSees}`);
  const ownerList = await O('GET', '/admin/vale-pass/vouchers');
  check('OWNER', 'SUPER_ADMIN (proprietário) vê os dados completos', leaks(ownerList.body).includes(EMAIL), ownerList.status);
} catch (err) {
  check('ERRO', 'execução da sonda', false, err?.stack ?? err);
} finally {
  await api.stop();
  await db.$disconnect();
  const bad = L.results.filter((r) => !r.ok);
  console.log(`\nSONDA: ${L.results.length - bad.length} aprovadas, ${bad.length} falhas de ${L.results.length}`);
  for (const b of bad) console.log(`  ✘ [${b.id}] ${b.detail}`);
  process.exitCode = bad.length ? 1 : 0;
}
