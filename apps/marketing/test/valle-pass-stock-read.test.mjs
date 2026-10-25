import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Leitura do estoque da Shopify para o painel de prontidão (o TS real, transpilado): toda falha vira "desconhecido" e desconhecido nunca aprova.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const exports = {};
runInNewContext(
  ts.transpileModule(readFileSync(new URL('src/lib/valle-pass-stock-read.ts', root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText,
  { exports, Number, Promise, setTimeout, clearTimeout },
);
const { readStockEvidence, normalizeStock, STOCK_READ_TIMEOUT_MS } = exports;
const unknown = JSON.stringify({ status: 'unknown' });
const same = (value, expected) => assert.equal(JSON.stringify(value), JSON.stringify(expected));

test('respostas claras da Shopify passam como estão: fechada, à venda com quantidade e à venda sem quantidade', async () => {
  same(await readStockEvidence(async () => ({ status: 'sold_out' })), { status: 'sold_out' });
  same(await readStockEvidence(async () => ({ status: 'available', quantity: 100 })), { status: 'available', quantity: 100 });
  same(await readStockEvidence(async () => ({ status: 'available', quantity: null })), { status: 'available', quantity: null });
  same(await readStockEvidence(async () => ({ status: 'available' })), { status: 'available', quantity: null });
});

test('falha de rede (promessa rejeitada) e exceção síncrona viram desconhecido, nunca erro nem aprovação', async () => {
  assert.equal(JSON.stringify(await readStockEvidence(() => Promise.reject(new Error('Sem resposta da Storefront API.')))), unknown);
  assert.equal(JSON.stringify(await readStockEvidence(() => { throw new Error('config'); })), unknown);
});

test('timeout: leitura lenta vira desconhecido no prazo e o temporizador não fica pendurado', async () => {
  const started = Date.now();
  const slow = () => new Promise((resolve) => setTimeout(() => resolve({ status: 'sold_out' }), 400));
  assert.equal(JSON.stringify(await readStockEvidence(slow, 30)), unknown);
  assert.ok(Date.now() - started < 300, 'respondeu no limite, sem esperar a leitura lenta');
  // Resposta rápida: o temporizador é limpo (o processo termina sem esperar o limite de 3 s).
  same(await readStockEvidence(async () => ({ status: 'sold_out' }), 60_000), { status: 'sold_out' });
  assert.equal(STOCK_READ_TIMEOUT_MS, 3000);
});

test('resposta malformada ou valor inválido é desconhecido (nunca vira zero nem esgotada)', async () => {
  for (const bad of [undefined, null, 0, 'sold_out', [], {}, { status: 'esgotado' }, { status: 'available', quantity: -1 }, { status: 'available', quantity: 1.5 }, { status: 'available', quantity: '10' }, { status: 'available', quantity: Number.NaN }]) {
    assert.equal(JSON.stringify(normalizeStock(bad)), unknown, JSON.stringify(bad));
    assert.equal(JSON.stringify(await readStockEvidence(async () => bad)), unknown, `via leitura: ${JSON.stringify(bad)}`);
  }
});

test('variante ausente na resposta da Shopify (nó nulo/inexistente) é desconhecida', async () => {
  assert.equal(JSON.stringify(await readStockEvidence(async () => new Map().get('gid://shopify/ProductVariant/1'))), unknown);
});

test('segurança: o helper não usa credencial privada, escrita nem rede própria (só recebe a função de leitura)', () => {
  const source = readFileSync(new URL('src/lib/valle-pass-stock-read.ts', root), 'utf8');
  assert.doesNotMatch(source, /fetch\(|process\.env|SHOPIFY_CLIENT_SECRET|mutation|inventory/i);
  const page = readFileSync(new URL('src/app/closetadmin/(protected)/valle-pass/page.tsx', root), 'utf8');
  assert.match(page, /readStockEvidence\(async \(\) => \(await fetchVariantStock\(\[gid\]\)\)\.get\(gid\)\)/);
});
