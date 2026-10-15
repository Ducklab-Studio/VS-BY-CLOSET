import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Aviso "o catálogo mudou" (reservations-api → vitrine): autorização e escopo da invalidação.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const transpile = (file) =>
  ts.transpileModule(readFileSync(new URL(file, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
const lib = {};
runInNewContext(transpile('src/lib/catalog-revalidate.ts'), { exports: lib, String, Math });
const { isAuthorizedRevalidate, safeProductHandle } = lib;
const read = (file) => readFileSync(new URL(file, root), 'utf8').replace(/\r\n/g, '\n');
const SECRET = 'segredo-de-teste-com-mais-de-16';

test('só o segredo exato autoriza; vazio, curto, parecido ou ausente nunca', () => {
  assert.equal(isAuthorizedRevalidate(SECRET, SECRET), true);
  assert.equal(isAuthorizedRevalidate(` ${SECRET} `, SECRET), true, 'espaços nas pontas não importam');
  assert.equal(isAuthorizedRevalidate(SECRET + 'x', SECRET), false);
  assert.equal(isAuthorizedRevalidate(SECRET.slice(0, -1), SECRET), false);
  assert.equal(isAuthorizedRevalidate('segredo-de-teste-com-mais-de-17', SECRET), false);
  assert.equal(isAuthorizedRevalidate('', SECRET), false);
  assert.equal(isAuthorizedRevalidate(null, SECRET), false);
  assert.equal(isAuthorizedRevalidate(undefined, SECRET), false);
});

test('sem segredo configurado, ou com segredo fraco (< 16 caracteres), NINGUÉM é autorizado — nem "" contra ""', () => {
  assert.equal(isAuthorizedRevalidate('', ''), false);
  assert.equal(isAuthorizedRevalidate('abc', 'abc'), false);
  assert.equal(isAuthorizedRevalidate(SECRET, undefined), false);
  assert.equal(isAuthorizedRevalidate(SECRET, null), false);
});

test('handle: só minúsculas, dígitos e hífen viram caminho; o resto é descartado', () => {
  assert.equal(safeProductHandle('jaqueta-firenze'), 'jaqueta-firenze');
  assert.equal(safeProductHandle(' Jaqueta-Firenze '), 'jaqueta-firenze');
  for (const bad of ['../admin', 'a/b', 'a b', '-x', '', 7, null, undefined, {}, 'a'.repeat(300), 'jaqueta?x=1']) assert.equal(safeProductHandle(bad), null, String(bad));
});

test('rota: 404 sem segredo configurado, 401 com segredo errado, POST apenas, só invalida cache (não lê nem devolve dados)', () => {
  const route = read('src/app/api/revalidate-catalog/route.ts');
  assert.match(route, /export async function POST/);
  assert.equal(/export async function (GET|PUT|DELETE|PATCH)/.test(route), false);
  assert.match(route, /status: 404/);
  assert.match(route, /status: 401/);
  assert.match(route, /isAuthorizedRevalidate\(request\.headers\.get\('x-revalidate-secret'\), secret\)/);
  for (const target of ["revalidatePath('/')", "revalidatePath('/pecas')", "revalidatePath('/pecas/[handle]', 'page')"]) assert.ok(route.includes(target), target);
  assert.match(route, /revalidatePath\(`\/pecas\/\$\{handle\}`\)/);
  // nada de ler a Shopify/banco aqui, nem logar o segredo
  assert.equal(/fetch\(|console\./.test(route), false);
  // a autorização vem ANTES de qualquer invalidação
  assert.ok(route.indexOf('isAuthorizedRevalidate(') < route.indexOf("revalidatePath('/')"));
});
