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
  assert.equal(presence.PRESENCE_IDLE_MS, 10 * 60_000);
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

test('o heartbeat do painel mantém as travas: saída por beacon, inatividade, 401 para, sem segredo no corpo', () => {
  const source = read('apps/marketing/src/components/closetadmin/PresenceHeartbeat.tsx');
  assert.match(source, /navigator\.sendBeacon\(ENDPOINT/);
  assert.match(source, /keepalive: true/); // fallback se o beacon não sair
  assert.match(source, /window\.addEventListener\('pagehide', leave\)/);
  assert.match(source, /PRESENCE_IDLE_MS/);
  assert.match(source, /res\.status === 401\) stopped = true/);
  // Aba em segundo plano NÃO é saída: visibilitychange só conta como atividade ao voltar.
  assert.doesNotMatch(source, /visibilityState === 'hidden'/);
  // O corpo só leva ação e id da aba — nunca token, sessão ou id de funcionário.
  assert.match(source, /JSON\.stringify\(\{ action, clientId \}\)/);
  assert.doesNotMatch(source, /adminUserId|token|cookie/i);

  const route = read('apps/marketing/src/app/closetadmin/presence/route.ts');
  assert.match(route, /isSameOriginRequest\(request\.headers\)/);
  assert.match(route, /\{ clientId: parsed\.clientId \}/);
  assert.doesNotMatch(route, /console\./);
});
