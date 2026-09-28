import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Id do navegador enviado no HOLD (o TS real de checkout.ts, transpilado).
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const fresh = () => {
  const exports = {};
  runInNewContext(
    ts.transpileModule(readFileSync(new URL('src/lib/checkout.ts', root), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
    }).outputText,
    { exports, process: { env: {} } },
  );
  return exports.browserId;
};
const memory = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
};
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

test('gera uma vez e reaproveita no mesmo navegador', () => {
  const browserId = fresh();
  const store = memory();
  const first = browserId(store, uuid);
  assert.equal(browserId(store, uuid), first);
});

test('navegadores diferentes → ids diferentes', () => {
  const browserId = fresh();
  assert.notEqual(browserId(memory(), uuid), browserId(memory(), uuid));
});

test('valor adulterado no armazenamento é trocado por um id válido', () => {
  const browserId = fresh();
  const store = memory();
  store.setItem('vsc_browser_id', '<script>');
  assert.match(browserId(store, uuid), /^[0-9a-f-]{36}$/);
});

test('armazenamento bloqueado: id estável durante a aba, sem erro', () => {
  const browserId = fresh();
  const blocked = { getItem: () => { throw new Error('bloqueado'); }, setItem: () => { throw new Error('bloqueado'); } };
  const a = browserId(blocked, uuid);
  assert.equal(browserId(blocked, uuid), a);
  assert.equal(browserId(null, uuid), a);
});
