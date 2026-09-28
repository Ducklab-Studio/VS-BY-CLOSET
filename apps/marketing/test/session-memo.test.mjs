import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Memória de sessão por requisição (o TS real, transpilado).
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const exports = {};
runInNewContext(
  ts.transpileModule(readFileSync(new URL('src/lib/session-memo.ts', root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText,
  { exports, Map },
);
const { createSessionMemo } = exports;

test('dois usuários na mesma memória: cada token recebe a PRÓPRIA sessão', async () => {
  const calls = [];
  const memo = createSessionMemo(async (token) => (calls.push(token), { id: `user-de-${token}` }));
  const [a, b, a2] = await Promise.all([memo('token-maria'), memo('token-joao'), memo('token-maria')]);
  assert.deepEqual(a, { id: 'user-de-token-maria' });
  assert.deepEqual(b, { id: 'user-de-token-joao' });
  assert.equal(a2, a); // mesma requisição, mesmo token: reaproveita
  assert.deepEqual(calls, ['token-maria', 'token-joao']); // uma validação por token
});

test('memórias diferentes (requisições diferentes) nunca compartilham resultado', async () => {
  let n = 0;
  const validate = async (token) => ({ token, validation: ++n });
  const first = await createSessionMemo(validate)('token-x');
  const second = await createSessionMemo(validate)('token-x');
  assert.notEqual(first, second);
  assert.equal(second.validation, 2);
});

test('admin-session.ts: memória só por requisição (cache do React), sem estado de módulo', () => {
  const src = readFileSync(new URL('src/lib/admin-session.ts', root), 'utf8');
  assert.match(src, /import \{ cache \} from 'react'/);
  assert.match(src, /cache\(\(\) =>\s*\n?\s*createSessionMemo\(/);
  // Nada guardado no escopo do módulo que atravesse requisições.
  assert.doesNotMatch(src, /^(let|var) /m);
  assert.doesNotMatch(src, /^const \w+ = new (Map|WeakMap|Set)\b/m);
  // O token é lido do cookie em TODA chamada, nunca guardado.
  assert.match(src, /export async function getAdminSession\(\)[\s\S]*?cookies\(\)[\s\S]*?sessionMemoForRequest\(\)\(token\)/);
});
