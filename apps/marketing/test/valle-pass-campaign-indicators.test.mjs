import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Indicadores do cartão/formulário da campanha do Valle Pass (o TS real, transpilado): vendidos = capacidade, validade honesta, histórico preservado.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const exports = {};
runInNewContext(
  ts.transpileModule(readFileSync(new URL('src/lib/valle-pass-campaign-indicators.ts', root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText,
  { exports, Date, Number, String },
);
const { formatIsoDay, validityIndicator, soldIndicator, editFormValidityCopy, syncCampaignWithCapacity } = exports;
const base = { validityDays: 30, voucherValidFrom: null, voucherValidUntil: null, quantityLimit: null, soldCount: 0 };
const j = (v) => JSON.parse(JSON.stringify(v));

test('datas: formata dd/mm/aaaa sem passar por fuso e recusa o que não é data (nunca inventa)', () => {
  assert.equal(formatIsoDay('2027-09-30'), '30/09/2027');
  assert.equal(formatIsoDay('2027-01-01'), '01/01/2027');
  for (const bad of [null, undefined, '', '2027-9-3', '30/09/2027', '2027-02-30', '2027-13-01', 'abc', '2027-09-30T00:00:00Z']) assert.equal(formatIsoDay(bad), null, String(bad));
});

test('campanha oficial hoje (benefícios, sem datas): "A definir" e o aviso de pagamentos retidos — nunca "30 dias"', () => {
  const v = j(validityIndicator({ ...base, benefitsCount: 3 }));
  assert.equal(v.kind, 'PENDING');
  assert.equal(v.text, 'A definir');
  assert.match(v.note, /Pagamentos ficam retidos/);
  assert.doesNotMatch(JSON.stringify(v), /30 dias/);
});

test('campanha com benefícios e datas configuradas mostra as datas oficiais', () => {
  const v = j(validityIndicator({ ...base, benefitsCount: 3, voucherValidFrom: '2026-12-01', voucherValidUntil: '2027-09-30' }));
  assert.deepEqual(v, { kind: 'FIXED_WINDOW', text: '01/12/2026 a 30/09/2027', note: null });
});

test('validade oficial confirmada pelo Anderson (27/10/2026): 01/04/2027 a 15/10/2027', () => {
  const v = j(validityIndicator({ ...base, benefitsCount: 3, voucherValidFrom: '2027-04-01', voucherValidUntil: '2027-10-15' }));
  assert.deepEqual(v, { kind: 'FIXED_WINDOW', text: '01/04/2027 a 15/10/2027', note: null });
});

test('janela incompleta ou inválida com benefícios = a definir, com aviso (o banco exige as duas datas juntas)', () => {
  for (const win of [{ voucherValidFrom: '2026-12-01', voucherValidUntil: null }, { voucherValidFrom: null, voucherValidUntil: '2027-09-30' }]) {
    const v = j(validityIndicator({ ...base, benefitsCount: 3, ...win }));
    assert.equal(v.kind, 'PENDING');
    assert.match(v.note, /Janela incompleta/);
    assert.match(v.note, /retidos/);
  }
  assert.equal(validityIndicator({ ...base, benefitsCount: 3, voucherValidFrom: '2027-02-30', voucherValidUntil: '2027-09-30' }).kind, 'PENDING');
});

test('modelo legado (sem benefícios) preserva "N dias após a compra"; datas registradas não mudam isso e são explicadas', () => {
  assert.deepEqual(j(validityIndicator({ ...base, benefitsCount: 0 })), { kind: 'LEGACY_DAYS', text: '30 dias após a compra', note: null });
  const withWindow = j(validityIndicator({ ...base, benefitsCount: 0, voucherValidFrom: '2027-01-01', voucherValidUntil: '2027-12-31' }));
  assert.equal(withWindow.kind, 'LEGACY_DAYS');
  assert.equal(withWindow.text, '30 dias após a compra');
  assert.match(withWindow.note, /não tem benefícios: a emissão usa os dias/);
});

test('API antiga (sem benefitsCount): mantém o comportamento anterior, sem afirmar nada novo', () => {
  assert.deepEqual(j(validityIndicator({ ...base })), { kind: 'LEGACY_DAYS', text: '30 dias após a compra', note: null });
});

test('vendidos: valor e limite legado; o histórico cancelado aparece à parte e a contagem não o inclui', () => {
  assert.deepEqual(j(soldIndicator({ ...base, soldCount: 0, issuedCount: 1 })), { value: '0', note: '1 unidade cancelada no histórico (1 emitida no total)' });
  assert.deepEqual(j(soldIndicator({ ...base, soldCount: 2, issuedCount: 3, quantityLimit: 10 })), { value: '2 / 10', note: '1 unidade cancelada no histórico (3 emitidas no total)' });
  assert.deepEqual(j(soldIndicator({ ...base, soldCount: 2, issuedCount: 5 })), { value: '2', note: '3 unidades canceladas no histórico (5 emitidas no total)' });
  assert.deepEqual(j(soldIndicator({ ...base, soldCount: 4, issuedCount: 4 })), { value: '4', note: null });
  assert.deepEqual(j(soldIndicator({ ...base, soldCount: 4 })), { value: '4', note: null }); // API antiga
  assert.deepEqual(j(soldIndicator({ ...base, soldCount: 4, issuedCount: 2 })), { value: '4', note: null }); // dado incoerente nunca vira nota negativa
});

test('formulário de edição: textos conforme o modelo e sem afirmar o que o sistema não faz', () => {
  const novo = j(editFormValidityCopy({ ...base, benefitsCount: 3 }));
  assert.match(novo.daysLabel, /legado \(não vale para esta campanha\)/);
  assert.match(novo.windowHint, /usa a validade fixa/);
  assert.match(novo.windowHint, /pagamentos ficam retidos/);
  assert.equal(novo.today, 'validade a definir (pagamentos retidos)');
  assert.equal(j(editFormValidityCopy({ ...base, benefitsCount: 3, voucherValidFrom: '2026-12-01', voucherValidUntil: '2027-09-30' })).today, 'validade 01/12/2026 a 30/09/2027');
  const legado = j(editFormValidityCopy({ ...base, benefitsCount: 0 }));
  assert.equal(legado.daysLabel, 'Validade em dias — usada na emissão');
  assert.match(legado.windowHint, /modelo antigo/);
  assert.equal(legado.today, '30 dias após a compra');
  for (const copy of [novo, legado]) assert.doesNotMatch(JSON.stringify(copy), /próxima etapa|nesta versão/);
});

test('sincronização com a capacidade: mesma fonte; devolve o MESMO objeto quando nada mudou e não toca em outros campos (nem na versão)', () => {
  const campaign = { ...base, id: 'c', updatedAt: '2026-10-22T21:13:32.079Z', soldCount: 1, issuedCount: 1, benefitsCount: 0 };
  const capacity = { totals: { sold: 0, issued: 1 }, benefits: [{}, {}, {}] };
  const synced = syncCampaignWithCapacity(campaign, capacity);
  assert.notEqual(synced, campaign);
  assert.deepEqual(j({ s: synced.soldCount, i: synced.issuedCount, b: synced.benefitsCount }), { s: 0, i: 1, b: 3 });
  assert.equal(synced.updatedAt, campaign.updatedAt);
  assert.equal(synced.id, 'c');
  assert.equal(syncCampaignWithCapacity(synced, capacity), synced); // sem mudança: mesma referência
  assert.equal(campaign.soldCount, 1); // entrada intacta
});

test('as telas usam os indicadores e não mostram mais "N dias" fixo nem o texto desatualizado da "próxima etapa"', () => {
  const dir = 'src/app/closetadmin/(protected)/valle-pass/';
  const section = readFileSync(new URL(`${dir}ValePassSection.tsx`, root), 'utf8');
  const manage = readFileSync(new URL(`${dir}CampaignManagement.tsx`, root), 'utf8');
  assert.match(section, /validityIndicator\(campaign\)/);
  assert.match(section, /soldIndicator\(campaign\)/);
  assert.match(section, /data-testid="campaign-validity"/);
  assert.match(section, /data-testid="campaign-sold"/);
  assert.doesNotMatch(section, /\{campaign\.validityDays\} dias/);
  assert.doesNotMatch(section, /\{campaign\.soldCount\}\s*\n?\s*\{campaign\.quantityLimit/);
  assert.match(manage, /editFormValidityCopy\(campaign\)/);
  assert.match(manage, /syncCampaignWithCapacity\(campaign, result\.capacity\)/);
  assert.doesNotMatch(manage, /\{campaign\.validityDays\} dias/);
  assert.doesNotMatch(manage, /fica registrada para a próxima etapa/);
  assert.doesNotMatch(manage, /usada na emissão atual/);
  const lib = readFileSync(new URL('src/lib/valle-pass-campaign-indicators.ts', root), 'utf8');
  assert.doesNotMatch(lib, /fetch\(|process\.env|Date\.now|new Date\(\)/); // puro: nada de relógio, rede ou ambiente
});
