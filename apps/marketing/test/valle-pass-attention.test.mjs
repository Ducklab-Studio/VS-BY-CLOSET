import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Contador do Valle Pass no menu (o TS real, transpilado): texto do badge e
// ciclo de atualização, com relógio e rede simulados.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const exports = {};
runInNewContext(
  ts.transpileModule(readFileSync(new URL('src/lib/valle-pass-attention.ts', root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText,
  { exports, Number, Math, String, Promise },
);
const { attentionBadgeText, attentionLabel, startAttentionPoller, VALLE_PASS_ATTENTION_POLL_MS } = exports;

test('badge oculto sem pedido para ver (zero, ainda não carregado ou inválido)', () => {
  assert.equal(attentionBadgeText(0), null);
  assert.equal(attentionBadgeText(null), null);
  assert.equal(attentionBadgeText(-1), null);
  assert.equal(attentionBadgeText(Number.NaN), null);
  assert.equal(attentionLabel(0), 'nenhum pedido novo');
});

test('badge mostra 1, a quantidade exata para vários, e 99+ acima disso', () => {
  assert.equal(attentionBadgeText(1), '1');
  assert.equal(attentionBadgeText(7), '7');
  assert.equal(attentionBadgeText(99), '99');
  assert.equal(attentionBadgeText(150), '99+');
  assert.equal(attentionLabel(1), '1 pedido para ver');
  assert.equal(attentionLabel(3), '3 pedidos para ver');
  assert.equal(attentionLabel(150), 'mais de 99 pedidos para ver');
});

/** Aba simulada: `tick()` = passar um intervalo; respostas em fila. */
function fakeTab(responses, { visible = true } = {}) {
  const states = [];
  let calls = 0;
  let intervalFn = null;
  let intervalMs = null;
  let cleared = false;
  const tab = {
    visible,
    states,
    get calls() { return calls; },
    get intervalMs() { return intervalMs; },
    get cleared() { return cleared; },
    tick: async () => { intervalFn(); await new Promise((r) => setImmediate(r)); },
  };
  tab.poller = startAttentionPoller({
    fetchCount: async () => {
      calls++;
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    isVisible: () => tab.visible,
    setInterval: (fn, ms) => ((intervalFn = fn), (intervalMs = ms), 'timer'),
    clearInterval: () => (cleared = true),
    onChange: (state) => states.push(state),
  });
  return tab;
}
const settle = () => new Promise((r) => setImmediate(r));
/** Objetos criados dentro do `vm` têm outro protótipo: compara só os dados. */
const last = (tab) => JSON.parse(JSON.stringify(tab.states.at(-1)));

test('pergunta na abertura e a cada 30 s com a aba visível; atualiza sem recarregar', async () => {
  const tab = fakeTab([{ count: 0 }, { count: 1 }, { count: 3 }]);
  await settle();
  assert.equal(tab.intervalMs, VALLE_PASS_ATTENTION_POLL_MS);
  assert.equal(VALLE_PASS_ATTENTION_POLL_MS, 30_000);
  assert.deepEqual(last(tab), { count: 0, stale: false, stopped: false });
  await tab.tick();
  assert.equal(tab.states.at(-1).count, 1);
  await tab.tick();
  assert.equal(tab.states.at(-1).count, 3);
  assert.equal(tab.calls, 3);
});

test('aba em segundo plano não pergunta; ao voltar, `refresh` pergunta na hora', async () => {
  const tab = fakeTab([{ count: 2 }, { count: 5 }], { visible: false });
  await settle(); // a abertura sempre pergunta
  await tab.tick();
  await tab.tick();
  assert.equal(tab.calls, 1);
  tab.visible = true;
  await tab.poller.refresh();
  assert.equal(tab.states.at(-1).count, 5);
});

test('mesma contagem não gera atualização repetida; perguntas simultâneas viram uma só', async () => {
  const tab = fakeTab([{ count: 2 }, { count: 2 }, { count: 2 }]);
  await settle();
  await Promise.all([tab.poller.refresh(), tab.poller.refresh(), tab.poller.refresh()]);
  await tab.tick();
  assert.equal(tab.states.length, 1);
  assert.equal(tab.calls, 3);
});

test('falha de rede ou da API: mantém o último número, esmaecido, e se recupera', async () => {
  const tab = fakeTab([{ count: 4 }, { error: true }, new Error('offline'), { count: 1 }]);
  await settle();
  await tab.tick();
  assert.deepEqual(last(tab), { count: 4, stale: true, stopped: false });
  await tab.tick();
  assert.deepEqual(last(tab), { count: 4, stale: true, stopped: false });
  await tab.tick();
  assert.deepEqual(last(tab), { count: 1, stale: false, stopped: false });
});

test('falha antes de carregar qualquer valor: sem badge (fallback vazio)', async () => {
  const tab = fakeTab([{ error: true }]);
  await settle();
  assert.deepEqual(last(tab), { count: null, stale: true, stopped: false });
  assert.equal(attentionBadgeText(tab.states.at(-1).count), null);
});

test('sem permissão ou sem sessão: esconde o badge e para de perguntar', async () => {
  const tab = fakeTab([{ count: 3 }, { forbidden: true }, { count: 9 }]);
  await settle();
  await tab.tick();
  assert.deepEqual(last(tab), { count: null, stale: false, stopped: true });
  assert.equal(tab.cleared, true);
  await tab.poller.refresh();
  assert.equal(tab.calls, 2);
});
