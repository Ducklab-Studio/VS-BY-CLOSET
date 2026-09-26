import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Presença online/offline do ClosetAdmin (lado do painel). Mesmo carregador de
// checkout-flow.test.mjs: o TS real, transpilado, sem runner novo.
const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const require = createRequire(new URL('apps/marketing/package.json', root));
const ts = require('typescript');

function load(path) {
  const exports = {};
  const code = ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  runInNewContext(code, { exports, URL, Date }, { filename: path });
  return exports;
}

const presence = load('apps/marketing/src/lib/closetadmin-presence.ts');
const headers = (map) => ({ get: (name) => map[name.toLowerCase()] ?? null });
const UUID = '3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b';

test('heartbeat bem dentro do TTL da API (90 s): cabe mais de um heartbeat perdido', () => {
  assert.equal(presence.PRESENCE_HEARTBEAT_MS, 25_000);
  assert.ok(presence.PRESENCE_HEARTBEAT_MS * 3 < 90_000);
  assert.ok(presence.PRESENCE_POLL_MS >= 10_000 && presence.PRESENCE_POLL_MS <= 15_000);
  // Não existe mais tempo de inatividade: presença não depende de mouse/teclado.
  assert.equal(presence.PRESENCE_IDLE_MS, undefined);
});

/** Aba simulada com relógio próprio: `tick()` = passar 25 s. */
function fakeTab({ status = 204, beaconOk = true } = {}) {
  const sent = [];
  let intervalFn = null;
  let intervalMs = null;
  let cleared = false;
  const state = { status };
  const heartbeat = presence.startPresenceHeartbeat({
    clientId: UUID,
    post: async (body, keepalive) => {
      sent.push({ ...JSON.parse(body), keepalive });
      return state.status;
    },
    beacon: (body) => {
      if (beaconOk) sent.push({ ...JSON.parse(body), beacon: true });
      return beaconOk;
    },
    setInterval: (fn, ms) => {
      intervalFn = fn;
      intervalMs = ms;
      return 'timer';
    },
    clearInterval: () => {
      cleared = true;
    },
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    heartbeat,
    sent,
    state,
    intervalMs: () => intervalMs,
    cleared: () => cleared,
    async tick(times = 1) {
      for (let i = 0; i < times; i++) {
        if (!cleared) intervalFn();
        await flush();
      }
    },
    flush,
  };
}

test('painel aberto mais de 10 min SEM nenhuma interação continua mandando heartbeat e nunca avisa saída', async () => {
  const tab = fakeTab();
  await tab.flush();
  assert.equal(tab.intervalMs(), 25_000);
  const ticks = Math.ceil((11 * 60_000) / 25_000); // 11 minutos parado
  await tab.tick(ticks);
  const actions = tab.sent.map((s) => s.action);
  assert.equal(actions.filter((a) => a === 'heartbeat').length, 1 + ticks); // o da abertura + um por intervalo
  assert.equal(actions.includes('leave'), false);
  assert.equal(tab.heartbeat.isStopped(), false);
  // Continua depois disso também (ex.: 1 h aberto, minimizado).
  await tab.tick(120);
  assert.equal(tab.sent.filter((s) => s.action === 'heartbeat').length, 1 + ticks + 120);
});

test('sem conexão por um tempo: continua tentando e volta sozinho (o TTL da API cuida do status nesse meio-tempo)', async () => {
  const tab = fakeTab();
  await tab.flush();
  tab.state.status = null; // rede caiu
  await tab.tick(5);
  tab.state.status = 204; // voltou
  await tab.tick(1);
  assert.equal(tab.heartbeat.isStopped(), false);
  assert.equal(tab.sent.filter((s) => s.action === 'heartbeat').length, 7);
});

test('sessão inválida (401: logout em outra aba, bloqueio, expiração) para o heartbeat de vez, sem aviso de saída', async () => {
  const tab = fakeTab({ status: 401 });
  await tab.flush();
  await tab.tick(10);
  assert.equal(tab.heartbeat.isStopped(), true);
  assert.equal(tab.sent.length, 1);
  tab.heartbeat.stop();
  assert.equal(tab.sent.some((s) => s.action === 'leave'), false);
});

test('fechar a aba avisa saída uma vez por beacon; sem beacon, cai para POST keepalive', async () => {
  const withBeacon = fakeTab();
  await withBeacon.flush();
  withBeacon.heartbeat.stop();
  withBeacon.heartbeat.stop();
  assert.deepEqual(withBeacon.sent.filter((s) => s.action === 'leave'), [{ action: 'leave', clientId: UUID, beacon: true }]);
  assert.equal(withBeacon.cleared(), true);

  const noBeacon = fakeTab({ beaconOk: false });
  await noBeacon.flush();
  noBeacon.heartbeat.leave();
  await noBeacon.flush();
  assert.deepEqual(noBeacon.sent.filter((s) => s.action === 'leave'), [{ action: 'leave', clientId: UUID, keepalive: true }]);
});

test('"visto por último" em minutos, horas e dias; nada quando nunca apareceu', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  assert.equal(presence.formatLastSeen(null, now), null);
  assert.equal(presence.formatLastSeen('lixo', now), null);
  assert.equal(presence.formatLastSeen(ago(20_000), now), 'Visto por último há menos de 1 min');
  assert.equal(presence.formatLastSeen(ago(5 * 60_000), now), 'Visto por último há 5 min');
  assert.equal(presence.formatLastSeen(ago(3 * 3_600_000), now), 'Visto por último há 3 h');
  assert.equal(presence.formatLastSeen(ago(26 * 3_600_000), now), 'Visto por último há 1 dia');
  assert.equal(presence.formatLastSeen(ago(72 * 3_600_000), now), 'Visto por último há 3 dias');
  // Relógio local um pouco atrasado não gera "há -1 min".
  assert.equal(presence.formatLastSeen(new Date(now + 30_000).toISOString(), now), 'Visto por último há menos de 1 min');
});

test('rota de presença só aceita heartbeat/saída com um id de aba — nunca id de funcionário', () => {
  assert.deepEqual({ ...presence.parsePresenceRequest(JSON.stringify({ action: 'heartbeat', clientId: UUID })) }, { action: 'heartbeat', clientId: UUID });
  assert.equal(presence.parsePresenceRequest(JSON.stringify({ action: 'leave', clientId: UUID })).action, 'leave');
  for (const bad of [
    '',
    'não é json',
    JSON.stringify({ action: 'delete', clientId: UUID }),
    JSON.stringify({ action: 'heartbeat', clientId: 'abc' }),
    JSON.stringify({ action: 'heartbeat' }),
    JSON.stringify(null),
  ]) {
    assert.equal(presence.parsePresenceRequest(bad), null, bad);
  }
  // Campos extras (ex.: adminUserId) nunca passam adiante: só action e clientId saem daqui.
  const parsed = presence.parsePresenceRequest(JSON.stringify({ action: 'heartbeat', clientId: UUID, adminUserId: 'outro' }));
  assert.deepEqual(Object.keys(parsed).sort(), ['action', 'clientId']);
});

test('só a mesma origem do painel pode chamar a rota', () => {
  assert.equal(presence.isSameOriginRequest(headers({ origin: 'https://vsbycloset.vercel.app', host: 'vsbycloset.vercel.app' })), true);
  assert.equal(presence.isSameOriginRequest(headers({ origin: 'https://vsbycloset.vercel.app', 'x-forwarded-host': 'vsbycloset.vercel.app', host: 'interno' })), true);
  assert.equal(presence.isSameOriginRequest(headers({ origin: 'https://atacante.example', host: 'vsbycloset.vercel.app' })), false);
  assert.equal(presence.isSameOriginRequest(headers({ origin: 'null', host: 'vsbycloset.vercel.app' })), false);
  assert.equal(presence.isSameOriginRequest(headers({ 'sec-fetch-site': 'same-origin', host: 'vsbycloset.vercel.app' })), true);
  assert.equal(presence.isSameOriginRequest(headers({ 'sec-fetch-site': 'cross-site', host: 'vsbycloset.vercel.app' })), false);
});

test('o componente só liga eventos do navegador: nada de mouse/teclado, nada de segundo plano como saída', () => {
  const source = read('apps/marketing/src/components/closetadmin/PresenceHeartbeat.tsx');
  assert.match(source, /startPresenceHeartbeat\(/);
  assert.match(source, /navigator\.sendBeacon\(ENDPOINT/);
  assert.match(source, /window\.addEventListener\('pagehide', onPageHide\)/);
  // Presença não depende de interação: nenhum listener de mouse/teclado/toque/rolagem.
  assert.doesNotMatch(source, /pointerdown|pointermove|mousemove|keydown|touchstart|wheel|'scroll'|IDLE|idle/i);
  // Aba minimizada/em segundo plano NÃO é saída.
  assert.doesNotMatch(source, /visibilityState === 'hidden'/);
  // O corpo só leva ação e id da aba — nunca token, sessão ou id de funcionário.
  const lib = read('apps/marketing/src/lib/closetadmin-presence.ts');
  assert.match(lib, /JSON\.stringify\(\{ action, clientId: deps\.clientId \}\)/);
  // O heartbeat não olha relógio nem inatividade: nenhuma regra de "parado há X min".
  const heartbeatFn = lib.slice(lib.indexOf('export function startPresenceHeartbeat'));
  assert.doesNotMatch(heartbeatFn, /Date\.now|performance\.now|idle|IDLE|lastInteraction/);
  assert.doesNotMatch(source, /adminUserId|token|cookie/i);

  const route = read('apps/marketing/src/app/closetadmin/presence/route.ts');
  assert.match(route, /isSameOriginRequest\(request\.headers\)/);
  assert.match(route, /\{ clientId: parsed\.clientId \}/);
  assert.doesNotMatch(route, /console\./);
});
