import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Guarda central dos caminhos da API do ClosetAdmin (o TS real, transpilado).
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const exports = {};
runInNewContext(
  ts.transpileModule(readFileSync(new URL('src/lib/admin-path.ts', root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText,
  { exports, decodeURIComponent, encodeURIComponent },
);
const { isSafeAdminPath, isUuid, pathSegment } = exports;
const ID = '3f2a8c1e-9b7d-4e21-8a5f-0c6d2e9b1a47';

test('caminhos legítimos do painel passam', () => {
  for (const path of [
    `/admin/reservations/${ID}/cancel`,
    `/admin/reservations/${ID}/pdf?adminUserId=${ID}`,
    `/admin/vale-pass/vouchers/${encodeURIComponent('VP-ABC/1')}/use`,
    '/admin/reports/period.pdf?from=2026-01-01&to=2026-01-31',
    '/admin/calendar?from=2026-10-01&to=2026-10-31',
  ]) assert.equal(isSafeAdminPath(path), true, path);
});

test('id com ../ (cru ou codificado) nunca desvia para outra rota da API', () => {
  for (const id of ['..', '../employees', '../../employees/x/purge', '%2e%2e', '%2E%2E/employees', '.', 'a\\..\\b', 'x#frag', '%E0%A4%A']) {
    assert.equal(isSafeAdminPath(`/admin/reservations/${id}/cancel`), false, id);
  }
  assert.equal(isSafeAdminPath('admin/sem-barra'), false);
});

test('id de reserva no PDF precisa ser UUID', () => {
  assert.equal(isUuid(ID), true);
  for (const id of ['', '../../reports/period.pdf?', `${ID}/../x`, `${ID}"\r\nX-Injected: 1`, '123']) assert.equal(isUuid(id), false, id);
});

test('pathSegment: id do navegador vira UM segmento — nunca muda a rota', () => {
  const route = (id) => `/admin/reservations/${pathSegment(id)}/cancel`;
  for (const id of ['../../employees/x/purge', 'abc?adminUserId=outro', 'a/b', 'x#frag', '%2e%2e', ID + '/../../reports']) {
    const path = route(id);
    const segments = path.split('?')[0].split('/');
    assert.equal(segments.length, 5, `${id} → ${path}`); // '', admin, reservations, <id>, cancel
    assert.equal(segments[4], 'cancel');
    assert.equal(path.includes('?'), false, path);
    assert.equal(isSafeAdminPath(path), true, path); // codificado, nenhum destes é mais um `..`
  }
  // `..` sozinho continua `..` depois de codificado: a guarda central recusa.
  assert.equal(isSafeAdminPath(route('..')), false);
  assert.equal(route(ID), `/admin/reservations/${ID}/cancel`);
});
