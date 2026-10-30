import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Benefícios SIMBÓLICOS da campanha de TESTE do Valle Pass: valores exatos, isolamento por ID da campanha + Variant ID (nome/preço não bastam), modelo oficial
// intacto, aceito pela validação REAL da API e travas também no servidor (actions.ts) e na tela.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
function load(url) {
  const js = ts.transpileModule(readFileSync(url, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', js)(mod, mod.exports);
  return mod.exports;
}
const T = load(new URL('src/lib/valle-pass-test-benefits.ts', root));
const { VALLE_PASS_2027_PRESET: official } = load(new URL('src/lib/valle-pass-benefits-preset.ts', root));
const { validateBenefits } = load(new URL('../reservations-api/src/vale-pass/vale-pass-benefits.ts', root));
const source = (path) => readFileSync(new URL(path, root), 'utf8').replace(/\r\n/g, '\n');
const actions = source('src/app/closetadmin/(protected)/valle-pass/actions.ts');
const panel = source('src/app/closetadmin/(protected)/valle-pass/HoldsAndBenefits.tsx');
const management = source('src/app/closetadmin/(protected)/valle-pass/CampaignManagement.tsx');
const balance = source('src/app/closetadmin/(protected)/valle-pass/BalanceDesk.tsx');

const OFFICIAL_CAMPAIGN = { id: '01ce04c2-dd85-4fb4-bf08-de446e8280aa', shopifyVariantId: '49174518595684' };

test('os dois vouchers de teste: códigos, empresas, valores simbólicos, condição exata e SEM o desconto de 10%', () => {
  assert.deepEqual(
    T.VALLE_PASS_TEST_PRESET.map((b) => [b.code, b.kind, b.company, b.amountCents, b.discountPercent ?? null, b.terms]),
    [
      ['teste_showroom', 'VOUCHER', 'VALLE_SHOWROOM', 500, null, 'Voucher de teste, sem valor comercial'],
      ['teste_closet', 'VOUCHER', 'VS_BY_CLOSET', 50, null, 'Voucher de teste, sem valor comercial'],
    ],
  );
  assert.equal(T.VALLE_PASS_TEST_PRESET.length, 2);
  assert.ok(T.VALLE_PASS_TEST_PRESET.every((b) => b.kind === 'VOUCHER' && b.discountPercent == null));
});

test('o rótulo marca TESTE e "sem valor comercial" (é o que o operador vê na consulta de saldo e o cliente vê no e-mail)', () => {
  for (const benefit of T.VALLE_PASS_TEST_PRESET) {
    assert.ok(benefit.label.startsWith('TESTE — '), benefit.label);
    assert.ok(/sem valor comercial/.test(benefit.label), benefit.label);
    assert.ok(benefit.label.length <= 120, 'limite do rótulo na API');
    assert.equal(T.isTestBenefitLabel(benefit.label), true);
  }
  for (const benefit of official) assert.equal(T.isTestBenefitLabel(benefit.label), false, `o rótulo oficial "${benefit.label}" não pode parecer de teste`);
  assert.equal(T.isTestBenefitLabel(null), false);
});

test('a validação REAL da API aceita o modelo de teste (um voucher por empresa, valores válidos)', () => {
  assert.deepEqual(validateBenefits(T.VALLE_PASS_TEST_PRESET), []);
});

test('isolamento: só a campanha com o ID E a variante exatos; nome ou preço parecidos NÃO bastam; a oficial nunca', () => {
  assert.equal(T.isTestCampaign({ id: T.TEST_CAMPAIGN_ID, shopifyVariantId: '67916371165284' }), true);
  assert.equal(T.isTestCampaign({ id: T.TEST_CAMPAIGN_ID, shopifyVariantId: 'gid://shopify/ProductVariant/67916371165284' }), true, 'GID e número são a mesma variante');
  assert.equal(T.isTestCampaign({ id: T.TEST_CAMPAIGN_ID, shopifyVariantId: '49174518595684' }), false, 'ID certo, variante errada');
  assert.equal(T.isTestCampaign({ id: T.TEST_CAMPAIGN_ID, shopifyVariantId: null }), false);
  assert.equal(T.isTestCampaign({ id: 'f6f16b3b-2ed0-4e8b-9420-e856adc1bf94', shopifyVariantId: '67916371165284' }), false, 'variante certa, ID errado');
  assert.equal(T.isTestCampaign({ id: crypto.randomUUID(), shopifyVariantId: '67916371165284' }), false);
  assert.equal(T.isTestCampaign(OFFICIAL_CAMPAIGN), false);
  assert.equal(T.isTestCampaign({ ...OFFICIAL_CAMPAIGN, name: 'VALLE PASS TESTE', amountCents: 10 }), false, 'nome e preço não são garantia');
  assert.equal(T.TEST_CAMPAIGN_VARIANT_ID, '67916371165284');
});

test('o modelo OFICIAL continua intacto e nunca é confundido com o de teste (e vice-versa)', () => {
  assert.deepEqual(
    official.map((b) => [b.code, b.amountCents ?? null]),
    [['valle_showroom_500', 50_000], ['vs_by_closet_50', 5_000], ['desconto_passeios', null]],
  );
  assert.equal(T.isTestPreset(official), false);
  assert.equal(T.touchesTestBenefits(official), false);
  assert.equal(T.isTestPreset(T.VALLE_PASS_TEST_PRESET), true);
  assert.equal(T.touchesTestBenefits(T.VALLE_PASS_TEST_PRESET), true);
  // adulterar um valor, adicionar o desconto ou trocar a condição deixa de ser o modelo de teste
  assert.equal(T.isTestPreset([{ ...T.VALLE_PASS_TEST_PRESET[0], amountCents: 50_000 }, T.VALLE_PASS_TEST_PRESET[1]]), false);
  assert.equal(T.isTestPreset([...T.VALLE_PASS_TEST_PRESET, official[2]]), false);
  assert.equal(T.isTestPreset([{ ...T.VALLE_PASS_TEST_PRESET[0], terms: 'outra' }, T.VALLE_PASS_TEST_PRESET[1]]), false);
  // qualquer lista que use códigos de teste conta como uso do modelo de teste (recusada fora da campanha de teste)
  assert.equal(T.touchesTestBenefits([{ code: 'teste_qualquer', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'x', amountCents: 1 }]), true);
});

test('servidor: a ação de cadastro exige ADMIN, o ID da campanha, a variante e ZERO benefícios existentes; só envia o modelo de teste', () => {
  const body = /export async function registerTestBenefitsAction[\s\S]*?\n}\n/.exec(actions)?.[0] ?? '';
  assert.ok(body.length > 0, 'ação ausente');
  assert.ok(body.includes("requireAdminModule(session, 'VALLE_PASS')") && body.includes("requireAdminRole(session, 'ADMIN')"));
  assert.ok(body.includes('campaignId !== TEST_CAMPAIGN_ID'), 'trava do ID da campanha');
  assert.ok(body.includes('isTestCampaign(campaign)'), 'trava do ID + variante lidos da API');
  assert.ok(/capacity\.benefits\.length > 0/.test(body) && /nada foi alterado/.test(body), 'não regrava benefícios existentes');
  assert.ok(body.includes('replaceValePassBenefits(campaignId, VALLE_PASS_TEST_PRESET, session.id)'), 'envia só o modelo de teste');
  assert.ok(!/VALLE_PASS_2027_PRESET/.test(body));
});

test('servidor: a ação genérica recusa o modelo de teste fora da campanha de teste e qualquer modelo DENTRO dela', () => {
  const body = /export async function replaceValePassBenefitsAction[\s\S]*?\n}\n/.exec(actions)?.[0] ?? '';
  assert.ok(body.includes('campaignId === TEST_CAMPAIGN_ID || touchesTestBenefits(benefits)'), 'guarda de isolamento ausente');
  assert.ok(body.indexOf('touchesTestBenefits') < body.indexOf('replaceValePassBenefits('), 'a guarda vem ANTES da chamada à API');
});

test('tela: botão oficial preservado para as demais campanhas; opção de teste só na campanha de teste, só sem benefícios, com confirmação digitada', () => {
  assert.ok(panel.includes('benefits.length === 0 && !isTestCampaign ? ('), 'o botão oficial some só na campanha de teste');
  assert.ok(panel.includes('Sugerir modelo Valle Pass 2027'), 'o botão oficial continua existindo');
  assert.ok(panel.includes('benefits.length === 0 && isTestCampaign ? ('), 'opção de teste só sem benefícios e só na campanha de teste');
  assert.ok(panel.includes('Cadastrar benefícios de TESTE (R$ 5,00 + R$ 0,50)'));
  assert.ok(/typed\.trim\(\) !== TEST_CONFIRMATION_WORD/.test(panel), 'confirmação digitada exigida');
  assert.ok(panel.includes('registerTestBenefitsAction(campaignId)'));
  assert.ok(management.includes('isTestCampaign={isTestCampaign(campaign)}'), 'a decisão usa ID + variante (isTestCampaign)');
});

test('consulta de saldo: voucher de teste aparece com aviso vermelho "sem valor comercial"', () => {
  assert.ok(balance.includes('isTestBenefitLabel(view.benefitLabel)') && balance.includes('VOUCHER DE TESTE — sem valor comercial. Não aceite como crédito de cliente.'));
  assert.ok(balance.includes('data-testid="test-voucher-warning"'));
});
