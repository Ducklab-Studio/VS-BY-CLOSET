import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Server actions do painel "Sincronização com a Shopify" e o transporte para o servidor do ClosetAdmin.
// O TS real, transpilado, com as dependências (sessão, API, cache do Next) simuladas: nenhuma rede.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const transpile = (path) =>
  ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
const load = (path, requireStub, globals = {}) => {
  const exports = {};
  runInNewContext(transpile(path), { exports, require: requireStub, Error, Promise, JSON, Object, Array, String, Number, Math, Date, URL, URLSearchParams, process: { env: {} }, ...globals });
  return exports;
};
const read = (path) => readFileSync(new URL(path, root), 'utf8').replace(/\r\n/g, '\n');

// ── transporte (admin-api.ts) ───────────────────────────────────────────────────────────
const { isSafeAdminPath } = load('src/lib/admin-path.ts', () => ({}), { decodeURIComponent, RegExp });

function loadApi({ fetchImpl, env = { RESERVATIONS_API_ADMIN_URL: 'https://api.test', ADMIN_API_TOKEN: 'token-secreto-123' }, timeouts }) {
  const requireStub = (name) => {
    if (name === 'server-only') return {};
    if (name === 'next/headers') return { cookies: async () => ({ get: (n) => (n === 'closetadmin_session' ? { value: 'sessao-abc' } : undefined) }) };
    if (name === './admin-cookie') return { ADMIN_SESSION_COOKIE: 'closetadmin_session' };
    if (name === './admin-path') return { isSafeAdminPath };
    throw new Error(`require inesperado: ${name}`);
  };
  return load('src/lib/admin-api.ts', requireStub, {
    process: { env },
    fetch: fetchImpl,
    AbortSignal: { timeout: (ms) => { timeouts.push(ms); return undefined; } },
  });
}
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

test('transporte: sem opções o prazo é 10 s e um estouro continua 503 "não foi possível conectar" (nada mudou para os outros fluxos)', async () => {
  const timeouts = [];
  const api = loadApi({ timeouts, fetchImpl: async () => { throw timeoutError(); } });
  await assert.rejects(api.adminPost('/admin/pieces/x/toggle', {}), (err) => err.status === 503 && /Não foi possível conectar ao servidor do ClosetAdmin\./.test(err.message));
  assert.deepEqual([...timeouts], [10_000]);
});

test('transporte: com prazo próprio (sincronização) o estouro vira 504 "pode ter concluído"; erro de rede comum continua 503', async () => {
  const timeouts = [];
  let boom = timeoutError();
  const api = loadApi({ timeouts, fetchImpl: async () => { throw boom; } });
  await assert.rejects(api.adminPost('/admin/catalog/sync', {}, undefined, { timeoutMs: 25_000 }), (err) => err.status === 504 && /demorou demais/.test(err.message));
  boom = new TypeError('fetch failed');
  await assert.rejects(api.adminPost('/admin/catalog/sync', {}, undefined, { timeoutMs: 25_000 }), (err) => err.status === 503);
  assert.deepEqual([...timeouts], [25_000, 25_000]);
});

test('transporte: autenticação do servidor (Bearer + sessão) segue igual e o token nunca aparece em mensagem de erro', async () => {
  const calls = [];
  const timeouts = [];
  const api = loadApi({ timeouts, fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: false, status: 403, json: async () => ({ message: 'Acesso negado.' }) }; } });
  await assert.rejects(api.adminPost('/admin/catalog/sync', {}), (err) => err.status === 403 && err.message === 'Acesso negado.' && !JSON.stringify(err).includes('token-secreto-123'));
  assert.equal(calls[0].url, 'https://api.test/admin/catalog/sync');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer token-secreto-123');
  assert.equal(calls[0].init.headers['X-Admin-Session'], 'sessao-abc');
  assert.equal(calls[0].init.body, '{}');
});

// ── camada de dados e server actions ─────────────────────────────────────────────────────
test('syncCatalog: corpo SEMPRE vazio (nada vem do cliente) e prazo de 25 s, abaixo do maxDuration (30 s) da página', () => {
  const posts = [];
  const data = load('src/lib/shopify-admin-data.ts', (name) => {
    if (name === 'server-only') return {};
    if (name === './admin-api') return { adminGet: async () => null, adminPost: async (...args) => { posts.push(args); return { ok: true }; } };
    throw new Error(`require inesperado: ${name}`);
  });
  return data.syncCatalog().then(() => {
    assert.deepEqual(JSON.parse(JSON.stringify(posts[0])), ['/admin/catalog/sync', {}, null, { timeoutMs: 25000 }].map((v, i) => (i === 2 ? undefined : v)).map((v) => v ?? null));
    assert.equal(data.SYNC_TIMEOUT_MS, 25_000);
    const page = read('src/app/closetadmin/(protected)/pecas/page.tsx');
    assert.match(page, /export const maxDuration = 30;/);
    assert.ok(data.SYNC_TIMEOUT_MS < 30_000);
  });
});

class AdminApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function loadActions({ role = 'ADMIN', syncImpl, reportImpl } = {}) {
  const log = { revalidated: [], sync: 0, report: 0, roleChecks: [], moduleChecks: [] };
  const session = { id: 'u-1', role };
  const actions = load('src/app/closetadmin/(protected)/pecas/actions.ts', (name) => {
    if (name === 'next/cache') return { revalidatePath: (p) => log.revalidated.push(p) };
    if (name === '@/lib/admin-session') {
      return {
        requireAdminSession: async () => session,
        requireAdminRole: (s, r) => { log.roleChecks.push(r); if (s.role !== r && s.role !== 'SUPER_ADMIN') throw new Error('REDIRECT /closetadmin'); },
        requireAdminModule: (s, m) => { log.moduleChecks.push(m); },
      };
    }
    if (name === '@/lib/admin-data') return { updatePiece: async () => ({}) };
    if (name === '@/lib/shopify-admin-data') {
      return {
        importShopifyUnits: async () => { throw new Error('não deve ser chamado'); },
        syncCatalog: async () => { log.sync++; return syncImpl(); },
        getCatalogReconciliation: async () => { log.report++; return reportImpl(); },
      };
    }
    if (name === '@/lib/admin-api') return { AdminApiError };
    throw new Error(`require inesperado: ${name}`);
  });
  return { actions, log };
}
const REPORT = { generatedAt: '2026-10-15T17:00:00.000Z', lastSyncedAt: '2026-10-15T17:00:00.000Z', lastSyncedByName: 'Anderson', totalShopifyVariants: 6, totalRentalUnitsLinked: 4, divergences: [] };

test('action: ADMIN sincroniza, recebe o relatório e a vitrine/painel são invalidados (inclui /pecas e /closetadmin/pecas)', async () => {
  const { actions, log } = loadActions({ syncImpl: async () => REPORT });
  const result = await actions.syncCatalogAction();
  assert.equal(result.error, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.report.totalShopifyVariants, 6);
  assert.equal(log.sync, 1);
  assert.deepEqual(log.roleChecks, ['ADMIN']);
  for (const path of ['/', '/pecas', '/pecas/[handle]', '/closetadmin/pecas']) assert.ok(log.revalidated.includes(path), path);
});

test('action: quem não é ADMIN é barrado ANTES de qualquer chamada ao servidor (nada é sincronizado nem invalidado)', async () => {
  const { actions, log } = loadActions({ role: 'STAFF', syncImpl: async () => REPORT });
  await assert.rejects(actions.syncCatalogAction(), /REDIRECT/);
  assert.equal(log.sync, 0);
  assert.deepEqual(log.revalidated, []);
});

test('action: erro do servidor mantém a mensagem e NÃO é "timeout"; sem invalidar cache', async () => {
  const { actions, log } = loadActions({ syncImpl: async () => { throw new AdminApiError(503, 'A Shopify não retornou nenhuma variante; sincronização abortada por segurança.'); } });
  const result = await actions.syncCatalogAction();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { error: 'A Shopify não retornou nenhuma variante; sincronização abortada por segurança.', report: null, timedOut: false });
  assert.deepEqual(log.revalidated, []);
});

test('action: 504 vira "pode ter concluído" (timedOut), nunca falha definitiva; erro inesperado vira mensagem genérica', async () => {
  const t = loadActions({ syncImpl: async () => { throw new AdminApiError(504, 'O servidor do ClosetAdmin demorou demais para responder.'); } });
  const timedOut = await t.actions.syncCatalogAction();
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.report, null);
  assert.match(timedOut.error, /pode ter sido concluída no servidor/);
  assert.deepEqual(t.log.revalidated, []);

  const u = loadActions({ syncImpl: async () => { throw new TypeError('boom interno com detalhes'); } });
  const unexpected = await u.actions.syncCatalogAction();
  assert.equal(unexpected.error, 'Não foi possível sincronizar o catálogo.');
  assert.equal(unexpected.timedOut, false);
  assert.equal(/boom/.test(JSON.stringify(unexpected)), false, 'detalhe interno não vaza');
});

test('action de releitura: SOMENTE LEITURA — exige módulo PIECES (não ADMIN), nunca sincroniza nem invalida cache', async () => {
  const ok = loadActions({ role: 'STAFF', reportImpl: async () => REPORT });
  const result = await ok.actions.fetchCatalogSyncReportAction();
  assert.deepEqual([result.error, result.report.totalShopifyVariants], [null, 6]);
  assert.deepEqual(ok.log.moduleChecks, ['PIECES']);
  assert.deepEqual(ok.log.roleChecks, []);
  assert.equal(ok.log.sync, 0);
  assert.deepEqual(ok.log.revalidated, []);

  const fail = loadActions({ reportImpl: async () => { throw new AdminApiError(503, 'Integração Shopify Admin não configurada no servidor.'); } });
  assert.deepEqual(JSON.parse(JSON.stringify(await fail.actions.fetchCatalogSyncReportAction())), { error: 'Integração Shopify Admin não configurada no servidor.', report: null });
});

test('regras preservadas: o painel não cadastra peças e as actions de cadastro/edição seguem exigindo ADMIN', () => {
  const panel = read('src/app/closetadmin/(protected)/pecas/CatalogSyncPanel.tsx');
  assert.equal(/importShopifyUnitsAction|updatePieceAction/.test(panel), false, 'o painel não cria nem edita peça');
  const actions = read('src/app/closetadmin/(protected)/pecas/actions.ts');
  for (const name of ['updatePieceAction', 'importShopifyUnitsAction', 'syncCatalogAction']) {
    const body = actions.slice(actions.indexOf(`export async function ${name}`));
    assert.ok(body.slice(0, 400).includes("requireAdminRole(session, 'ADMIN')"), name);
  }
});

// ── estrutura do painel: o que a pessoa vê e quando ─────────────────────────────────────────
test('painel: nunca some (a página sempre o renderiza, com o erro do relatório) e só ADMIN vê o botão', () => {
  const page = read('src/app/closetadmin/(protected)/pecas/page.tsx');
  assert.match(page, /<CatalogSyncPanel initialReport=\{syncReport\} initialError=\{syncError\} catalog=\{catalog\} isAdmin=\{isAdmin\} \/>/);
  assert.equal(/syncReport \? <CatalogSyncPanel/.test(page), false, 'o painel não pode depender de o relatório ter carregado');
  const panel = read('src/app/closetadmin/(protected)/pecas/CatalogSyncPanel.tsx');
  assert.match(panel, /\{isAdmin \? \(\s*<button\s+type="button"\s+data-testid="sync-button"/);
});

test('painel: carregamento visível, sucesso com horário/variantes/peças, erro com "Tentar novamente" e estado incerto sem falha definitiva', () => {
  const panel = read('src/app/closetadmin/(protected)/pecas/CatalogSyncPanel.tsx');
  for (const id of ['sync-loading', 'sync-success', 'sync-error', 'sync-retry', 'sync-uncertain', 'sync-check-again', 'sync-load-error', 'sync-load-retry', 'sync-awaiting', 'sync-last']) {
    assert.ok(panel.includes(`data-testid="${id}"`), id);
  }
  assert.match(panel, /Sincronizando com a Shopify…/);
  assert.match(panel, /Não feche nem recarregue a página\./);
  assert.match(panel, /summarizeSync\(result\.report, formatTime\(/);
  // erro e falha são anunciados a leitores de tela; carregamento e sucesso como status
  assert.match(panel, /data-testid="sync-error"\s+role="alert"/);
  assert.match(panel, /data-testid="sync-loading"\s+role="status"/);
  // timeout/queda de rede: confere o estado em vez de declarar falha
  assert.match(panel, /classifySyncFailure\(result\) === 'error'/);
  assert.match(panel, /looksCompletedAfterUncertain\(previous, check\.report, startedAt\)/);
  assert.match(panel, /catch \{\s*\/\/ A plataforma pode encerrar a função/);
});

test('painel: inventário físico é só informação ("não é divergência", estoque da Shopify não conta) e a mensagem de "sem divergências" não promete mais que o verificado', () => {
  const panel = read('src/app/closetadmin/(protected)/pecas/CatalogSyncPanel.tsx');
  assert.match(panel, /ainda sem inventário físico/);
  assert.match(panel, /não é divergência/);
  assert.match(panel, /o estoque da Shopify não conta/);
  assert.match(panel, /Nenhuma divergência nas peças físicas já cadastradas\./);
  assert.equal(panel.includes('peças físicas e catálogo Shopify batem'), false);
  assert.match(panel, /isValePassProduct\(\{ productId: item\.product\.id, variantId: item\.id \}\)/);
  // as variantes sem peça não entram na lista de divergências
  assert.equal(/awaiting\.map\(.*divergen/i.test(panel), false);
});
