// Pré-carregado no processo da API (NODE_OPTIONS=--require): troca o fetch global por uma Shopify Admin e uma Resend FALSAS.
// Qualquer outro destino é bloqueado. O estado (transações por pedido, falhas do e-mail) vem de um arquivo que o teste edita.
const fs = require('node:fs');
const stateFile = process.env.E2E_FAKE_STATE;
const logFile = process.env.E2E_FAKE_LOG;
const shop = (process.env.SHOPIFY_STORE_DOMAIN || '').toLowerCase();
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const writeState = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
const log = (o) => fs.appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');
const respond = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, json: async () => body, text: async () => JSON.stringify(body) });
let emailSeq = 0;
const seenKeys = new Map();
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (url.hostname.toLowerCase() === shop) {
    if (url.pathname.endsWith('/oauth/access_token')) return respond(200, { access_token: 'fake-admin-token', expires_in: 3600 });
    if (url.pathname.endsWith('/graphql.json')) {
      const { query, variables } = JSON.parse(init.body);
      if (query.includes('ClosetAdminOrderTransactions')) {
        const order = (readState().orders || {})[variables.id];
        log({ type: 'shopify.order-transactions', id: variables.id, found: !!order });
        if (!order) return respond(200, { data: { order: null } });
        return respond(200, { data: { order: { id: variables.id, currentTotalPriceSet: { shopMoney: { amount: order.total, currencyCode: order.currency } }, transactions: order.transactions } } });
      }
      log({ type: 'shopify.graphql-ignored' });
      return respond(200, { data: {} });
    }
  }
  if (url.hostname === 'api.resend.com' && url.pathname === '/emails') {
    const body = JSON.parse(init.body);
    const key = (init.headers || {})['Idempotency-Key'];
    const st = readState();
    if ((st.resendFailNext || 0) > 0) { st.resendFailNext -= 1; writeState(st); log({ type: 'resend.fail', key, to: body.to }); return respond(503, { message: 'temporarily unavailable' }); }
    let id = seenKeys.get(key);
    const replay = !!id;
    if (!id) { id = `em_e2e_${++emailSeq}`; seenKeys.set(key, id); }
    log({ type: 'resend.send', key, replay, id, to: body.to, from: body.from, subject: body.subject, text: body.text });
    return respond(200, { id });
  }
  log({ type: 'net.blocked', host: url.hostname });
  throw new Error(`E2E: rede real bloqueada (${url.hostname})`);
};
