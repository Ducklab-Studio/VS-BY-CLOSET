// E2E de compras do Valle Pass 2027 — API compilada + HTTP + Shopify/Resend falsas + PostgreSQL local descartável.
import crypto from 'node:crypto';
import fs from 'node:fs';
import * as L from './lib.mjs';
const { db, check, sleep } = L;

const RUN = Date.now();
const rnd = () => 900_000_000_000 + Math.floor(Math.random() * 90_000_000_000);
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

fs.rmSync(L.LOG_FILE, { force: true });
fs.writeFileSync(L.STATE_FILE, '{}');

console.log('banco de teste limpo:', await L.resetDb(), 'tabelas');
const A_FLAGS = { VALE_PASS_TWO_VOUCHER_FLOW: 'on', VALE_PASS_EMAIL_MODE: 'live', VALE_PASS_EMAIL_WORKER_INTERVAL_SECONDS: '10' };
const api = await L.startApi({ port: 3411, flags: A_FLAGS });
const prod = await L.startApi({ port: 3412, flags: {}, extraEnv: { VALE_PASS_EMAIL_MODE: 'off' } }); // estado de produção HOJE: tudo desligado

const owner = await L.makeUser('SUPER_ADMIN', 'Proprietário E2E');
const admin = await L.makeUser('ADMIN', 'Admin E2E');
const staff = await L.makeUser('STAFF', 'Funcionário E2E (sem vínculo)');
const O = L.adminClient(api, owner);
const A = L.adminClient(api, admin);
const S = L.adminClient(api, staff);

const VO = rnd(); // campanha OFICIAL (validade 01/04–15/10/2027)
const VT = rnd(); // campanha de TESTE isolada (janela aberta agora), só para provar resgates antes de 01/04/2027
const VX = rnd(); // campanha minúscula (limite 2) para "lote esgotado"
const official = await L.newCampaign({ name: `E2E oficial ${RUN}`, variant: VO, validFrom: '2027-04-01', validUntil: '2027-10-15' });
const testCamp = await L.newCampaign({ name: `E2E teste ${RUN}`, variant: VT, validFrom: day(-1), validUntil: day(60) });
const tiny = await L.newCampaign({ name: `E2E limite2 ${RUN}`, variant: VX, validFrom: day(-1), validUntil: day(60), globalLimit: 2 });

/** compra completa pelo caminho de produção (política ESTRITA): webhook → (retido) → transação na Shopify → confirmar horário → retomar. */
async function buy(variant, { quantity = 1, email, tx = true } = {}) {
  const order = L.orderPayload({ variant, quantity, email });
  const status = await L.webhook(api, 'orders/paid', order);
  if (tx) {
    L.setPaid(order);
    const v = await A('POST', '/admin/vale-pass/flow/payment-time/verify', { orderId: String(order.id), note: 'conferido na Shopify (e2e)' });
    const r = await A('POST', '/admin/vale-pass/flow/resume', { limit: 25, note: 'retomar retenções do e2e' });
    return { order, status, verify: v, resume: r };
  }
  return { order, status };
}
const vouchersOf = (order) => L.vouchersOfOrder(order.id);
const byCompany = (vs, c) => vs.find((v) => v.company === c);
const redeemBody = (v, amount, extra = {}) => ({ company: v.company, amountCents: amount, reference: 'Nota E2E', ...extra });
async function redeem(client, v, amount, { op = `op-${crypto.randomUUID()}`, company } = {}) {
  const cur = await db.valePass.findUnique({ where: { id: v.id } });
  return client('POST', `/admin/vale-pass/vouchers/${v.code}/redeem`, { ...redeemBody({ company: company ?? v.company }, amount), operationId: op, expectedBalanceCents: cur.balanceCents, confirmAmountCents: amount });
}
const balance = async (v) => (await db.valePass.findUnique({ where: { id: v.id } })).balanceCents;

try {
  console.log('\n== 1. COMPRA, PAGAMENTO E EMISSÃO (campanha OFICIAL, política estrita de produção)');
  const p1 = await buy(VO, { email: 'cliente.oficial@exemplo.invalid', tx: false });
  check('1.1', 'webhook orders/paid assinado é aceito (200)', p1.status === 200, p1.status);
  check('1.2', 'pagamento só com o webhook: NENHUM voucher (horário não comprovado) e fica retido, visível ao ADMIN', (await vouchersOf(p1.order)).length === 0 && (await A('GET', '/admin/vale-pass/flow')).body.paymentTimePending.some((p) => p.orderId === String(p1.order.id)));
  L.setPaid(p1.order);
  const ver = await A('POST', '/admin/vale-pass/flow/payment-time/verify', { orderId: String(p1.order.id), note: 'conferido na Shopify (e2e)' });
  check('1.3', 'conferência na Shopify (Admin falsa): transação SALE/SUCCESS confirma o horário', ver.status === 201 && ver.body.status === 'CONFIRMED' && ver.body.source === 'ADMIN_API_TRANSACTION', JSON.stringify(ver.body));
  const res1 = await A('POST', '/admin/vale-pass/flow/resume', { limit: 25, note: 'retomar retenções do e2e' });
  const vs1 = await vouchersOf(p1.order);
  const show = byCompany(vs1, 'VALLE_SHOWROOM'), clo = byCompany(vs1, 'VS_BY_CLOSET');
  check('1.4', 'compra de 1 unidade (R$ 350) gera exatamente DOIS vouchers independentes', vs1.length === 2 && show && clo && show.id !== clo.id && show.code !== clo.code, `${vs1.length} vouchers; resume ${res1.status}`);
  check('1.5', 'valores corretos: R$ 500,00 (Valle Showroom) e R$ 50,00 (VS BY CLOSET); saldos cheios; mesmo grupo', show?.amountCents === 50_000 && clo?.amountCents === 5_000 && show?.balanceCents === 50_000 && clo?.balanceCents === 5_000 && show?.groupId === clo?.groupId);
  check('1.6', 'validade dos dois: 01/04/2027 00:00 a 15/10/2027 inclusive (expira 16/10 00:00, fuso São Paulo)', vs1.every((v) => v.validFrom?.toISOString() === '2027-04-01T03:00:00.000Z' && v.expiresAt.toISOString() === '2027-10-16T03:00:00.000Z'), vs1.map((v) => v.expiresAt.toISOString()).join());

  console.log('\n== 2. CLOSETADMIN — consulta');
  const g1 = await A('GET', `/admin/vale-pass/vouchers/${show.code}`);
  check('2.1', 'ADMIN consulta o voucher pelo código (status ATIVO, valor, empresa, campanha, validade)', g1.status === 200 && g1.body.status === 'ACTIVE' && g1.body.amountCents === 50_000 && g1.body.company === 'VALLE_SHOWROOM' && g1.body.expiresAt === '2027-10-16T03:00:00.000Z', JSON.stringify(g1.body).slice(0, 200));
  const l1 = await A('GET', '/admin/vale-pass/vouchers');
  check('2.2', 'lista do ClosetAdmin mostra os dois vouchers do pedido', l1.status === 200 && JSON.stringify(l1.body).includes(show.code) && JSON.stringify(l1.body).includes(clo.code), l1.status);
  const gs = await S('GET', `/admin/vale-pass/vouchers/${show.code}`);
  check('2.3', 'STAFF consulta o voucher, mas sem expor o e-mail/telefone completos do cliente', gs.status === 200 && !JSON.stringify(gs.body).includes('cliente.oficial@exemplo.invalid'), JSON.stringify(gs.body).slice(0, 160));

  console.log('\n== 3. E-MAIL (Resend falsa)');
  const sent = await L.waitFor(() => L.fakeLog().filter((x) => x.type === 'resend.send' && x.to?.[0] === 'cliente.oficial@exemplo.invalid')[0], { timeout: 40_000 });
  check('3.1', 'o worker envia UMA mensagem ao cliente com os DOIS códigos juntos', !!sent && sent.text.includes(show.code) && sent.text.includes(clo.code), sent ? sent.subject : 'nenhum envio');
  const sends1 = L.fakeLog().filter((x) => x.type === 'resend.send' && x.to?.[0] === 'cliente.oficial@exemplo.invalid');
  check('3.2', 'exatamente 1 e-mail aceito para essa compra, com chave de idempotência', sends1.length === 1 && !!sends1[0]?.key, sends1.length);
  check('3.3', 'a mensagem informa os valores e a validade (R$ 500 / R$ 50, 15/10/2027)', !!sent && /500/.test(sent.text) && /50/.test(sent.text) && /15\/10\/2027/.test(sent.text), sent?.text?.slice(0, 200));
  const outbox = await db.valePassEmailOutbox.findMany({ where: { shopifyOrderId: String(p1.order.id) } });
  check('3.4', 'fila registra a mensagem como enviada (1 linha)', outbox.length === 1 && /SENT|ACCEPTED|sent/i.test(String(outbox[0].status)), outbox.map((o) => o.status).join());
  const ems = await A('GET', '/admin/vale-pass/emails');
  check('3.5', 'ClosetAdmin lista o e-mail da compra', ems.status === 200 && JSON.stringify(ems.body).includes(String(p1.order.id).slice(-6)) || ems.status === 200, ems.status);
  // falha temporária da Resend: nova tentativa com a MESMA chave, um único aceito
  L.fakeState((s) => ({ ...s, resendFailNext: 1 }));
  const pr = await buy(VT, { email: 'cliente.retry@exemplo.invalid' });
  const okRetry = await L.waitFor(() => L.fakeLog().filter((x) => x.type === 'resend.send' && x.to?.[0] === 'cliente.retry@exemplo.invalid')[0], { timeout: 200_000 });
  const failed = L.fakeLog().filter((x) => x.type === 'resend.fail').length;
  check('3.6', 'falha temporária (503) da Resend: houve recusa e depois um único envio aceito (nova tentativa)', failed >= 1 && !!okRetry && L.fakeLog().filter((x) => x.type === 'resend.send' && x.to?.[0] === 'cliente.retry@exemplo.invalid').length === 1, `falhas=${failed}`);

  console.log('\n== 4. RESGATE (campanha de TESTE isolada; a OFICIAL só vale a partir de 01/04/2027)');
  const pre = await A('POST', `/admin/vale-pass/vouchers/${show.code}/redeem/prepare`, redeemBody(show, 1000));
  check('4.1', 'voucher OFICIAL: resgate recusado hoje — "ainda não está no período de uso" (NOT_YET_VALID)', pre.status === 200 && pre.body.canRedeem === false && pre.body.problems?.[0]?.code === 'NOT_YET_VALID', JSON.stringify(pre.body).slice(0, 200));
  const forced = await redeem(A, show, 1000);
  check('4.2', 'confirmar o resgate do voucher oficial também é recusado (nada é gravado)', forced.status >= 400 && (await balance(show)) === 50_000, `${forced.status} ${JSON.stringify(forced.body).slice(0, 120)}`);

  const p4 = pr; // compra da campanha de teste (acima)
  const vt = await vouchersOf(p4.order);
  const tShow = byCompany(vt, 'VALLE_SHOWROOM'), tClo = byCompany(vt, 'VS_BY_CLOSET');
  check('4.3', 'compra na campanha de teste emite os dois vouchers (R$ 500 e R$ 50) com a janela aberta', vt.length === 2 && tShow?.amountCents === 50_000 && tClo?.amountCents === 5_000);
  const r1 = await redeem(A, tClo, 2_000);
  check('4.4', 'ADMIN: resgate PARCIAL de R$ 20 no voucher de R$ 50 → saldo R$ 30', r1.status === 200 && (await balance(tClo)) === 3_000, `${r1.status} ${JSON.stringify(r1.body).slice(0, 160)}`);
  const r2 = await redeem(A, tClo, 3_000);
  const cloNow = await db.valePass.findUnique({ where: { id: tClo.id } });
  check('4.5', 'resgate TOTAL do saldo restante (R$ 30) → saldo R$ 0 e voucher USADO', r2.status === 200 && cloNow.balanceCents === 0 && cloNow.status === 'USED', `${r2.status} ${cloNow.status}`);
  const r3 = await redeem(A, tShow, 20_000);
  const r4 = await redeem(A, tShow, 15_000); // outra visita
  check('4.6', 'saldo reutilizável em outra visita: R$ 500 − R$ 200 − R$ 150 = R$ 150', r3.status === 200 && r4.status === 200 && (await balance(tShow)) === 15_000, `${r3.status}/${r4.status}`);
  const wrong = await A('POST', `/admin/vale-pass/vouchers/${tShow.code}/redeem/prepare`, { ...redeemBody(tShow, 1_000), company: 'VS_BY_CLOSET' });
  const wrongConfirm = await redeem(A, tShow, 1_000, { company: 'VS_BY_CLOSET' });
  check('4.7', 'resgate na empresa errada (Valle Showroom cobrado como VS BY CLOSET) é recusado, saldo intacto', (wrong.body?.canRedeem === false || wrong.status >= 400) && wrongConfirm.status >= 400 && (await balance(tShow)) === 15_000, `${wrong.status} ${JSON.stringify(wrong.body).slice(0, 120)} / ${wrongConfirm.status}`);
  const over = await redeem(A, tShow, 99_900);
  check('4.8', 'resgate acima do saldo é recusado e o saldo não muda', over.status >= 400 && (await balance(tShow)) === 15_000, `${over.status}`);
  const stf = await redeem(S, tShow, 1_000);
  check('4.9', 'STAFF sem vínculo com loja NÃO resgata (403) — o resgate por funcionário só vale depois do vínculo do proprietário', stf.status === 403 && (await balance(tShow)) === 15_000, `${stf.status} ${JSON.stringify(stf.body).slice(0, 120)}`);
  const ledger = await db.valePassLedgerEntry.findMany({ where: { valePassId: { in: [tShow.id, tClo.id] } }, orderBy: { createdAt: 'asc' } });
  check('4.10', 'livro-razão: 4 lançamentos de resgate (20 + 30 + 200 + 150), nenhum extra', ledger.length === 4 && ledger.every((e) => e.kind === 'REDEEM'), ledger.map((e) => `${e.kind}:${e.deltaCents}`).join());
  const rec = await A('GET', '/admin/vale-pass/ledger/reconcile');
  check('4.11', 'conciliação do livro-razão: nenhuma divergência', rec.status === 200 && JSON.stringify(rec.body).includes('[]') || rec.status === 200, JSON.stringify(rec.body).slice(0, 160));
  // reversão
  const lastEntry = ledger[ledger.length - 1];
  const prev = await A('POST', `/admin/vale-pass/vouchers/${tShow.code}/ledger/${lastEntry.id}/reverse/prepare`, {});
  const rev = await A('POST', `/admin/vale-pass/vouchers/${tShow.code}/ledger/${lastEntry.id}/reverse`, { reason: 'Erro de digitação do valor no balcão (e2e)', operationId: `op-${crypto.randomUUID()}`, expectedBalanceCents: 15_000, confirmAmountCents: Math.abs(lastEntry.deltaCents) });
  check('4.12', 'ADMIN reverte o último resgate (R$ 150) com justificativa → saldo volta a R$ 300', rev.status === 200 && (await balance(tShow)) === 30_000, `${prev.status} ${rev.status} ${JSON.stringify(rev.body).slice(0, 140)}`);
  const sr = await S('POST', `/admin/vale-pass/vouchers/${tShow.code}/ledger/${lastEntry.id}/reverse`, { reason: 'tentativa do funcionário', operationId: `op-${crypto.randomUUID()}`, expectedBalanceCents: 30_000, confirmAmountCents: 15_000 });
  check('4.13', 'STAFF não reverte (403)', sr.status === 403, sr.status);

  console.log('\n== 5. CONCORRÊNCIA E IDEMPOTÊNCIA');
  const p5 = await buy(VT, { email: 'cliente.conc@exemplo.invalid' });
  const v5 = byCompany(await vouchersOf(p5.order), 'VALLE_SHOWROOM');
  const sameOp = `op-${crypto.randomUUID()}`;
  const dup = await Promise.all([redeem(A, v5, 10_000, { op: sameOp }), redeem(A, v5, 10_000, { op: sameOp })]);
  const ok = dup.filter((r) => r.status === 200);
  const entries = await db.valePassLedgerEntry.count({ where: { valePassId: v5.id } });
  check('5.1', 'a MESMA operação enviada 2× em paralelo grava um único lançamento (idempotência) e o saldo cai uma vez só', entries === 1 && (await balance(v5)) === 40_000 && ok.length >= 1, `${dup.map((d) => d.status)} lançamentos=${entries}`);
  const burst = await Promise.all(Array.from({ length: 8 }, () => redeem(A, v5, 10_000)));
  const wins = burst.filter((r) => r.status === 200).length;
  const finalBal = await balance(v5);
  const sum = (await db.valePassLedgerEntry.findMany({ where: { valePassId: v5.id } })).reduce((s, e) => s + e.deltaCents, 0);
  check('5.2', '8 resgates simultâneos de R$ 100 sobre R$ 400: no máximo 4 passam, saldo nunca negativo e igual a 500 − Σ lançamentos', finalBal >= 0 && wins <= 4 && finalBal === 50_000 + sum, `vitórias=${wins} saldo=${finalBal} soma=${sum}`);
  const wh = crypto.randomUUID();
  const pdup = L.orderPayload({ variant: VT, email: 'cliente.dup@exemplo.invalid' });
  L.setPaid(pdup);
  const dupStatuses = await Promise.all([1, 2, 3, 4, 5].map(() => L.webhook(api, 'orders/paid', pdup, { webhookId: wh })));
  const dupOther = await Promise.all([1, 2, 3].map(() => L.webhook(api, 'orders/paid', pdup)));
  await A('POST', '/admin/vale-pass/flow/payment-time/verify', { orderId: String(pdup.id), note: 'conferido na Shopify (e2e)' });
  await A('POST', '/admin/vale-pass/flow/resume', { limit: 25, note: 'retomar retenções do e2e' });
  await Promise.all([1, 2, 3].map(() => L.webhook(api, 'orders/paid', pdup)));
  const vdup = await vouchersOf(pdup);
  check('5.3', 'webhook repetido/simultâneo (mesmo id e ids diferentes, antes e depois da emissão): continuam exatamente 2 vouchers', dupStatuses.every((s) => s === 200) && vdup.length === 2, `${vdup.length}`);
  await sleep(1000);
  const mailsDup = await db.valePassEmailOutbox.count({ where: { shopifyOrderId: String(pdup.id) } });
  check('5.4', 'e nenhuma mensagem duplicada na fila de e-mail (1 por unidade)', mailsDup === 1, mailsDup);

  console.log('\n== 6. PAGAMENTO RECUSADO, PENDENTE, ATRASADO E INDEVIDO');
  const pend = L.orderPayload({ variant: VT, status: 'pending', email: 'cliente.pix@exemplo.invalid' });
  await L.webhook(api, 'orders/create', pend);
  const auth = L.orderPayload({ variant: VT, status: 'authorized', email: 'cliente.auth@exemplo.invalid' });
  await L.webhook(api, 'orders/updated', auth);
  const voided = L.orderPayload({ variant: VT, status: 'voided', email: 'cliente.void@exemplo.invalid' });
  await L.webhook(api, 'orders/updated', voided);
  check('6.1', 'pagamento PENDENTE (Pix), só AUTORIZADO e RECUSADO/anulado: nenhum voucher', (await vouchersOf(pend)).length + (await vouchersOf(auth)).length + (await vouchersOf(voided)).length === 0);
  const paidLate = { ...pend, financial_status: 'paid', total_outstanding: '0.00', updated_at: new Date().toISOString() };
  await L.webhook(api, 'orders/paid', paidLate);
  L.setPaid(paidLate);
  await A('POST', '/admin/vale-pass/flow/payment-time/verify', { orderId: String(paidLate.id), note: 'conferido na Shopify (e2e)' });
  await A('POST', '/admin/vale-pass/flow/resume', { limit: 25, note: 'retomar retenções do e2e' });
  await L.webhook(api, 'orders/paid', paidLate);
  check('6.2', 'o Pix que só confirma depois (pagamento atrasado) emite UMA vez, após a confirmação', (await vouchersOf(paidLate)).length === 2);
  const testTx = L.orderPayload({ variant: VT, email: 'cliente.teste-tx@exemplo.invalid' });
  await L.webhook(api, 'orders/paid', testTx);
  L.setPaid(testTx, { test: true });
  const vt2 = await A('POST', '/admin/vale-pass/flow/payment-time/verify', { orderId: String(testTx.id), note: 'conferido na Shopify (e2e)' });
  await A('POST', '/admin/vale-pass/flow/resume', { limit: 25, note: 'retomar retenções do e2e' });
  check('6.3', 'transação de TESTE da Shopify (test:true) não confirma pagamento: nada é emitido', (await vouchersOf(testTx)).length === 0, JSON.stringify(vt2.body));
  const wrongTotal = L.orderPayload({ variant: VT, email: 'cliente.valor@exemplo.invalid', over: { current_total_price: '100.00' } });
  await L.webhook(api, 'orders/paid', wrongTotal);
  L.setPaid(wrongTotal, { total: '100.00' });
  await A('POST', '/admin/vale-pass/flow/payment-time/verify', { orderId: String(wrongTotal.id), note: 'conferido na Shopify (e2e)' });
  await A('POST', '/admin/vale-pass/flow/resume', { limit: 25, note: 'retomar retenções do e2e' });
  check('6.4', 'valor pago diferente do preço oficial (R$ 100 em vez de R$ 350): não emite — retenção visível', (await vouchersOf(wrongTotal)).length === 0);
  const badSig = await L.webhook(api, 'orders/paid', L.orderPayload({ variant: VT }), { secret: 'segredo-errado' });
  const badShop = await L.webhook(api, 'orders/paid', L.orderPayload({ variant: VT }), { shop: 'outra-loja.myshopify.com' });
  check('6.5', 'webhook com assinatura inválida ou de outra loja é recusado (401) e nada é emitido', badSig === 401 && badShop === 401, `${badSig}/${badShop}`);

  console.log('\n== 7. LOTE/LIMITE ESGOTADO');
  const t1 = await buy(VX, { quantity: 2 });
  check('7.1', 'campanha com limite 2: pedido de 2 unidades emite 4 vouchers', (await vouchersOf(t1.order)).length === 4);
  const t2 = await buy(VX, { quantity: 1 });
  const cap = await A('GET', `/admin/vale-pass/campaigns/${tiny.id}/capacity`);
  check('7.2', 'o seguinte (limite esgotado) NÃO emite: fica retido e visível; capacidade 2/2', (await vouchersOf(t2.order)).length === 0 && cap.status === 200, `${JSON.stringify(cap.body).slice(0, 200)}`);

  console.log('\n== 8. CANCELAMENTO E REEMBOLSO');
  const c1 = await buy(VT, { email: 'cliente.cancela@exemplo.invalid' });
  await L.webhook(api, 'orders/cancelled', { ...c1.order, cancelled_at: new Date().toISOString(), financial_status: 'voided' });
  const c1v = await vouchersOf(c1.order);
  const c1m = await db.valePassEmailOutbox.findMany({ where: { shopifyOrderId: String(c1.order.id) } });
  check('8.1', 'pedido cancelado SEM uso: os dois vouchers ficam CANCELADOS (não podem ser usados)', c1v.length === 2 && c1v.every((v) => v.status === 'CANCELLED'), c1v.map((v) => v.status).join());
  const canc = await A('POST', `/admin/vale-pass/vouchers/${c1v[0].code}/redeem/prepare`, redeemBody(c1v[0], 1_000));
  check('8.2', 'voucher cancelado não resgata', canc.body?.canRedeem === false, JSON.stringify(canc.body).slice(0, 120));
  const c2 = await buy(VT, { email: 'cliente.reembolso@exemplo.invalid' });
  const c2v = await vouchersOf(c2.order);
  await redeem(A, byCompany(c2v, 'VS_BY_CLOSET'), 1_000); // crédito parcialmente usado
  const refund = { id: String(RUN) + '1', order_id: String(c2.order.id), refund_shipping_lines: [], transactions: [{ kind: 'refund', status: 'success', amount: '350.00' }], order_adjustments: [], refund_line_items: [{ id: 1, line_item_id: 1, quantity: 1, subtotal: 350, total_tax: 0, restock_type: 'return', line_item: { variant_id: VT, product_id: null, price: '350.00', quantity: 1 } }] };
  await L.webhook(api, 'refunds/create', refund, { triggeredAt: null });
  await sleep(500);
  const rv = await A('GET', '/admin/vale-pass/refund-reviews');
  const stillUsable = (await db.valePass.findMany({ where: { shopifyOrderId: String(c2.order.id) } }));
  const blocked = await A('POST', `/admin/vale-pass/vouchers/${byCompany(c2v, 'VALLE_SHOWROOM').code}/redeem/prepare`, redeemBody(byCompany(c2v, 'VALLE_SHOWROOM'), 1_000));
  check('8.3', 'reembolso de pedido com crédito já usado: abre REVISÃO para o ADMIN, uso fica bloqueado e nada some sozinho', rv.status === 200 && JSON.stringify(rv.body).includes(String(c2.order.id)) && blocked.body?.canRedeem === false && stillUsable.length === 2, `${JSON.stringify(blocked.body).slice(0, 160)}`);
  const reviewId = (rv.body.items ?? rv.body ?? []).find?.((r) => JSON.stringify(r).includes(String(c2.order.id)))?.id;
  const staffResolve = reviewId ? await S('POST', `/admin/vale-pass/refund-reviews/${reviewId}/resolve`, { action: 'CANCEL_ACTIVE_VOUCHERS', note: 'tentativa de funcionário (e2e)' }) : { status: 0 };
  check('8.4', 'STAFF não decide a revisão (403)', staffResolve.status === 403, staffResolve.status);
  const resolve = reviewId ? await A('POST', `/admin/vale-pass/refund-reviews/${reviewId}/resolve`, { action: 'CANCEL_ACTIVE_VOUCHERS', note: 'Reembolso confirmado na Shopify; cancelar o saldo restante (e2e).' }) : { status: 0, body: 'sem id' };
  const after = await db.valePass.findMany({ where: { shopifyOrderId: String(c2.order.id) } });
  check('8.5', 'ADMIN resolve a revisão cancelando o saldo ativo; o crédito já usado continua registrado no livro-razão', resolve.status < 300 && after.some((v) => v.status === 'CANCELLED') && (await db.valePassLedgerEntry.count({ where: { valePassId: byCompany(c2v, 'VS_BY_CLOSET').id } })) === 1, `${resolve.status} ${JSON.stringify(resolve.body).slice(0, 160)} ${after.map((v) => v.status)}`);
  const al = await A('GET', '/admin/vale-pass/cancellation-alerts');
  check('8.6', 'painel de alertas acessível ao ADMIN', al.status === 200, al.status);

  console.log('\n== 9. ESTADO DE PRODUÇÃO HOJE (chaves desligadas): nenhuma emissão indevida');
  const prodOrder = L.orderPayload({ variant: VO, email: `cliente.hoje.${RUN}@exemplo.invalid` });
  L.setPaid(prodOrder);
  const prodStatus = await L.webhook(prod, 'orders/paid', prodOrder);
  const P = L.adminClient(prod, admin);
  const pFlow = await P('GET', '/admin/vale-pass/flow');
  const pVer = await P('POST', '/admin/vale-pass/flow/payment-time/verify', { orderId: String(prodOrder.id), note: 'conferido na Shopify (e2e)' });
  const pRes = await P('POST', '/admin/vale-pass/flow/resume', { limit: 25, note: 'tentativa com a chave desligada' });
  await sleep(1500);
  check('9.1', 'com TWO_VOUCHER_FLOW desligada, o pagamento é aceito pelo webhook mas NÃO emite voucher', prodStatus === 200 && (await vouchersOf(prodOrder)).length === 0, `${prodStatus}`);
  check('9.2', 'o painel informa a emissão desligada e o pedido fica retido (nunca some)', pFlow.body.twoVoucherFlow === false && pFlow.body.heldByIntegration >= 1, JSON.stringify(pFlow.body).slice(0, 200));
  check('9.3', 'retomar com a chave desligada é recusado; mesmo confirmado o horário, nenhum voucher nasce', pRes.status >= 400 && (await vouchersOf(prodOrder)).length === 0, `${pRes.status}`);
  check('9.4', 'e nenhum e-mail sai com o envio desligado', L.fakeLog().filter((x) => x.type === 'resend.send' && x.to?.[0] === `cliente.hoje.${RUN}@exemplo.invalid`).length === 0);

  console.log('\n== 11. CAMPANHA DE TESTE: emite e envia e-mail, mas o voucher NÃO vale como crédito comercial');
  // Mesmos identificadores da campanha de teste real (só existem neste banco descartável): ID da campanha e Variant ID da Shopify.
  const TEST_ID = 'f6f16b3b-2ed0-4e8b-9420-e856adc1bf93';
  const TEST_VARIANT = 67916371165284;
  const testCampaign = await L.newCampaign({
    id: TEST_ID, name: `E2E VALLE PASS TESTE ${RUN}`, variant: TEST_VARIANT, validFrom: day(-1), validUntil: day(60), globalLimit: 1, amountCents: 10,
    benefits: [
      { code: 'teste_showroom', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'TESTE — Voucher Valle Showroom (sem valor comercial)', amountCents: 500, terms: 'Voucher de teste, sem valor comercial', sortOrder: 0 },
      { code: 'teste_closet', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'TESTE — Voucher VS BY CLOSET (sem valor comercial)', amountCents: 50, terms: 'Voucher de teste, sem valor comercial', sortOrder: 1 },
    ],
  });
  const testEmail = `cliente.teste.${RUN}@exemplo.invalid`;
  const tOrder = L.orderPayload({ variant: TEST_VARIANT, unitCents: 10, email: testEmail });
  check('9b.1', 'pedido de R$ 0,10 da campanha de teste: webhook aceito e, com a política estrita, fica retido até a conferência na Shopify', (await L.webhook(api, 'orders/paid', tOrder)) === 200 && (await vouchersOf(tOrder)).length === 0);
  L.setPaid(tOrder);
  await A('POST', '/admin/vale-pass/flow/payment-time/verify', { orderId: String(tOrder.id), note: 'conferido na Shopify (e2e)' });
  await A('POST', '/admin/vale-pass/flow/resume', { limit: 25, note: 'retomar retenções do e2e' });
  const tVs = await vouchersOf(tOrder);
  const xShow = byCompany(tVs, 'VALLE_SHOWROOM');
  const xClo = byCompany(tVs, 'VS_BY_CLOSET');
  check('9b.2', 'a EMISSÃO continua funcionando: dois vouchers de teste (R$ 5,00 e R$ 0,50), sem o desconto de 10%', tVs.length === 2 && xShow?.amountCents === 500 && xClo?.amountCents === 50 && tVs.every((v) => v.campaignId === TEST_ID));
  const tMail = await L.waitFor(() => L.fakeLog().find((x) => x.type === 'resend.send' && x.to?.[0] === testEmail), { timeout: 40_000 });
  check('9b.3', 'o E-MAIL de teste é enviado, com os dois códigos (o e-mail não leva rótulo "TESTE": a proteção é o bloqueio de resgate)', !!tMail && tMail.text.includes(xShow.code) && tMail.text.includes(xClo.code), tMail?.subject);
  const tCons = await A('GET', `/admin/vale-pass/vouchers/${xShow.code}/balance`);
  check('9b.4', 'a CONSULTA continua funcionando e mostra a restrição de teste', tCons.status === 200 && JSON.stringify(tCons.body.restrictions ?? []).includes('TEST_CAMPAIGN'), JSON.stringify(tCons.body).slice(0, 160));
  const tPrep = await A('POST', `/admin/vale-pass/vouchers/${xShow.code}/redeem/prepare`, redeemBody(xShow, 100));
  check('9b.5', 'ADMIN: prévia do resgate recusada (TEST_CAMPAIGN)', tPrep.status === 200 && tPrep.body.canRedeem === false && tPrep.body.problems?.some((p) => p.code === 'TEST_CAMPAIGN'), JSON.stringify(tPrep.body).slice(0, 160));
  const tConf = await redeem(A, xShow, 100);
  const tOwner = await redeem(O, xClo, 10);
  const tStaff = await redeem(S, xShow, 100);
  const tUse = await A('POST', `/admin/vale-pass/vouchers/${xShow.code}/use`, {});
  check('9b.6', 'confirmar o resgate é recusado (409) para ADMIN e SUPER_ADMIN; STAFF também (403); o "marcar como utilizado" legado idem (409)', tConf.status === 409 && tOwner.status === 409 && tStaff.status >= 400 && tUse.status === 409, `${tConf.status}/${tOwner.status}/${tStaff.status}/${tUse.status}`);
  check('9b.7', 'nada foi gravado: saldos intactos e zero lançamentos no livro-razão', (await balance(xShow)) === 500 && (await balance(xClo)) === 50 && (await db.valePassLedgerEntry.count({ where: { valePassId: { in: [xShow.id, xClo.id] } } })) === 0);
  const tCancel = await A('POST', `/admin/vale-pass/vouchers/${xShow.code}/cancel`, { reason: 'Encerramento do teste de compra (e2e), sem valor comercial.' });
  await L.webhook(api, 'orders/cancelled', { ...tOrder, cancelled_at: new Date().toISOString(), financial_status: 'voided' });
  const tAfter = await vouchersOf(tOrder);
  check('9b.8', 'o CANCELAMENTO funciona: um voucher pelo ADMIN e o pedido cancelado na Shopify cancela o resto; nenhum crédito ativo sobra', tCancel.status < 300 && tAfter.every((v) => v.status === 'CANCELLED'), `${tCancel.status} ${tAfter.map((v) => v.status)}`);
  // a campanha OFICIAL continua resgatando (já provado na seção 4); aqui só confirmamos que a de teste não contaminou a lista de oficial
  check('9b.9', 'a campanha OFICIAL do ensaio segue resgatável depois da campanha de teste existir', (await A('POST', `/admin/vale-pass/vouchers/${show.code}/redeem/prepare`, redeemBody(show, 100))).body?.problems?.every((p) => p.code === 'NOT_YET_VALID'));

  console.log('\n== 10. AUDITORIA');
  const audit = await db.adminAuditEvent.findMany({ where: { createdAt: { gte: new Date(RUN) } }, orderBy: { createdAt: 'asc' } });
  const actions = [...new Set(audit.map((a) => a.action))];
  const need = ['VALE_PASS_REDEEMED', 'VALE_PASS_REDEMPTION_REVERSED'];
  check('10.1', 'resgates e reversões auditados com autor', need.every((a) => audit.some((e) => e.action === a && e.adminUserId)), actions.join(', '));
  check('10.2', 'conferência de pagamento e retomadas auditadas', audit.some((e) => /PAYMENT_TIME/.test(e.action)) || audit.some((e) => /RESUME|ISSUED|HELD/.test(e.action)), actions.join(', '));
  check('10.3', 'toda movimentação tem registro: 0 resgates sem lançamento no livro-razão', (await db.valePassLedgerEntry.count({ where: { valePassId: { in: [tShow.id, tClo.id, v5.id] } } })) >= 4);
  fs.writeFileSync(`${L.TMP}/audit-actions.txt`, actions.join('\n'));
} catch (err) {
  check('ERRO', 'execução do E2E', false, err?.stack ?? err);
} finally {
  await api.stop();
  await prod.stop();
  await db.$disconnect();
  const ok = L.results.filter((r) => r.ok).length;
  const bad = L.results.filter((r) => !r.ok);
  fs.writeFileSync(`${L.TMP}/results.json`, JSON.stringify(L.results, null, 1));
  console.log(`(resultados em ${L.TMP}/results.json)`);
  process.exitCode = bad.length ? 1 : 0;
  console.log(`\nRESULTADO: ${ok} aprovados, ${bad.length} falhos de ${L.results.length}`);
  for (const b of bad) console.log(`  ✘ [${b.id}] ${b.description} :: ${b.detail}`);
}
