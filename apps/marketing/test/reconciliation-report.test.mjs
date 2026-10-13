import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

// Conferência Shopify × reservas no ClosetAdmin: relatório SOMENTE LEITURA, para análise humana.
const root = new URL('../', import.meta.url);
const repoRoot = new URL('../../../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const lib = {};
runInNewContext(
  ts.transpileModule(readFileSync(new URL('src/lib/reconciliation-report.ts', root), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText,
  { exports: lib, Object, Array, Number, String, Math },
);
const { KIND_INFO, reportDays, kindInfo, sortDivergences, urgentCount, parseReport } = lib;
const plain = (v) => JSON.parse(JSON.stringify(v));
const read = (file, base = root) => readFileSync(new URL(file, base), 'utf8').replace(/\r\n/g, '\n');

const divergence = (kind, orderName, extra = {}) => ({ kind, orderId: String(orderName).replace('#', ''), orderName, reservationId: null, reservationStatus: null, shopify: { cancelled: false, closed: false, financialStatus: 'paid' }, action: 'none', applied: false, note: 'x', ...extra });
const report = (divergences, extra = {}) => ({ generatedAt: '2026-10-13T00:00:00.000Z', windowDays: 10, mode: 'report', checkedReservations: 4, checkedShopifyOrders: 6, truncated: false, summary: {}, divergences, ...extra });

test('janela: padrão 10 dias, sempre entre 1 e 60 (limite da API); lixo volta ao padrão', () => {
  assert.equal(reportDays(undefined), 10);
  assert.equal(reportDays('30'), 30);
  assert.equal(reportDays(['60', '5']), 60);
  assert.equal(reportDays('0'), 1);
  assert.equal(reportDays('-4'), 1);
  assert.equal(reportDays('999'), 60);
  for (const junk of ['', 'abc', '1.5', '10; DROP', 'NaN']) assert.equal(reportDays(junk), 10, junk);
});

test('as duas divergências de pagamento perdido são de gravidade ALTA; arquivamento e fora da janela são só informativos', () => {
  assert.equal(KIND_INFO.paid_in_shopify_not_confirmed.severity, 'alta');
  assert.equal(KIND_INFO.shopify_order_without_reservation.severity, 'alta');
  assert.equal(KIND_INFO.closed_in_shopify.severity, 'info');
  assert.equal(KIND_INFO.unverifiable_missing.severity, 'info');
  for (const info of Object.values(KIND_INFO)) {
    assert.ok(info.label.length > 10 && info.guidance.length > 20);
    assert.equal(/corrig|aplic|reenvi|criar automaticamente/i.test(info.guidance.replace('Nada é criado automaticamente', '')), false, 'a orientação nunca promete ação automática');
  }
  assert.equal(kindInfo('tipo_novo').severity, 'media', 'tipo desconhecido não some: vira "confira manualmente"');
});

test('ordenação: urgentes primeiro, depois por tipo e número do pedido; contagem de urgentes', () => {
  const list = [divergence('closed_in_shopify', '#1010'), divergence('shopify_order_without_reservation', '#1020'), divergence('paid_in_shopify_not_confirmed', '#1003'), divergence('cancelled_in_shopify', '#1001'), divergence('paid_in_shopify_not_confirmed', '#1002')];
  assert.deepEqual(plain(sortDivergences(list).map((d) => `${d.kind}:${d.orderName}`)), [
    'paid_in_shopify_not_confirmed:#1002', 'paid_in_shopify_not_confirmed:#1003', 'shopify_order_without_reservation:#1020', 'cancelled_in_shopify:#1001', 'closed_in_shopify:#1010',
  ]);
  assert.equal(urgentCount({ divergences: list }), 3);
  assert.equal(urgentCount({ divergences: [] }), 0);
});

test('o relatório válido é aceito; o que não é relatório vira erro (nunca um "tudo certo" falso)', () => {
  const ok = parseReport(report([divergence('paid_in_shopify_not_confirmed', '#1002', { reservationId: 'abc', reservationStatus: 'expired' })], { summary: { paid_in_shopify_not_confirmed: 1 } }));
  assert.ok(ok);
  assert.equal(ok.divergences[0].reservationStatus, 'expired');
  assert.equal(ok.summary.paid_in_shopify_not_confirmed, 1);
  assert.ok(parseReport(report([])), 'relatório sem divergências é válido');
  for (const bad of [null, undefined, 'ok', [], {}, '<html>erro</html>', { ...report([]), divergences: 'x' }, { ...report([]), windowDays: '10' }, { ...report([]), divergences: [{ kind: 5 }] }, { ...report([]), summary: null }]) {
    assert.equal(parseReport(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('modo "apply" NUNCA é exibido: uma resposta de aplicação é recusada', () => {
  assert.equal(parseReport({ ...report([]), mode: 'apply' }), null);
});

test('campos desconhecidos da API (versão mais nova) são ignorados e dados do cliente não passam pelo módulo', () => {
  const parsed = parseReport(report([{ ...divergence('cancelled_in_shopify', '#1'), customerEmail: 'a@b.com', phone: '+56 9' }], { extra: 1 }));
  assert.ok(parsed);
  assert.equal(JSON.stringify(parsed).includes('a@b.com'), false);
  assert.equal(JSON.stringify(parsed).includes('+56 9'), false);
});

// ── guardas: a tela é somente leitura ───────────────────────────────────────────────
test('a camada de dados só faz GET no modo relatório (sem POST/apply) e a tela não tem formulário nem ação de servidor', () => {
  const data = read('src/lib/shopify-reconciliation-data.ts');
  assert.match(data, /adminGetPlain</);
  assert.equal(/adminUserId/.test(data.replace(/\/\/.*$/gm, '')), false, 'o DTO do relatório só aceita `days`: com adminUserId na query a API responde 400');
  assert.equal(/adminPost|adminPatch|adminPut|\/apply|apply=/i.test(data), false);
  const page = read('src/app/closetadmin/(protected)/reservas/conferencia/page.tsx');
  for (const forbidden of ["'use client'", "'use server'", '<form', 'onClick', 'adminPost', '<button']) assert.equal(page.includes(forbidden), false, forbidden);
  assert.match(page, /requireAdminRole\(session, 'ADMIN'\)/);
  assert.match(page, /requireAdminModule\(session, 'RESERVATIONS'\)/);
});

test('link na lista de Reservas só para ADMIN', () => {
  const list = read('src/app/closetadmin/(protected)/reservas/page.tsx');
  assert.match(list, /hasAdminRole\(session, 'ADMIN'\) \? \(\s*<Link\s+href="\/closetadmin\/reservas\/conferencia"/);
});

test('contrato: o relatório que a tela lê é o que a API devolve no GET (mesmos campos e mesmo modo)', () => {
  const api = read('apps/reservations-api/src/shopify-reconciliation/shopify-reconciliation.service.ts', repoRoot);
  for (const field of ['generatedAt', 'windowDays', 'mode', 'checkedReservations', 'checkedShopifyOrders', 'truncated', 'summary', 'divergences', 'orderName', 'reservationId', 'reservationStatus', 'financialStatus']) assert.ok(api.includes(field), `API sem ${field}`);
  for (const kind of Object.keys(KIND_INFO)) assert.ok(api.includes(`'${kind}'`), `API sem o tipo ${kind}`);
  const controller = read('apps/reservations-api/src/shopify-reconciliation/shopify-reconciliation.controller.ts', repoRoot);
  assert.match(controller, /@Get\(\)\s+report\([\s\S]*apply: false/);
  assert.match(controller, /@RequireRole\('ADMIN'\)/);
});

test('nenhum arquivo novo do painel usa dados pessoais do cliente', () => {
  const dir = fileURLToPath(new URL('src/app/closetadmin/(protected)/reservas/conferencia/', root));
  for (const name of readdirSync(dir)) {
    if (!statSync(path.join(dir, name)).isFile()) continue;
    assert.equal(/customerName|customerEmail|customerPhone|email|telefone/i.test(readFileSync(path.join(dir, name), 'utf8')), false, name);
  }
});
