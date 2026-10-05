import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Login do ClosetAdmin: telefone como a pessoa digita/cola e separação entre
// "credencial errada" e "site sem permissão na API". Mesmo carregador de
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
  runInNewContext(code, { exports }, { filename: path });
  return exports;
}

const phone = load('apps/marketing/src/lib/closetadmin-phone.ts');
const errors = load('apps/marketing/src/app/closetadmin/login/login-errors.ts');
// Mesma normalização do reservations-api (admin-phone.ts): o que importa é
// o número que chega lá.
const sent = ({ code, national }) => `+${code}${national.replace(/\D/g, '')}`;

test('celular brasileiro digitado com Chile (padrão) selecionado troca pra +55 em vez de cortar dígitos', () => {
  let state = { code: '56', national: '' };
  for (const digit of '11987654321') state = phone.resolvePhoneInput(state.national + digit, state.code);
  assert.equal(state.code, '55');
  assert.equal(state.national, '11 98765-4321');
  assert.equal(sent(state), '+5511987654321');
});

test('número colado com DDI, com ou sem formatação, vira o país certo', () => {
  for (const pasted of ['+55 11 98765-4321', '+55 (11) 98765 4321', '+5511987654321', '5511987654321']) {
    const result = phone.resolvePhoneInput(pasted, '56');
    assert.equal(sent(result), '+5511987654321', pasted);
  }
  assert.equal(sent(phone.resolvePhoneInput('+56 9 1234 5678', '55')), '+56912345678');
  assert.equal(sent(phone.resolvePhoneInput('56912345678', '56')), '+56912345678');
});

test('número do tamanho do país selecionado não muda de país', () => {
  assert.deepEqual({ ...phone.resolvePhoneInput('912345678', '56') }, { code: '56', national: '9 1234 5678' });
  assert.deepEqual({ ...phone.resolvePhoneInput('(11) 98765-4321', '55') }, { code: '55', national: '11 98765-4321' });
});

test('DDI de um valor composto', () => {
  assert.equal(phone.countryCodeOf('+55 11 98765-4321'), '55');
  assert.equal(phone.countryCodeOf('+56'), '56');
  assert.equal(phone.countryCodeOf('+1 555'), null);
  assert.equal(phone.countryCodeOf(''), null);
});

test('só o 401 do próprio login vira "credencial errada"; o 401 do token do site é configuração', () => {
  assert.equal(errors.CREDENTIALS_REJECTED_MESSAGE, 'Credenciais inválidas.');
  assert.equal(errors.classifyLoginFailure(401, 'Credenciais inválidas.'), 'credentials');
  assert.equal(errors.classifyLoginFailure(401, 'Credencial administrativa inválida ou ausente.'), 'misconfigured');
  assert.equal(errors.classifyLoginFailure(503, 'Endpoint administrativo não configurado.'), 'misconfigured');
  assert.equal(errors.classifyLoginFailure(503, 'ClosetAdmin não está configurado (ADMIN_API_TOKEN ausente).'), 'misconfigured');
  assert.equal(errors.classifyLoginFailure(503, 'Não foi possível conectar ao servidor do ClosetAdmin.'), 'unavailable');
  assert.equal(errors.classifyLoginFailure(400, 'pin must match'), 'credentials');
  assert.equal(errors.classifyLoginFailure(429, 'ThrottlerException: Too Many Requests'), 'rate_limited');
});

test('falhas da API: fora do ar x erro interno x configuração x limite, sempre sem login', () => {
  for (const status of [404, 408, 502, 503, 504]) assert.equal(errors.classifyLoginFailure(status, 'Application not found'), 'unavailable', String(status));
  for (const status of [500, 501, 418]) assert.equal(errors.classifyLoginFailure(status, 'Internal server error'), 'internal', String(status));
  assert.equal(errors.classifyLoginFailure(403, 'Forbidden'), 'misconfigured');
  assert.equal(errors.classifyLoginFailure(429, 'x'), 'rate_limited');
  assert.equal(errors.classifyLoginFailure(401, 'Application not found'), 'misconfigured', 'qualquer 401 que não seja o do login NUNCA é credencial errada');
});

test('resposta de sucesso do login só vale com token e validade futura legíveis', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const ok = { token: 'a'.repeat(64), expiresAt: '2026-10-06T00:00:00Z' };
  assert.equal(errors.isValidLoginResponse(ok, now), true);
  for (const bad of [null, undefined, '', '<html>proxy</html>', 42, {}, { token: 'curto', expiresAt: ok.expiresAt }, { token: ok.token }, { token: ok.token, expiresAt: 'ontem' }, { token: ok.token, expiresAt: '2026-10-04T00:00:00Z' }, { token: 7, expiresAt: ok.expiresAt }, { token: 'a'.repeat(600), expiresAt: ok.expiresAt }]) {
    assert.equal(errors.isValidLoginResponse(bad, now), false, JSON.stringify(bad));
  }
});

test('sessão: só o 401 da própria validação é "expirada"; o resto é painel sem resposta; o aviso vem de lista fechada', () => {
  assert.equal(errors.classifySessionLoss(401, 'Sessão inválida ou expirada.'), 'expired');
  for (const [status, message] of [[401, 'Credencial administrativa inválida ou ausente.'], [503, 'Não foi possível validar a sessão no momento.'], [404, 'Application not found'], [500, 'x'], [503, 'Não foi possível conectar ao servidor do ClosetAdmin.']]) {
    assert.equal(errors.classifySessionLoss(status, message), 'unavailable', `${status} ${message}`);
  }
  assert.equal(errors.parseSessionNotice('expirada'), 'expired');
  assert.equal(errors.parseSessionNotice('indisponivel'), 'unavailable');
  assert.equal(errors.parseSessionNotice(['expirada', 'x']), 'expired');
  for (const bad of [undefined, '', 'EXPIRADA', '<script>alert(1)</script>', 'expirada ', 'qualquer coisa', 'javascript:1']) assert.equal(errors.parseSessionNotice(bad), null, String(bad));
  assert.equal(new Set(Object.values(errors.SESSION_NOTICE_MESSAGES)).size, 2);
});

test('mensagens de login não revelam se o usuário existe nem expõem detalhes internos', () => {
  const messages = Object.values(errors.LOGIN_FAILURE_MESSAGES);
  assert.equal(new Set(messages).size, messages.length);
  for (const message of messages) {
    assert.doesNotMatch(message, /ADMIN_API_TOKEN|token|n[ãa]o existe|n[ãa]o encontrad|bloquead|inativ|401|503/i, message);
  }
  assert.equal(errors.LOGIN_FAILURE_MESSAGES.credentials, 'Nome, telefone ou PIN incorretos.');
});

test('a tela de login mantém as travas: sem duplo envio, PIN oculto por padrão, log sem segredo', () => {
  const form = read('apps/marketing/src/app/closetadmin/login/LoginForm.tsx');
  assert.match(form, /disabled=\{pending\}/);
  assert.match(form, /inFlight\.current\) event\.preventDefault\(\)/);
  assert.match(form, /type=\{showPin \? 'text' : 'password'\}/);
  assert.match(form, /const \[showPin, setShowPin\] = useState\(false\)/);

  const action = read('apps/marketing/src/app/closetadmin/login/actions.ts');
  assert.match(action, /classifyLoginFailure\(err\.status, err\.message\)/);
  assert.doesNotMatch(action, /console\.\w+\([^)]*(pin|phone|token\(\)|process\.env)/i);
});
