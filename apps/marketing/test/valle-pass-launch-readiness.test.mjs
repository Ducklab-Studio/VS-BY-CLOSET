import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Painel "Pronta para vender?" (TS/TSX reais, transpilados): helpers puros e renderização do componente de servidor, incluindo estados de erro e dados
// ausentes. Sem rede, sem banco, sem navegador.
const root = new URL('../', import.meta.url);
const req = createRequire(new URL('package.json', root));
const ts = req('typescript');
const { renderToStaticMarkup } = req('react-dom/server');
const jsxRuntime = req('react/jsx-runtime');

function load(relPath, aliases = {}) {
  const source = readFileSync(new URL(relPath, root), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX },
  });
  const loaded = { exports: {} };
  const customRequire = (id) => {
    if (id === 'react/jsx-runtime') return jsxRuntime;
    if (id in aliases) return aliases[id];
    throw new Error(`import inesperado no painel: ${id}`);
  };
  new Function('require', 'module', 'exports', outputText)(customRequire, loaded, loaded.exports);
  return loaded.exports;
}

const helpers = load('src/lib/valle-pass-launch-readiness.ts');
const { LaunchReadinessPanel } = load('src/app/closetadmin/(protected)/valle-pass/LaunchReadinessPanel.tsx', { '@/lib/valle-pass-launch-readiness': helpers });
const { applyWebEvidence, formatGeneratedAt, groupItems, headline, shopifyStockItem } = helpers;

const LEGAL = new Set(['terms-approved', 'refund-policy', 'legal-review']);
const item = (id, group, owner, status, label, message = `${label}: mensagem`) => ({
  id, group, owner, status, label, message,
  nature: owner === 'TECNICO' ? 'TECNICO' : LEGAL.has(id) ? 'JURIDICO' : 'COMERCIAL',
  nextStep: status === 'APPROVED' ? null : `Próximo passo de ${id}`,
});
const sample = () => {
  const items = [
    item('global-limit', 'CAMPANHA', 'TECNICO', 'APPROVED', 'Capacidade global (1.000 unidades)'),
    item('valid-until', 'VALIDADE', 'ANDERSON', 'BLOCKED', 'Fim da validade configurado'),
    item('flag-two-voucher', 'INTEGRACOES', 'TECNICO', 'PENDING', 'Chave dos dois vouchers'),
    item('terms-url', 'TERMOS', 'TECNICO', 'PENDING', 'Endereço dos termos configurado'),
    item('real-purchase-test', 'INTEGRACOES', 'TECNICO', 'PENDING', 'Compra de teste real'),
    item('valid-from', 'VALIDADE', 'ANDERSON', 'PENDING', 'Início da validade'),
    item('terms-approved', 'TERMOS', 'ANDERSON', 'PENDING', 'Termos e condições aprovados'),
    item('legal-review', 'TERMOS', 'ANDERSON', 'PENDING', 'Validação jurídica das condições'),
  ];
  const n = (s, o) => items.filter((i) => i.status === s && (!o || i.owner === o)).length;
  const pack = (o) => ({ approved: n('APPROVED', o), pending: n('PENDING', o), blocked: n('BLOCKED', o) });
  return { generatedAt: '2026-10-25T02:41:00.000Z', campaign: { id: 'c1', name: 'Valle Pass 2027', active: true }, items, summary: { total: items.length, ...pack(), technical: pack('TECNICO'), anderson: pack('ANDERSON') }, readyToSell: false };
};
const render = (props) => renderToStaticMarkup(LaunchReadinessPanel(props));

test('separa os requisitos técnicos dos que dependem do Anderson, agrupados na ordem fixa', () => {
  const data = sample();
  const tech = groupItems(data.items, 'TECNICO').map((g) => g.group);
  const and = groupItems(data.items, 'ANDERSON').map((g) => g.group);
  assert.deepEqual(tech, ['CAMPANHA', 'TERMOS', 'INTEGRACOES']);
  assert.deepEqual(and, ['VALIDADE', 'TERMOS']);
  const html = render({ readiness: data, error: null });
  assert.match(html, /data-owner="TECNICO"/);
  assert.match(html, /data-owner="ANDERSON"/);
  assert.match(html, /Requisitos técnicos/);
  assert.match(html, /Dependem do Anderson/);
});

test('mostra aprovado, pendente e bloqueado, com o veredito "NÃO PRONTA" e os totais', () => {
  const html = render({ readiness: sample(), error: null });
  assert.match(html, /data-status="APPROVED"/);
  assert.match(html, /data-status="PENDING"/);
  assert.match(html, /data-status="BLOCKED"/);
  assert.match(html, /NÃO PRONTA/);
  assert.match(html, /1 aprovado\(s\), 6 pendente\(s\), 1 bloqueado\(s\)/);
  assert.match(headline(sample()), /Pronta para vender\? NÃO/);
});

test('o que o sistema não comprova nunca aparece como aprovado (decisão do Anderson, parecer jurídico, termos, compra de teste)', () => {
  const html = render({ readiness: sample(), error: null });
  for (const id of ['terms-approved', 'legal-review', 'real-purchase-test', 'valid-from']) {
    const row = html.match(new RegExp(`<li[^>]*data-item="${id}"[^>]*>`))?.[0] ?? '';
    assert.match(row, /data-status="PENDING"/, id);
  }
});

test('somente leitura: sem botão, formulário, campo, link de ação nem "use client"', () => {
  const html = render({ readiness: sample(), error: null });
  assert.doesNotMatch(html, /<button|<form|<input|<select|<textarea|<a /i);
  assert.match(html, /Somente leitura/);
  assert.match(html, /não abre vendas, não altera o estoque da Shopify e não liga chaves/);
  const source = readFileSync(new URL('src/app/closetadmin/(protected)/valle-pass/LaunchReadinessPanel.tsx', root), 'utf8');
  assert.doesNotMatch(source, /'use client'|"use client"|from '\.\/actions'|fetch\(|useState|useEffect|onClick|method=/);
});

test('estado de erro: mostra o alerta com a mensagem, abre o painel e não afirma "pronta" nem lista requisitos', () => {
  const html = render({ readiness: null, error: 'Sessão administrativa inválida.' });
  assert.match(html, /role="alert"/);
  assert.match(html, /Não foi possível carregar a prontidão: Sessão administrativa inválida\./);
  assert.match(html, /Não foi possível verificar/);
  assert.doesNotMatch(html, /data-owner=|PRONTA|aprovado\(s\)/);
  assert.match(html, /<details[^>]*\sopen/);
});

test('dados ausentes: sem prontidão e sem erro mostra "Sem dados", nunca "pronta"', () => {
  const html = render({ readiness: null, error: null });
  assert.match(html, /Sem dados de prontidão no momento/);
  assert.match(headline(null), /Sem dados/);
  assert.doesNotMatch(html, /\bPRONTA\b/);
});

test('sem campanha cadastrada: avisa e mantém os itens bloqueados visíveis', () => {
  const data = { ...sample(), campaign: null };
  const html = render({ readiness: data, error: null });
  assert.match(html, /Nenhuma campanha cadastrada\./);
});

test('endereço dos termos: só ele muda com a evidência do site; os demais itens e o veredito continuam iguais', () => {
  const data = sample();
  const without = applyWebEvidence(data, { termsHref: null });
  assert.equal(without.items.find((i) => i.id === 'terms-url').status, 'PENDING');
  assert.match(without.items.find((i) => i.id === 'terms-url').message, /NÃO configurado/);
  const withUrl = applyWebEvidence(data, { termsHref: '/termos-valle-pass' });
  const termsUrl = withUrl.items.find((i) => i.id === 'terms-url');
  assert.equal(termsUrl.status, 'APPROVED');
  assert.match(termsUrl.message, /A aprovação do texto é outro item/);
  assert.equal(withUrl.items.find((i) => i.id === 'terms-approved').status, 'PENDING');
  assert.equal(withUrl.summary.approved, data.summary.approved + 1);
  assert.equal(withUrl.summary.pending, data.summary.pending - 1);
  assert.equal(withUrl.summary.total, data.items.length);
  assert.equal(withUrl.readyToSell, false);
  assert.deepEqual(data, sample()); // a entrada não é alterada
});

test('frescor: mostra QUANDO a leitura foi feita (horário de São Paulo), avisa que não atualiza sozinha e não finge tempo real', () => {
  assert.equal(formatGeneratedAt('2026-10-25T02:41:00.000Z'), '24/10/2026 23:41');
  const html = render({ readiness: sample(), error: null });
  assert.match(html, /Leitura feita em 24\/10\/2026 23:41 \(horário de São Paulo\), ao abrir esta página\. Não atualiza sozinha: recarregue para ler de novo\./);
  assert.match(html, /o estoque da Shopify NÃO é consultado/);
  assert.doesNotMatch(html, /tempo real|ao vivo|atualizado agora/i);
});

test('frescor: horário ausente ou inválido nunca é inventado e o painel avisa para não tratar como atual', () => {
  assert.equal(formatGeneratedAt(undefined), null);
  assert.equal(formatGeneratedAt('lixo'), null);
  for (const bad of ['lixo', '', undefined]) {
    const html = render({ readiness: { ...sample(), generatedAt: bad }, error: null });
    assert.match(html, /Horário da leitura indisponível: não trate estes dados como atuais/);
    assert.doesNotMatch(html, /Leitura feita em/);
  }
  assert.equal(applyWebEvidence(sample(), { termsHref: null }).generatedAt, '2026-10-25T02:41:00.000Z'); // a evidência do site não altera o horário
});

test('natureza e próximo passo: cada item aberto mostra se é técnico, comercial ou jurídico e o que fazer; aprovado não mostra próximo passo', () => {
  const html = render({ readiness: sample(), error: null });
  assert.match(html, /data-nature="TECNICO"/);
  assert.match(html, /data-nature="COMERCIAL"/);
  assert.match(html, /data-nature="JURIDICO"/);
  assert.match(html, /Jurídico/);
  assert.match(html, /data-next-step="flag-two-voucher"/);
  assert.match(html, /Próximo passo:<\/span> Próximo passo de legal-review/);
  assert.doesNotMatch(html, /data-next-step="global-limit"/); // aprovado
});

test('o que dá para concluir sem o Anderson: só itens técnicos ainda abertos, e o aviso lembra que isso não dispensa autorização', () => {
  const data = sample();
  const without = helpers.openWithoutAnderson(data.items).map((i) => i.id).sort();
  assert.deepEqual(without, ['flag-two-voucher', 'real-purchase-test', 'terms-url']);
  assert.ok(without.every((id) => data.items.find((i) => i.id === id).owner === 'TECNICO'));
  const withAnderson = helpers.openWithAnderson(data.items).map((i) => i.id).sort();
  assert.deepEqual(withAnderson, ['legal-review', 'terms-approved', 'valid-from', 'valid-until']);
  const html = render({ readiness: data, error: null });
  assert.match(html, /data-testid="launch-readiness-split"/);
  assert.match(html, /sem esperar o Anderson<\/strong>: 3 item\(ns\) abertos/);
  assert.match(html, /Dependem dele ou do jurídico:(<!-- -->)? ?(<!-- -->)?4/);
  assert.match(html, /não dispensa a autorização expressa/);
});

const stockEntry = () => item('shopify-stock', 'LOTES_ESTOQUE', 'TECNICO', 'PENDING', 'Estoque da Shopify');
const withStock = (expected, evidence) => applyWebEvidence({ ...sample(), expectedShopifyStock: expected, items: [stockEntry()] }, { termsHref: null, shopifyStock: evidence }).items[0];

test('estoque da Shopify: só aprova com leitura real igual ao esperado; sem resposta continua pendente (nunca vira zero por falta de dado)', () => {
  const closed = withStock(0, { status: 'sold_out' });
  assert.equal(closed.status, 'APPROVED');
  assert.equal(closed.nextStep, null);
  assert.match(closed.message, /NÃO está à venda \(estoque 0\)/);
  assert.equal(withStock(100, { status: 'available', quantity: 100 }).status, 'APPROVED');
  assert.equal(withStock(0, { status: 'unknown' }).status, 'PENDING');
  assert.equal(withStock(0, undefined).status, 'PENDING');
  assert.equal(withStock(undefined, { status: 'sold_out' }).status, 'PENDING'); // API antiga: sem estoque esperado, não aprova
  assert.equal(withStock(null, { status: 'sold_out' }).status, 'PENDING');
});

test('estoque da Shopify: acima do esperado ou à venda sem quantidade conhecida BLOQUEIA; abaixo ou fechado com lote esperado fica pendente', () => {
  const above = withStock(0, { status: 'available', quantity: 5 });
  assert.equal(above.status, 'BLOCKED');
  assert.match(above.message, /acima do esperado \(0\)/);
  assert.match(above.nextStep, /Reduzir o estoque/);
  assert.equal(withStock(100, { status: 'available', quantity: 150 }).status, 'BLOCKED');
  const untracked = withStock(0, { status: 'available', quantity: null });
  assert.equal(untracked.status, 'BLOCKED');
  assert.match(untracked.message, /sem quantidade conhecida/);
  assert.equal(withStock(100, { status: 'available', quantity: 40 }).status, 'PENDING');
  assert.equal(withStock(100, { status: 'sold_out' }).status, 'PENDING');
});

test('estoque da Shopify: só o item do estoque muda; os outros itens, o horário e o veredito continuam iguais', () => {
  const data = { ...sample(), expectedShopifyStock: 0, items: [stockEntry(), ...sample().items] };
  const out = applyWebEvidence(data, { termsHref: null, shopifyStock: { status: 'sold_out' } });
  assert.equal(out.items.find((i) => i.id === 'shopify-stock').status, 'APPROVED');
  assert.deepEqual(out.items.filter((i) => i.id !== 'shopify-stock' && i.id !== 'terms-url'), data.items.filter((i) => i.id !== 'shopify-stock' && i.id !== 'terms-url'));
  assert.equal(out.generatedAt, data.generatedAt);
  assert.equal(out.readyToSell, false);
  assert.equal(out.summary.total, data.items.length);
  assert.equal(out.summary.approved, applyWebEvidence(data, { termsHref: null }).summary.approved + 1);
  assert.match(render({ readiness: out, error: null }), /data-item="shopify-stock"[^>]*data-status="APPROVED"/);
});

test('a página lê o estoque só com leitura, em paralelo e com limite de 3 s (erro/timeout = desconhecido)', () => {
  const page = readFileSync(new URL('src/app/closetadmin/(protected)/valle-pass/page.tsx', root), 'utf8');
  assert.match(page, /fetchVariantStock\(\[gid\]\)/);
  assert.match(page, /3_000/);
  assert.match(page, /Promise\.all\(\[getValePassLaunchReadiness\(session\.id\), readValePassStock\(\)\]\)/);
  assert.doesNotMatch(page, /inventory|inventorySet|mutation|Admin API|SHOPIFY_CLIENT_SECRET/i); // nada de escrita nem credencial privada
});

test('só vira "pronta" se todos os itens estiverem aprovados; lista vazia nunca é pronta', () => {
  const allOk = { ...sample(), items: sample().items.map((i) => ({ ...i, status: 'APPROVED' })) };
  assert.equal(applyWebEvidence(allOk, { termsHref: '/t' }).readyToSell, true);
  assert.equal(applyWebEvidence({ ...sample(), items: [] }, { termsHref: '/t' }).readyToSell, false);
});

test('não vaza segredos nem URLs com credenciais no HTML', () => {
  const html = render({ readiness: sample(), error: null });
  assert.doesNotMatch(html, /postgres(ql)?:\/\/|re_[A-Za-z0-9]{10,}|shpat_|whsec_|Bearer |ADMIN_API_TOKEN=/i);
});
