import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Modelo de benefícios do Valle Pass 2027 sugerido no ClosetAdmin: textos aprovados, códigos/valores/lógica preservados e aceito pela validação REAL da API.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
function load(url) {
  const js = ts.transpileModule(readFileSync(url, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', js)(mod, mod.exports);
  return mod.exports;
}
const { VALLE_PASS_2027_PRESET: preset } = load(new URL('src/lib/valle-pass-benefits-preset.ts', root));
const { validateBenefits } = load(new URL('../reservations-api/src/vale-pass/vale-pass-benefits.ts', root));

test('códigos internos, tipos, empresas, valores e ordem estão preservados', () => {
  assert.deepEqual(
    preset.map((b) => [b.code, b.kind, b.company ?? null, b.amountCents ?? null, b.discountPercent ?? null, b.sortOrder]),
    [
      ['valle_showroom_500', 'VOUCHER', 'VALLE_SHOWROOM', 50_000, null, 0],
      ['vs_by_closet_50', 'VOUCHER', 'VS_BY_CLOSET', 5_000, null, 1],
      ['desconto_passeios', 'DISCOUNT', null, null, 10, 2],
    ],
  );
});

test('textos aprovados', () => {
  assert.deepEqual(
    preset.map((b) => b.label),
    ['Voucher Valle Showroom', 'Voucher VS BY CLOSET', '10% de desconto em passeios e transfers — benefício informativo, sujeito às condições oficiais'],
  );
  for (const benefit of preset) assert.ok(benefit.label.length <= 120, 'limite do rótulo na API');
});

test('o desconto é só informativo: sem valor em reais, sem empresa e SEM texto de condições (ainda pendentes do Anderson)', () => {
  const discount = preset.find((b) => b.code === 'desconto_passeios');
  assert.equal(discount.kind, 'DISCOUNT');
  assert.equal(discount.amountCents, undefined);
  assert.equal(discount.company, undefined);
  assert.equal(discount.terms, undefined);
});

test('nenhum texto antigo ou condição inventada sobrou', () => {
  const all = JSON.stringify(preset);
  assert.ok(!/elegíveis/i.test(all));
  assert.ok(!/Condições a definir/i.test(all));
  assert.ok(!/gratuit|transfer[ií]vel|reembols|validade/i.test(all), 'sem regras comerciais não aprovadas');
});

test('um voucher por empresa e a validação real da API aceita o modelo', () => {
  const vouchers = preset.filter((b) => b.kind === 'VOUCHER');
  assert.equal(vouchers.length, 2);
  assert.equal(new Set(vouchers.map((b) => b.company)).size, 2);
  assert.deepEqual(validateBenefits(preset), []);
});
