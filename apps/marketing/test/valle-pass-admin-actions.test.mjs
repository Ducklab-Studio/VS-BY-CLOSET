import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

// Ações do Valle Pass no ClosetAdmin: toda ESCRITA exige o módulo VALLE_PASS e o perfil ADMIN (o backend confere de novo);
// a leitura da capacidade exige só o módulo. Guarda de fonte: reprova se uma ação nova de escrita esquecer o perfil.
const root = new URL('../', import.meta.url);
const actions = readFileSync(new URL('src/app/closetadmin/(protected)/valle-pass/actions.ts', root), 'utf8');

function body(name) {
  const start = actions.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `ação ${name} não encontrada`);
  const next = actions.indexOf('\nexport async function ', start + 10);
  return actions.slice(start, next === -1 ? undefined : next);
}

const WRITES = [
  'createValePassCampaignAction',
  'toggleValePassCampaignAction',
  'updateValePassCampaignAction',
  'createValePassLotAction',
  'updateValePassLotAction',
  'actOnValePassLotAction',
  'cancelValePassVoucherAction',
  'restoreValePassVoucherAction',
  'resolveValePassHoldAction',
  'previewValePassHoldAction',
  'issueValePassHoldAction',
  'replaceValePassBenefitsAction',
];

test('toda ação de escrita exige o módulo VALLE_PASS e o perfil ADMIN', () => {
  for (const name of WRITES) {
    const text = body(name);
    assert.match(text, /requireAdminModule\(session, 'VALLE_PASS'\)/, `${name}: sem módulo`);
    assert.match(text, /requireAdminRole\(session, 'ADMIN'\)/, `${name}: sem perfil ADMIN`);
  }
});

test('a leitura da capacidade exige só o módulo (a equipe vê, não altera)', () => {
  const text = body('getValePassCapacityAction');
  assert.match(text, /requireAdminModule\(session, 'VALLE_PASS'\)/);
  assert.doesNotMatch(text, /requireAdminRole/);
});

test('a ação de lote só aceita abrir, encerrar e cancelar', () => {
  assert.match(body('actOnValePassLotAction'), /action !== 'open' && action !== 'close' && action !== 'cancel'/);
});

test('o painel não fala com a Shopify nem altera estoque (só mostra o número recomendado)', () => {
  const component = readFileSync(new URL('src/app/closetadmin/(protected)/valle-pass/CampaignManagement.tsx', root), 'utf8');
  assert.doesNotMatch(component, /myshopify|shopify\.com|storefront|inventory|fetch\(/i);
  assert.match(component, /só mostra o número/);
  assert.match(component, /LEGADO/);
});
