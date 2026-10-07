import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Cliente da disponibilidade (o TS real, transpilado): a resposta só vale se for
// válida e completa; erro, prazo, JSON ruim e dia faltando NUNCA viram data livre
// nem data ocupada. Sem rede: o `fetch` é injetado.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const source = ts.transpileModule(readFileSync(new URL('src/lib/availability-client.ts', root), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText;
const lib = {};
runInNewContext(source, {
  exports: lib, Object, Number, String, Array, Map, Set, Date, JSON, Math, Promise, RegExp, URL, AbortController, setTimeout, clearTimeout, fetch: undefined,
});
const { parseAvailability, fetchAvailability, datesBetween, isIsoDate, availabilityFailureMessage } = lib;
const plain = (value) => JSON.parse(JSON.stringify(value));

const VARIANT = 'gid://shopify/ProductVariant/1';
const query = { variantId: VARIANT, countedPieces: 1, from: '2026-11-01', to: '2026-11-07' };
const ORIGIN = 'http://127.0.0.1:3000';

const freeDay = (date, extra = {}) => ({ date, bookable: true, quantityAvailable: 1, reason: null, durationDays: 2, calculatedReturnDate: '2026-11-30', hasSundayReturnException: false, returnOptions: [], ...extra });
const busyDay = (date, reason = 'no_units_available', extra = {}) => ({ date, bookable: false, quantityAvailable: 0, reason, ...extra });
const week = datesBetween(query.from, query.to);
const goodBody = (mutate) => {
  const body = {
    shopifyVariantId: VARIANT, countedPieces: 1, unitsTotal: 1, operationStartDate: null, maxPieces: 6,
    days: week.map((d, i) => (i % 2 === 0 ? freeDay(d) : busyDay(d))),
  };
  return mutate ? mutate(body) ?? body : body;
};

const reply = (status, body, { text } = {}) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (text !== undefined ? text : typeof body === 'string' ? body : JSON.stringify(body)),
});
const run = (fetchImpl, extra = {}) => fetchAvailability(query, { base: '/api/availability', origin: ORIGIN, fetchImpl, retryDelayMs: 1, ...extra });

test('datas: formato, calendário real e intervalo', () => {
  assert.equal(isIsoDate('2026-02-28'), true);
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('2026-2-3'), false);
  assert.equal(isIsoDate(20260101), false);
  assert.deepEqual(plain(datesBetween('2026-11-29', '2026-12-02')), ['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
  assert.deepEqual(plain(datesBetween('2026-12-02', '2026-11-29')), []);
  assert.deepEqual(plain(datesBetween('x', '2026-11-29')), []);
  assert.equal(datesBetween('2026-01-01', '2026-01-01').length, 1);
});

test('resposta normal: dias livres e ocupados exatamente como a API mandou, só campos conhecidos', () => {
  const body = goodBody((b) => { b.days[1].unavailableReason = 'reserved'; b.days[1].unavailableReasons = ['reserved', 'preparation']; b.days[0].segredo = 'maria@example.com'; b.extra = 'x'; });
  const data = parseAvailability(body, query);
  assert.ok(data);
  assert.deepEqual(plain(data.days.map((d) => d.bookable)), [true, false, true, false, true, false, true]);
  assert.equal(data.days[1].unavailableReason, 'reserved');
  assert.deepEqual(plain(data.days[1].unavailableReasons), ['reserved', 'preparation']);
  assert.equal(JSON.stringify(data).includes('maria@example.com'), false, 'campo desconhecido não passa');
  assert.equal('extra' in data, false);
  assert.equal(data.maxPieces, 6);
  assert.equal(data.operationStartDate, null);
});

test('motivos reais continuam chegando: reserva, HOLD, preparação, bloqueio operacional e domingo', () => {
  const reasons = [['reserved'], ['held'], ['preparation'], ['operational_block']];
  const body = goodBody((b) => {
    b.days = week.map((d, i) => (i < 4 ? busyDay(d, 'no_units_available', { unavailableReason: reasons[i][0], unavailableReasons: reasons[i] }) : i === 4 ? busyDay(d, 'pickup_is_sunday') : freeDay(d)));
  });
  const data = parseAvailability(body, query);
  assert.deepEqual(plain(data.days.slice(0, 4).map((d) => d.unavailableReason)), ['reserved', 'held', 'preparation', 'operational_block']);
  assert.equal(data.days[4].reason, 'pickup_is_sunday');
  assert.equal(data.days[4].bookable, false);
});

test('devolução no domingo: as duas opções chegam, com a disponibilidade de cada uma', () => {
  const sunday = freeDay('2026-11-03', { hasSundayReturnException: true, returnOptions: [{ type: 'saturday', date: '2026-11-07', window: 'até 20h', available: true }, { type: 'mondayMorning', date: '2026-11-09', available: false }] });
  const body = goodBody((b) => { b.days[2] = sunday; });
  const data = parseAvailability(body, query);
  assert.deepEqual(plain(data.days[2].returnOptions), [{ type: 'saturday', date: '2026-11-07', window: 'até 20h', available: true }, { type: 'mondayMorning', date: '2026-11-09', available: false }]);
  // exceção de domingo sem nenhuma opção: não dá para reservar com segurança
  assert.equal(parseAvailability(goodBody((b) => { b.days[2] = freeDay('2026-11-03', { hasSundayReturnException: true, returnOptions: [] }); }), query), null);
});

test('fora do contrato é INVÁLIDO (nunca vira data livre ou ocupada)', () => {
  const bad = {
    'corpo vazio {}': {},
    'lista': [],
    'null': null,
    'texto': 'ok',
    'sem days': { shopifyVariantId: VARIANT, countedPieces: 1 },
    'days não é lista': { shopifyVariantId: VARIANT, countedPieces: 1, days: 'x' },
    'days vazio num intervalo com datas': { shopifyVariantId: VARIANT, countedPieces: 1, days: [] },
    'variante de outra peça': goodBody((b) => { b.shopifyVariantId = 'gid://shopify/ProductVariant/2'; }),
    'quantidade de peças diferente': goodBody((b) => { b.countedPieces = 2; }),
    'falta um dia': goodBody((b) => { b.days.pop(); }),
    'dia repetido': goodBody((b) => { b.days[1] = { ...b.days[0] }; }),
    'data impossível': goodBody((b) => { b.days[0].date = '2026-02-30'; }),
    'bookable não booleano': goodBody((b) => { b.days[0].bookable = 'true'; }),
    'quantidade negativa': goodBody((b) => { b.days[0].quantityAvailable = -1; }),
    'dia livre sem devolução calculada': goodBody((b) => { delete b.days[0].calculatedReturnDate; }),
    'dia livre sem duração': goodBody((b) => { delete b.days[0].durationDays; }),
    'opção de devolução desconhecida': goodBody((b) => { b.days[0].returnOptions = [{ type: 'terca', date: '2026-11-04', available: true }]; }),
    'motivo que não é texto': goodBody((b) => { b.days[1].unavailableReason = 5; }),
    'operationStartDate inválida': goodBody((b) => { b.operationStartDate = '31/11/2026'; }),
    'maxPieces zero': goodBody((b) => { b.maxPieces = 0; }),
  };
  for (const [name, body] of Object.entries(bad)) assert.equal(parseAvailability(body, query), null, name);
});

test('dias fora do intervalo pedido são ignorados, não derrubam a resposta', () => {
  const body = goodBody((b) => { b.days.unshift(freeDay('2026-10-31')); b.days.push(freeDay('2026-11-08')); });
  const data = parseAvailability(body, query);
  assert.equal(data.days.length, 7);
  assert.equal(data.days[0].date, '2026-11-01');
});

test('dias vêm em ordem do calendário mesmo que a API mande fora de ordem', () => {
  const body = goodBody((b) => { b.days.reverse(); });
  assert.deepEqual(plain(parseAvailability(body, query).days.map((d) => d.date)), plain(week));
});

test('rede: sem conexão → "network" (e não "ocupado")', async () => {
  const result = await run(async () => { throw new TypeError('Failed to fetch'); }, { retries: 0 });
  assert.deepEqual(plain(result), { ok: false, failure: 'network' });
});

test('HTTP 404, 500, 503: falha "http" com o status; 401/403/429 também', async () => {
  for (const status of [401, 403, 404, 422, 429, 500, 503]) {
    const result = await run(reply(status, { message: 'x' }), { retries: 0 });
    assert.deepEqual(plain(result), { ok: false, failure: 'http', status }, String(status));
  }
});

test('2xx com corpo vazio, não-JSON ou fora do contrato → "invalid"', async () => {
  for (const [name, impl] of [
    ['vazio', reply(200, '', { text: '' })],
    ['só espaços', reply(200, '', { text: '  \n ' })],
    ['HTML', reply(200, '', { text: '<html>Bad gateway</html>' })],
    ['JSON truncado', reply(200, '', { text: '{"days":[{"date":' })],
    ['objeto vazio', reply(200, {})],
    ['lista', reply(200, [])],
    ['dia faltando', reply(200, goodBody((b) => { b.days.pop(); }))],
  ]) {
    const result = await run(impl, { retries: 0 });
    assert.equal(result.ok, false, name);
    assert.equal(result.failure, 'invalid', name);
  }
});

test('prazo: resposta que nunca chega → "timeout" (e a consulta é abortada)', async () => {
  let aborted = false;
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }));
  const started = Date.now();
  const result = await run(hang, { timeoutMs: 40, retries: 0 });
  assert.deepEqual(plain(result), { ok: false, failure: 'timeout' });
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 1000);
});

test('prazo também vale para o corpo que nunca termina de chegar', async () => {
  const slowBody = (url, init) => Promise.resolve({ ok: true, status: 200, text: () => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  const result = await run(slowBody, { timeoutMs: 40, retries: 0 });
  assert.deepEqual(plain(result), { ok: false, failure: 'timeout' });
});

test('cancelar (troca de mês/peça) → "aborted", sem esperar o prazo e sem nova tentativa', async () => {
  const controller = new AbortController();
  let calls = 0;
  const hang = (url, init) => { calls++; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))); };
  const pending = run(hang, { signal: controller.signal, timeoutMs: 5000, retries: 3 });
  setTimeout(() => controller.abort(), 20);
  assert.deepEqual(plain(await pending), { ok: false, failure: 'aborted' });
  assert.equal(calls, 1);
  // já cancelada antes de começar: nem chama a rede
  let touched = false;
  assert.deepEqual(plain(await run(async () => { touched = true; }, { signal: controller.signal })), { ok: false, failure: 'aborted' });
  assert.equal(touched, false);
});

test('cancelar durante a espera da nova tentativa também para tudo', async () => {
  const controller = new AbortController();
  let calls = 0;
  const impl = async () => { calls++; setTimeout(() => controller.abort(), 5); throw new TypeError('Failed to fetch'); };
  const result = await run(impl, { signal: controller.signal, retries: 2, retryDelayMs: 500 });
  assert.deepEqual(plain(result), { ok: false, failure: 'aborted' });
  assert.equal(calls, 1);
});

test('nova tentativa só para falha transitória: rede, prazo, 502/503/504 — uma vez', async () => {
  for (const [name, first] of [
    ['rede', async () => { throw new TypeError('x'); }],
    ['503', reply(503, { message: 'x' })],
    ['502', reply(502, { message: 'x' })],
    ['504', reply(504, { message: 'x' })],
  ]) {
    let calls = 0;
    const impl = (...args) => { calls++; return calls === 1 ? first(...args) : reply(200, goodBody())(...args); };
    const result = await run(impl, { retries: 1 });
    assert.equal(result.ok, true, name);
    assert.equal(calls, 2, name);
  }
  // falhando de novo: para na segunda, sem laço
  let calls = 0;
  const result = await run(async () => { calls++; throw new TypeError('x'); }, { retries: 1 });
  assert.equal(result.failure, 'network');
  assert.equal(calls, 2);
});

test('sem nova tentativa para 404, 422, 429, 500, resposta inválida ou configuração', async () => {
  for (const impl of [reply(404, {}), reply(422, {}), reply(429, {}), reply(500, {}), reply(200, {}), reply(200, '', { text: '' })]) {
    let calls = 0;
    const counted = (...args) => { calls++; return impl(...args); };
    const result = await run(counted, { retries: 3 });
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
  }
});

test('a consulta leva exatamente os parâmetros pedidos (sem credencial) e não usa cache', async () => {
  let seen;
  await run(async (url, init) => { seen = { url: new URL(url), init }; return reply(200, goodBody())(); });
  assert.equal(seen.url.origin + seen.url.pathname, `${ORIGIN}/api/availability`);
  assert.deepEqual(Object.fromEntries(seen.url.searchParams), { shopifyVariantId: VARIANT, countedPieces: '1', from: '2026-11-01', to: '2026-11-07' });
  assert.equal(seen.init.cache, 'no-store');
  assert.deepEqual(plain(seen.init.headers), { Accept: 'application/json' });
});

test('datas enviadas são as do calendário (YYYY-MM-DD), sem converter por fuso', async () => {
  let seen;
  await fetchAvailability({ ...query, from: '2026-12-31', to: '2026-12-31' }, { base: '/api/availability', origin: ORIGIN, retries: 0, fetchImpl: async (url) => { seen = new URL(url); return reply(200, { shopifyVariantId: VARIANT, countedPieces: 1, unitsTotal: 1, days: [freeDay('2026-12-31')] })(); } });
  assert.equal(seen.searchParams.get('from'), '2026-12-31');
  assert.equal(seen.searchParams.get('to'), '2026-12-31');
});

test('URL configurada inválida → "config" (não fica carregando para sempre), sem chamar a rede', async () => {
  for (const base of ['http://', 'ftp://exemplo.com/availability', 'javascript:alert(1)']) {
    let touched = false;
    const result = await fetchAvailability(query, { base, origin: ORIGIN, retries: 0, fetchImpl: async () => { touched = true; } });
    assert.deepEqual(plain(result), { ok: false, failure: 'config' }, base);
    assert.equal(touched, false);
  }
});

test('URL pública que falha por rede/CORS cai UMA vez no proxy do site; o proxy também falhando é falha', async () => {
  const urls = [];
  const impl = async (url) => {
    urls.push(new URL(url).origin + new URL(url).pathname);
    if (new URL(url).origin === 'https://api.exemplo.com') throw new TypeError('Failed to fetch (CORS)');
    return reply(200, goodBody())();
  };
  const ok = await fetchAvailability(query, { base: 'https://api.exemplo.com/availability', fallbackBase: '/api/availability', origin: ORIGIN, retries: 0, fetchImpl: impl });
  assert.equal(ok.ok, true);
  assert.deepEqual(urls, ['https://api.exemplo.com/availability', `${ORIGIN}/api/availability`]);

  urls.length = 0;
  const down = await fetchAvailability(query, { base: 'https://api.exemplo.com/availability', fallbackBase: '/api/availability', origin: ORIGIN, retries: 0, fetchImpl: async (url) => { urls.push(String(url)); throw new TypeError('x'); } });
  assert.equal(down.ok, false);
  assert.equal(urls.length, 2, 'uma tentativa na URL pública e uma no proxy');

  // com nova tentativa ligada: rede/CORS na URL pública NÃO repete — vai direto ao proxy (1 + 1 consultas)
  urls.length = 0;
  const viaFallback = await fetchAvailability(query, { base: 'https://api.exemplo.com/availability', fallbackBase: '/api/availability', origin: ORIGIN, retries: 1, retryDelayMs: 1, fetchImpl: impl });
  assert.equal(viaFallback.ok, true);
  assert.deepEqual(urls, ['https://api.exemplo.com/availability', `${ORIGIN}/api/availability`]);

  // erro HTTP da URL pública NÃO cai no proxy (a API respondeu; não é problema de rede)
  urls.length = 0;
  const http = await fetchAvailability(query, { base: 'https://api.exemplo.com/availability', fallbackBase: '/api/availability', origin: ORIGIN, retries: 0, fetchImpl: async (url) => { urls.push(String(url)); return reply(500, {})(); } });
  assert.deepEqual(plain(http), { ok: false, failure: 'http', status: 500 });
  assert.equal(urls.length, 1);
});

test('mensagens: cada falha tem um texto claro e nenhuma diz que a data está ocupada', () => {
  for (const failure of ['network', 'timeout', 'http', 'invalid', 'config']) {
    const text = availabilityFailureMessage(failure);
    assert.ok(text.length > 20, failure);
    assert.equal(/ocupad|indispon/i.test(text), false, failure);
  }
  assert.notEqual(availabilityFailureMessage('timeout'), availabilityFailureMessage('network'));
});

test('mensagem por status: 502/503 = não conectou, 504 = demorou, o resto = resposta inesperada', () => {
  assert.equal(availabilityFailureMessage('http', 502), availabilityFailureMessage('network'));
  assert.equal(availabilityFailureMessage('http', 503), availabilityFailureMessage('network'));
  assert.equal(availabilityFailureMessage('http', 504), availabilityFailureMessage('timeout'));
  for (const status of [400, 401, 403, 404, 422, 429, 500]) assert.equal(availabilityFailureMessage('http', status), availabilityFailureMessage('invalid'), String(status));
});
