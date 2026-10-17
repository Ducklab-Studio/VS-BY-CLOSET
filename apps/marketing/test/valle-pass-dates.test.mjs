import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Datas de validade dos vouchers no ClosetAdmin: o dia mostrado vem do fuso comercial PROVISÓRIO (America/Sao_Paulo), nunca do fuso do
// navegador ou do servidor. O TS real é transpilado e executado em processos Node com TZ diferentes.
const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const js = ts.transpileModule(readFileSync(new URL('src/lib/valle-pass-dates.ts', root), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

/** Executa `body` (que usa as funções do módulo) num processo com o TZ pedido e devolve o JSON impresso. */
function inZone(tz, body) {
  const code = `const mod = (() => { const exports = {}; ${js}\nreturn exports; })();\nconst { formatVoucherFirstDay, formatVoucherLastDay } = mod;\nconsole.log(JSON.stringify((() => { ${body} })()));`;
  const run = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

// Janela do Valle Pass 2027 como a API a grava em America/Sao_Paulo (UTC−3): 01/01/2027 00:00 → 01/01/2028 00:00.
const FROM = '2027-01-01T03:00:00.000Z';
const EXPIRES = '2028-01-01T03:00:00.000Z';
const ZONES = ['UTC', 'America/Sao_Paulo', 'America/Santiago', 'Pacific/Auckland', 'Asia/Kolkata'];

test('a data final aparece como 31/12/2027 e a inicial como 01/01/2027, em QUALQUER fuso do navegador/servidor', () => {
  for (const tz of ZONES) {
    const out = inZone(tz, `return [formatVoucherFirstDay('${FROM}'), formatVoucherLastDay('${EXPIRES}')];`);
    assert.deepEqual(out, ['01/01/2027', '31/12/2027'], `TZ=${tz}`);
  }
});

test('controle: sem fuso explícito o erro original reaparece (01/01/2028 em UTC) — o teste enxerga o defeito', () => {
  const raw = (tz) => inZone(tz, `return new Date(new Date('${EXPIRES}').getTime() - 1).toLocaleDateString('pt-BR');`);
  assert.equal(raw('UTC'), '01/01/2028');
  assert.equal(raw('America/Sao_Paulo'), '31/12/2027');
});

test('fronteiras do período: o último instante válido ainda é o último dia; o instante exato do vencimento já é o dia seguinte', () => {
  for (const tz of ZONES) {
    const out = inZone(
      tz,
      `return [
        formatVoucherFirstDay('2027-01-01T02:59:59.999Z'),
        formatVoucherFirstDay('2027-01-01T03:00:00.000Z'),
        formatVoucherLastDay('2028-01-01T03:00:00.000Z'),
        formatVoucherLastDay('2028-01-01T03:00:00.001Z'),
        formatVoucherLastDay('2027-12-31T03:00:00.000Z'),
      ];`,
    );
    assert.deepEqual(out, ['31/12/2026', '01/01/2027', '31/12/2027', '01/01/2028', '30/12/2027'], `TZ=${tz}`);
  }
});

test('fim do ano bissexto e virada de mês em UTC−3', () => {
  const out = inZone('UTC', `return [formatVoucherLastDay('2028-03-01T03:00:00.000Z'), formatVoucherLastDay('2027-03-01T03:00:00.000Z'), formatVoucherFirstDay('2028-02-29T03:00:00.000Z')];`);
  assert.deepEqual(out, ['29/02/2028', '28/02/2027', '29/02/2028']);
});

test('mudança de horário (se o fuso comercial passar a ter verão): dia de 25 horas e dia que começa à 01:00', () => {
  for (const tz of ['UTC', 'America/Sao_Paulo', 'Pacific/Auckland']) {
    const out = inZone(
      tz,
      `const S = 'America/Santiago';
       return [
         // Chile, 03/04/2027: o verão termina à 24:00 (o dia tem 25 horas). Vence às 00:00 de 04/04 (UTC−4) = 04:00Z.
         formatVoucherLastDay('2027-04-04T04:00:00.000Z', S),
         formatVoucherLastDay('2027-04-04T03:00:00.000Z', S),
         // Chile, 05/09/2027: o verão começa à 24:00 de 04/09; o dia 05 começa à 01:00 (UTC−3) = 04:00Z.
         formatVoucherFirstDay('2027-09-05T04:00:00.000Z', S),
         formatVoucherFirstDay('2027-09-05T03:59:59.999Z', S),
       ];`,
    );
    assert.deepEqual(out, ['03/04/2027', '03/04/2027', '05/09/2027', '04/09/2027'], `TZ=${tz}`);
  }
});

test('o painel usa as funções (não o fuso do aparelho) e não toca na regra de expiração nem no resgate', () => {
  const section = readFileSync(new URL('src/app/closetadmin/(protected)/valle-pass/ValePassSection.tsx', root), 'utf8');
  assert.match(section, /formatVoucherFirstDay\(voucher\.validFrom\)/);
  assert.match(section, /formatVoucherLastDay\(voucher\.expiresAt\)/);
  assert.doesNotMatch(section, /getTime\(\) - 1\)\.toISOString\(\)/); // o cálculo antigo, dependente do aparelho, saiu
});
