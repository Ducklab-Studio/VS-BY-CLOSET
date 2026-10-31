import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Guarda: o benefício de 10% do Valle Pass 2027 é DESCRITIVO (sem código, saldo nem abatimento financeiro). Nenhum caminho de emissão, resgate, livro-razão, e-mail ou validação
 * financeira pode tratá-lo como desconto aplicável SEM que alguém atualize este teste de propósito (docs/VALLE-PASS-AUDITORIA-DESCONTO-10.md). Só a configuração do benefício, a
 * checagem de prontidão e o resumo de lotes podem citar o tipo `DISCOUNT`.
 */
const SRC = join(__dirname, '..');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
const production = walk(SRC).filter((file) => /\.ts$/.test(file) && !/\.(test|spec)\.ts$/.test(file) && !/integration|test-utils/.test(file));
const rel = (file: string) => relative(SRC, file).replace(/\\/g, '/');
const text = (file: string) => readFileSync(file, 'utf8');

describe('o desconto de 10% é só descritivo (nenhum mecanismo de aplicação existe)', () => {
  test('só estes arquivos de produção citam o tipo DISCOUNT: configuração, DTO, prontidão e resumo de lotes', () => {
    const mentioning = production.filter((file) => /['"]DISCOUNT['"]/.test(text(file))).map(rel).sort();
    expect(mentioning).toEqual([
      'vale-pass/dto/vale-pass-benefits.dto.ts',
      'vale-pass/vale-pass-benefits.service.ts',
      'vale-pass/vale-pass-benefits.ts',
      'vale-pass/vale-pass-launch-readiness.ts',
      'vale-pass/vale-pass-lots.service.ts',
    ]);
  });
  test('a emissão só considera benefícios VOUCHER; o desconto nunca gera voucher, saldo ou lançamento', () => {
    const issuance = text(join(SRC, 'vale-pass/vale-pass-issuance.service.ts'));
    expect(issuance).toMatch(/benefit\.active && benefit\.kind === 'VOUCHER'/);
    expect(issuance).not.toMatch(/DISCOUNT|discountPercent/);
  });
  test('resgate, livro-razão, e-mail e validação financeira não leem `discountPercent` (percentual): não há como abater 10% por nenhum caminho', () => {
    const offenders = production
      .filter((file) => /vale-pass\/(ledger|email|financial|flow|refunds)\//.test(rel(file)) || /vale-pass\/vale-pass-(vouchers|issuance)/.test(rel(file)))
      .filter((file) => /discountPercent/.test(text(file)))
      .map(rel);
    expect(offenders).toEqual([]);
  });
  test('o e-mail dos vouchers e a página pública não prometem os 10% enquanto não houver texto oficial aprovado', () => {
    const code = (file: string) => text(file).split('\n').filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line)).join('\n');
    const customerFacing = [
      join(SRC, 'vale-pass/email/email-template.ts'),
      join(SRC, '../../marketing/src/app/valle-pass/page.tsx'), // página pública /valle-pass
      join(SRC, '../../marketing/src/lib/vale-pass-offer.ts'), // textos da oferta (vouchers, validade, passos)
    ];
    for (const file of customerFacing) expect(code(file), file).not.toMatch(/10\s?%|desconto|passeio|transfer/i);
  });
  test('nenhum código da API ou do site cria, aplica ou lê cupom/desconto na Shopify (a integração Admin é só leitura e sem escopo de descontos)', () => {
    const offenders = production.filter((file) => /discountCodeBasic|discountAutomatic|cartDiscountCodesUpdate|priceRuleCreate|discountCodeCreate/i.test(text(file))).map(rel);
    expect(offenders).toEqual([]);
  });
});
