import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// "Pagamentos a tratar": o TS/TSX real (transpilado) — regras de apresentação, leitura defensiva da resposta,
// contador do menu e a renderização do cartão (com as dependências do Next trocadas por stubs).
const root = new URL('../', import.meta.url);
const req = createRequire(new URL('package.json', root));
const ts = req('typescript');
const React = req('react');
const { renderToStaticMarkup } = req('react-dom/server');
const jsxRuntime = req('react/jsx-runtime');

function load(path, requireMap = {}) {
  const exports = {};
  const mod = { exports };
  runInNewContext(
    ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX },
    }).outputText,
    { exports, module: mod, require: (name) => { if (name in requireMap) return requireMap[name]; throw new Error(`import inesperado: ${name}`); }, Promise, Date, Number, Math, Array, Object, String, RegExp, Error },
  );
  return mod.exports;
}

const lib = load('src/lib/payment-alerts.ts');
const attentionLib = load('src/lib/reservation-attention.ts');
const poller = load('src/lib/valle-pass-attention.ts');
const plain = (value) => JSON.parse(JSON.stringify(value));

const RES_ID = '3f2b7a0e-9c1d-4e5a-8b6c-1d2e3f4a5b6c';
const alert = (over = {}) => ({
  kind: 'PAID_ORDER_WITHOUT_RESERVATION', key: 'order:1011', orderId: '6001', orderName: '#1011', amount: '120.00', currency: 'BRL',
  reservationId: null, reservationStatus: null, since: '2026-10-16T10:00:00.000Z', orderDeleted: false, orderSettled: false, ...over,
});

test('parsePaymentAlerts aceita o formato do servidor e copia só os campos conhecidos (nada pessoal passa)', () => {
  const parsed = lib.parsePaymentAlerts({
    count: 2,
    alerts: [
      { ...alert(), customerEmail: 'a@b.com', customerName: 'Fulana', customerPhone: '+5511999999999', payload: { x: 1 } },
      alert({ kind: 'RESERVATION_PROBLEM', key: `reservation:${RES_ID}`, reservationId: RES_ID, reservationStatus: 'problem', orderId: null, orderName: null, amount: null, currency: null }),
    ],
  });
  assert.equal(parsed.count, 2);
  assert.deepEqual(Object.keys(parsed.alerts[0]).sort(), ['amount', 'currency', 'key', 'kind', 'orderDeleted', 'orderId', 'orderName', 'orderSettled', 'reservationId', 'reservationStatus', 'since']);
  assert.equal(parsed.alerts[0].orderDeleted, false);
  assert.equal(lib.parsePaymentAlerts({ count: 1, alerts: [alert({ orderDeleted: true, orderSettled: true })] }).alerts[0].orderDeleted, true);
  assert.equal(lib.parsePaymentAlerts({ count: 1, alerts: [alert({ orderDeleted: 'sim' })] }).alerts[0].orderDeleted, false); // só `true` de verdade
  assert.ok(!JSON.stringify(parsed).match(/a@b\.com|Fulana|5511999999999/));
  assert.equal(parsed.alerts[1].reservationId, RES_ID);
});

test('parsePaymentAlerts recusa formato inválido (a tela avisa em vez de mostrar errado)', () => {
  for (const bad of [null, undefined, 'x', {}, { count: -1, alerts: [] }, { count: 1.5, alerts: [] }, { count: 1, alerts: 'x' },
    { count: 1, alerts: [alert({ kind: 'OUTRO' })] }, { count: 1, alerts: [alert({ key: '' })] }, { count: 1, alerts: [alert({ since: 'ontem' })] }, { count: 1, alerts: [null] }]) {
    assert.equal(lib.parsePaymentAlerts(bad), null);
  }
  // id de reserva que não é UUID não vira link
  assert.equal(lib.parsePaymentAlerts({ count: 1, alerts: [alert({ reservationId: '../../etc' })] }).alerts[0].reservationId, null);
});

test('textos: título e orientação por tipo; manchete no singular e no plural', () => {
  for (const kind of ['LATE_PAYMENT_CONFLICT', 'PAID_ORDER_WITHOUT_RESERVATION', 'PAID_ORDER_INACTIVE_RESERVATION', 'RESERVATION_PROBLEM']) {
    assert.ok(lib.paymentAlertTitle(kind).length > 5);
    assert.ok(lib.paymentAlertHint(kind).length > 20);
  }
  assert.equal(lib.paymentAlertsHeadline(0), 'Nenhum pagamento a tratar');
  assert.equal(lib.paymentAlertsHeadline(1), '1 pagamento a tratar');
  assert.equal(lib.paymentAlertsHeadline(3), '3 pagamentos a tratar');
});

test('valor e tempo: BRL em formato brasileiro, outra moeda como veio, valor ilegível some', () => {
  assert.equal(lib.formatAlertAmount('120.00', 'BRL'), 'R$ 120,00');
  assert.equal(lib.formatAlertAmount('1234.5', null), 'R$ 1.234,50');
  assert.equal(lib.formatAlertAmount('0.5', 'BRL'), 'R$ 0,50');
  assert.equal(lib.formatAlertAmount('10', 'USD'), '10.00 USD');
  assert.equal(lib.formatAlertAmount('abc', 'BRL'), null);
  assert.equal(lib.formatAlertAmount(null, 'BRL'), null);
  const now = Date.parse('2026-10-16T12:00:00Z');
  assert.equal(lib.sinceLabel('2026-10-16T11:59:30Z', now), 'agora há pouco');
  assert.equal(lib.sinceLabel('2026-10-16T11:55:00Z', now), 'há 5 min');
  assert.equal(lib.sinceLabel('2026-10-16T09:00:00Z', now), 'há 3 h');
  assert.equal(lib.sinceLabel('2026-10-13T12:00:00Z', now), 'há 3 dias');
});

test('"e mais N": a contagem total é a do servidor, o cartão mostra no máximo 8', () => {
  const eight = Array.from({ length: 8 }, (_, i) => alert({ key: `order:${i}` }));
  assert.equal(lib.PAYMENT_ALERTS_VISIBLE, 8);
  assert.equal(lib.hiddenAlertsCount({ count: 8, alerts: eight }), 0);
  assert.equal(lib.hiddenAlertsCount({ count: 13, alerts: eight }), 5);
  assert.equal(lib.hiddenAlertsCount({ count: 2, alerts: eight.slice(0, 2) }), 0);
});

test('menu: sem alertas o texto é o de sempre; com alertas separa reservas novas de pagamentos, sem contar nada duas vezes', () => {
  const label = attentionLib.reservationAttentionLabel;
  assert.equal(label(null), 'nenhuma reserva nova');
  assert.equal(label(0, 0), 'nenhuma reserva nova');
  assert.equal(label(1), '1 reserva nova');
  assert.equal(label(7), '7 reservas novas');
  assert.equal(label(150), 'mais de 99 reservas novas');
  assert.equal(label(3, 0), '3 reservas novas');
  assert.equal(label(2, 2), '2 pagamentos a tratar');
  assert.equal(label(1, 1), '1 pagamento a tratar');
  assert.equal(label(4, 1), '3 reservas novas e 1 pagamento a tratar');
  assert.equal(label(3, 2), '1 reserva nova e 2 pagamentos a tratar');
  assert.equal(label(2, 9), '2 pagamentos a tratar'); // alertas nunca passam do total
});

test('o contador do menu leva o número de alertas junto (Valle Pass não muda)', async () => {
  const seen = [];
  let tick;
  const results = [{ count: 5, alerts: 2 }, { count: 5, alerts: 2 }, { count: 3 }, { count: 4 }];
  const p = poller.startAttentionPoller({
    fetchCount: async () => results.shift(),
    isVisible: () => true,
    setInterval: (fn) => { tick = fn; return 1; },
    clearInterval: () => {},
    onChange: (state) => seen.push(plain(state)),
  });
  await p.refresh();
  await p.refresh(); // mesmo valor: não republica
  await p.refresh();
  await p.refresh();
  p.stop();
  assert.deepEqual(seen, [
    { count: 5, alerts: 2, stale: false, stopped: false },
    { count: 3, stale: false, stopped: false }, // sem `alerts` quando o servidor não manda (formato do Valle Pass)
    { count: 4, stale: false, stopped: false },
  ]);
  assert.equal(typeof tick, 'function');
});

// ---- cartão "Pagamentos a tratar" (TSX real, dependências do Next trocadas por stubs) ----
class AdminApiError extends Error { constructor(status) { super('x'); this.status = status; } }
let fixture = null;
let failWith = null;
const Link = ({ href, children, ...rest }) => React.createElement('a', { href, ...rest }, children);
const conflictLib = load('src/lib/payment-conflict.ts');
// O banner antigo REAL (sem stub): é ele que não pode aparecer junto do cartão.
const legacy = load('src/components/closetadmin/PaymentConflictAlert.tsx', {
  'react/jsx-runtime': jsxRuntime,
  'next/link': { __esModule: true, default: Link },
  'lucide-react': { AlertTriangle: () => null },
  '@/lib/payment-conflict': conflictLib,
});
const component = load('src/app/closetadmin/(protected)/PaymentAlerts.tsx', {
  'react/jsx-runtime': jsxRuntime,
  'next/link': { __esModule: true, default: Link },
  'lucide-react': { Banknote: () => null },
  '@/lib/admin-api': { AdminApiError },
  '@/lib/admin-data': { getPaymentAlerts: async () => { if (failWith) throw failWith; return fixture; } },
  '@/lib/closetadmin-shopify': { shopifyOrderAdminUrl: (id) => (id ? `https://loja.test/admin/orders/${id}` : null) },
  '@/components/closetadmin/PaymentConflictAlert': legacy,
  '@/lib/payment-conflict': conflictLib,
  '@/lib/payment-alerts': lib,
});
const render = async (props = {}) => {
  const element = await component.PaymentAlerts({ adminUserId: 'u1', ...props });
  return element ? renderToStaticMarkup(element) : '';
};

test('cartão: sem alertas não aparece', async () => {
  fixture = { count: 0, alerts: [] };
  failWith = null;
  assert.equal(await render(), '');
});

test('cartão: mostra tipo, número do pedido, valor, links e a manchete; nenhum dado pessoal', async () => {
  fixture = {
    count: 2,
    alerts: [
      { ...alert({ kind: 'LATE_PAYMENT_CONFLICT', key: `reservation:${RES_ID}`, reservationId: RES_ID, reservationStatus: 'late_payment_conflict' }), customerEmail: 'segredo@x.com' },
      alert({ key: 'order:1012', orderId: '6002', orderName: '#1012', amount: '0.50' }),
    ],
  };
  const html = await render();
  assert.match(html, /data-testid="pagamentos-a-tratar"/);
  assert.match(html, /2 pagamentos a tratar/);
  assert.match(html, /Pagamento recebido, peça já ocupada/);
  assert.match(html, /Pedido pago sem reserva/);
  assert.match(html, /#1011/);
  assert.match(html, /R\$ 120,00/);
  assert.match(html, /R\$ 0,50/);
  assert.match(html, /href="\/closetadmin\/reservas\/3f2b7a0e-9c1d-4e5a-8b6c-1d2e3f4a5b6c"/);
  assert.match(html, /href="https:\/\/loja\.test\/admin\/orders\/6001"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.equal((html.match(/data-testid="pagamento-a-tratar"/g) ?? []).length, 2);
  assert.ok(!/segredo@x\.com/.test(html));
  assert.ok(!/<button/.test(html), 'somente leitura: nenhum botão de ação');
});

test('cartão: passa de 8 → "e mais N"; erro de rede → aviso; API antiga (404) ou sem permissão (403) → nada', async () => {
  fixture = { count: 11, alerts: Array.from({ length: 8 }, (_, i) => alert({ key: `order:${i}`, orderId: String(7000 + i), orderName: `#${i}` })) };
  failWith = null;
  let html = await render();
  assert.equal((html.match(/data-testid="pagamento-a-tratar"/g) ?? []).length, 8);
  assert.match(html, /e mais 3 pagamentos a tratar/);

  fixture = { count: 'x' };
  html = await render();
  assert.match(html, /data-testid="pagamentos-a-tratar-erro"/);

  failWith = new Error('rede');
  assert.match(await render(), /Não foi possível verificar agora/);
  for (const status of [400, 403, 404]) {
    failWith = new AdminApiError(status);
    assert.equal(await render(), '');
  }
  failWith = new AdminApiError(500);
  assert.match(await render(), /Não foi possível verificar agora/);
});

test('sem duplicar: com o cartão disponível o banner antigo de conflito NUNCA aparece; o link da lista filtrada passa a viver no cartão', async () => {
  failWith = null;
  fixture = { count: 1, alerts: [alert({ kind: 'LATE_PAYMENT_CONFLICT', key: `reservation:${RES_ID}`, reservationId: RES_ID, reservationStatus: 'late_payment_conflict' })] };
  for (const compact of [false, true]) {
    const html = await render({ conflictCount: 2, compactConflict: compact });
    assert.match(html, /data-testid="pagamentos-a-tratar"/);
    assert.equal((html.match(/data-testid="alerta-conflito-pagamento"/g) ?? []).length, 0, 'banner antigo ausente');
    assert.equal((html.match(/data-testid="alerta-conflito-link"/g) ?? []).length, 1, 'um único link para a lista de conflitos');
    assert.match(html, /href="\/closetadmin\/reservas\?status=late_payment_conflict"/);
  }
  // sem conflito entre os alertas: sem link de conflito
  fixture = { count: 1, alerts: [alert()] };
  assert.ok(!/alerta-conflito-link/.test(await render({ conflictCount: 3 })));
  // nenhum alerta (conflitos todos já reembolsados): nada aparece, nem o banner antigo
  fixture = { count: 0, alerts: [] };
  assert.equal(await render({ conflictCount: 3 }), '');
});

test('sem perder funcionalidade: se o cartão não puder carregar, o banner antigo de conflito volta (completo no painel, compacto em Reservas)', async () => {
  fixture = { count: 0, alerts: [] };
  for (const status of [400, 403, 404]) {
    failWith = new AdminApiError(status);
    const full = await render({ conflictCount: 2 });
    assert.match(full, /data-testid="alerta-conflito-pagamento"/);
    assert.match(full, /2 reservas com pagamento recebido e conflito de disponibilidade/);
    assert.match(full, /data-testid="alerta-conflito-link"/);
    assert.ok(!/pagamentos-a-tratar/.test(full));
    const compact = await render({ conflictCount: 1, compactConflict: true });
    assert.match(compact, /1 reserva com pagamento recebido e conflito de disponibilidade/);
    assert.equal(await render({ conflictCount: 0 }), '');
  }
  failWith = new Error('rede');
  const html = await render({ conflictCount: 1 });
  assert.match(html, /data-testid="pagamentos-a-tratar-erro"/);
  assert.match(html, /data-testid="alerta-conflito-pagamento"/);
  failWith = null;
  fixture = { count: 'x' };
  const bad = await render({ conflictCount: 1 });
  assert.match(bad, /pagamentos-a-tratar-erro/);
  assert.match(bad, /alerta-conflito-pagamento/);
});

test('orientação: pedido excluído avisa que o dinheiro NÃO foi devolvido; problem com pedido já tratado explica que a peça segue presa', () => {
  assert.match(lib.paymentAlertHint('PAID_ORDER_WITHOUT_RESERVATION', { orderDeleted: true }), /excluído na Shopify, mas o pagamento NÃO foi estornado/);
  assert.ok(!/excluído/.test(lib.paymentAlertHint('PAID_ORDER_WITHOUT_RESERVATION')));
  assert.match(lib.paymentAlertHint('RESERVATION_PROBLEM', { orderSettled: true }), /já foi cancelado ou reembolsado, mas a reserva continua em revisão e segurando a peça/);
  assert.match(lib.paymentAlertHint('RESERVATION_PROBLEM'), /revisão manual/);
});

test('contador do menu: reservas novas e pagamentos a tratar ficam separados e somam sem duplicar', () => {
  const combine = attentionLib.combineReservationAttention;
  assert.deepEqual(plain(combine(3, 0)), { count: 3 });
  assert.deepEqual(plain(combine(0, 2)), { count: 2, alerts: 2 });
  assert.deepEqual(plain(combine(3, 2)), { count: 5, alerts: 2 });
  assert.deepEqual(plain(combine(0, 0)), { count: 0 });
  assert.deepEqual(plain(combine(-1, Number.NaN)), { count: 0 });
  assert.deepEqual(plain(combine(2.9, 1.2)), { count: 3, alerts: 1 });
  // o texto reconstrói exatamente as duas partes a partir de count/alerts
  const { count, alerts } = combine(3, 2);
  assert.equal(attentionLib.reservationAttentionLabel(count, alerts), '3 reservas novas e 2 pagamentos a tratar');
});
