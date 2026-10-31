import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Estrutura da página de termos do Valle Pass (rascunho): não publicada por padrão, sem cláusulas inventadas e pronta para o texto oficial.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const exports = {};
runInNewContext(
  ts.transpileModule(readFileSync(new URL('src/lib/vale-pass-terms-draft.ts', root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText,
  { exports, process: { env: {} } },
);
const { TERMS_APPROVED, TERMS_SECTIONS, DRAFT_NOTICE, termsPageEnabled } = exports;
const page = readFileSync(new URL('src/app/termos-valle-pass/page.tsx', root), 'utf8');

test('a página só existe com VALE_PASS_TERMS_PAGE=on; ausente, vazio ou qualquer outro valor mantém 404', () => {
  assert.equal(termsPageEnabled({}), false);
  assert.equal(termsPageEnabled({ VALE_PASS_TERMS_PAGE: '' }), false);
  assert.equal(termsPageEnabled({ VALE_PASS_TERMS_PAGE: 'true' }), false);
  assert.equal(termsPageEnabled({ VALE_PASS_TERMS_PAGE: 'off' }), false);
  assert.equal(termsPageEnabled({ VALE_PASS_TERMS_PAGE: 'on' }), true);
  assert.equal(termsPageEnabled({ VALE_PASS_TERMS_PAGE: ' ON ' }), true);
  assert.match(page, /if \(!termsPageEnabled\(\)\) notFound\(\);/);
  assert.match(page, /export const dynamic = 'force-dynamic'/);
});

test('nunca indexada e marcada como rascunho enquanto o texto oficial não for aprovado', () => {
  assert.equal(TERMS_APPROVED, false);
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  assert.match(page, /data-testid="valle-pass-terms-draft-notice"/);
  assert.match(DRAFT_NOTICE, /não é um contrato/);
  assert.match(DRAFT_NOTICE, /não deve ser divulgada/);
});

test('cobre as 11 seções pedidas, nesta ordem: descrição, valor, benefícios, empresas, período, condições, saldo/resgate, reembolso, limitações, atendimento e dados pessoais', () => {
  assert.equal(
    JSON.stringify(TERMS_SECTIONS.map((s) => s.id)),
    JSON.stringify(['descricao', 'valor', 'beneficios', 'empresas', 'periodo', 'condicoes', 'saldo-resgate', 'reembolso', 'limitacoes', 'atendimento', 'dados-pessoais']),
  );
  // reembolso e limitações NUNCA trazem cláusula inventada: só o aviso de que serão preenchidos com o texto oficial
  for (const id of ['reembolso', 'limitacoes']) assert.equal(TERMS_SECTIONS.find((s) => s.id === id).confirmed.length, 0, id);
  assert.match(TERMS_SECTIONS.find((s) => s.id === 'limitacoes').pending.join(' '), /não estabelece nenhuma limitação/);
  for (const section of TERMS_SECTIONS) assert.ok(section.pending.length > 0 || section.confirmed.length > 0, section.id);
});

test('só afirma fatos já confirmados; reembolso/desistência não tem nenhuma condição, só o aviso de que será preenchido com o texto oficial', () => {
  const refund = TERMS_SECTIONS.find((s) => s.id === 'reembolso');
  assert.equal(refund.confirmed.length, 0);
  assert.match(refund.pending.join(' '), /não estabelece nenhuma condição de reembolso/);
  const confirmed = TERMS_SECTIONS.flatMap((s) => s.confirmed).join(' ');
  assert.match(confirmed, /intransferíveis/);
  assert.match(confirmed, /R\$ 350,00/);
  assert.match(confirmed, /R\$ 500,00/);
  assert.match(confirmed, /R\$ 50,00/);
});

test('não inventa cláusulas: nenhum prazo, multa, percentual, data ou política de desistência no texto', () => {
  const all = JSON.stringify(TERMS_SECTIONS) + DRAFT_NOTICE;
  assert.doesNotMatch(all, /sete dias|7 dias|\b\d+ dias\b|multa|reembolso integral|reembolso parcial|direito de arrependimento|30\/09|31\/05|2027-09|\b\d{2}\/\d{2}\/\d{4}\b/i);
  assert.doesNotMatch(all, /\b\d+ ?%/); // nem o percentual do desconto: a condição é "em definição"
  assert.doesNotMatch(JSON.stringify(TERMS_SECTIONS.flatMap((s) => s.confirmed)), /Anderson|jurídico/); // fato confirmado não depende de decisão
});

test('o que ainda depende de decisão fica em "Em definição" e a página separa as duas listas sem apresentar rascunho como contrato', () => {
  const pending = TERMS_SECTIONS.flatMap((s) => s.pending).join(' ');
  for (const topic of ['período de utilização', 'prorrogação', 'saldo remanescente', 'desconto informativo', 'identificação', 'dados específicos', 'perda do código']) assert.match(pending, new RegExp(topic, 'i'));
  assert.match(page, /Já confirmado/);
  assert.match(page, /politica-de-privacidade/); // a seção de dados remete à política de privacidade que já existe no site
  assert.match(page, /Em definição/);
  assert.doesNotMatch(page, /Aceito os termos|Li e concordo|checkbox/i);
});

test('a página não está ligada à vitrine: o link dos termos continua vindo só de NEXT_PUBLIC_VALE_PASS_TERMS_URL (ausente = sem link)', () => {
  const termsLib = readFileSync(new URL('src/lib/vale-pass-terms.ts', root), 'utf8');
  assert.match(termsLib, /NEXT_PUBLIC_VALE_PASS_TERMS_URL/);
  const code = termsLib.split(/\r?\n/).filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line)).join(' ');
  assert.doesNotMatch(code, /termos-valle-pass/); // nenhum link embutido no código (só comentário de instrução)
  const presentation = readFileSync(new URL('src/components/ValePassPresentation.tsx', root), 'utf8');
  assert.doesNotMatch(presentation, /termos-valle-pass/);
});
