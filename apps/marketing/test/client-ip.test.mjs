import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// IP repassado pelo servidor do site no login (o TS real, transpilado).
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const load = (file, extra = {}) => {
  const exports = {};
  runInNewContext(
    ts.transpileModule(readFileSync(new URL(file, root), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
    }).outputText,
    { exports, process: { env: {} }, ...extra },
  );
  return exports;
};
const { clientIpFromHeaders } = load('src/lib/client-ip.ts');
const h = (entries) => ({ get: (name) => entries[name] ?? null });
const ON_VERCEL = { VERCEL: '1' };
const LOCAL = {};

test('fora da Vercel NENHUM cabeçalho de IP é repassado (quem escreve é o navegador)', () => {
  for (const headers of [{ 'x-real-ip': '203.0.113.9' }, { 'x-forwarded-for': '203.0.113.9' }, { 'x-vercel-forwarded-for': '203.0.113.9' }]) {
    assert.equal(clientIpFromHeaders(h(headers), LOCAL), null);
  }
  assert.equal(clientIpFromHeaders(h({ 'x-real-ip': '203.0.113.9' }), { VERCEL: '0' }), null);
});

test('na Vercel: x-vercel-forwarded-for primeiro, depois x-real-ip, depois x-forwarded-for', () => {
  assert.equal(clientIpFromHeaders(h({ 'x-vercel-forwarded-for': '198.51.100.1', 'x-real-ip': '203.0.113.9' }), ON_VERCEL), '198.51.100.1');
  assert.equal(clientIpFromHeaders(h({ 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '10.0.0.1' }), ON_VERCEL), '203.0.113.9');
  assert.equal(clientIpFromHeaders(h({ 'x-forwarded-for': '2001:db8::1' }), ON_VERCEL), '2001:db8::1');
});

test('vários IPs no mesmo cabeçalho: só o primeiro (o cliente, segundo a Vercel)', () => {
  assert.equal(clientIpFromHeaders(h({ 'x-vercel-forwarded-for': '198.51.100.1, 10.0.0.1, 10.0.0.2' }), ON_VERCEL), '198.51.100.1');
});

test('valor forjado/lixo nunca é repassado, nem na Vercel', () => {
  for (const bad of ["'; DROP TABLE x;--", 'localhost', 'x'.repeat(60), '', '1.2.3.4\r\nX-Evil: 1', ', 203.0.113.9']) {
    assert.equal(clientIpFromHeaders(h({ 'x-vercel-forwarded-for': bad }), ON_VERCEL), null, bad);
  }
  assert.equal(clientIpFromHeaders(h({}), ON_VERCEL), null);
});
