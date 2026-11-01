import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { approvedTerms, loadTermsAcceptanceConfig, TERMS_SHA256_PATTERN, TERMS_VERSION_PATTERN } from './terms-acceptance-config';

/**
 * Integridade do texto OFICIAL dos termos do Valle Pass 2027 (docs/termos/oficial). O hash que a API publica em `GET /public/vale-pass/terms` e que o aceite
 * assina é o SHA-256 dos BYTES do arquivo da versão. Estes testes travam: o arquivo da versão, o manifesto, a fidelidade ao documento recebido e a prontidão
 * da configuração. Não ativam nada: nenhuma variável é lida nem definida no ambiente real.
 */
const root = path.resolve(__dirname, '../../../../../docs/termos');
const officialDir = path.join(root, 'oficial');
const manifest = JSON.parse(readFileSync(path.join(officialDir, 'manifest.json'), 'utf8')) as {
  current: string;
  versions: Record<string, { file: string; sha256: string; bytes: number; published: boolean }>;
};

/** Fixado AQUI de propósito: mudar o texto e o manifesto juntos não basta; quem mudar precisa mexer neste teste (e, portanto, passar por revisão e por nova versão). */
const PINNED = { version: '2027-1', sha256: '9d1a283f1ec5c32e96aba3baeb8dd9d56c06f8447bf6a70edb6a3585a8e482ae', bytes: 7381 } as const;

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const bytesOf = (version: string) => readFileSync(path.join(officialDir, manifest.versions[version].file));

describe('texto oficial dos termos: integridade e imutabilidade da versão', () => {
  test('a versão vigente existe, o identificador e o hash têm o formato que a API aceita', () => {
    expect(manifest.current).toBe(PINNED.version);
    expect(manifest.versions[manifest.current]).toBeDefined();
    expect(TERMS_VERSION_PATTERN.test(manifest.current)).toBe(true);
    expect(TERMS_SHA256_PATTERN.test(manifest.versions[manifest.current].sha256)).toBe(true);
  });

  test.each(Object.keys(manifest.versions))('versão %s: o arquivo bate com o SHA-256 e o tamanho do manifesto', (version) => {
    const bytes = bytesOf(version);
    expect(sha(bytes)).toBe(manifest.versions[version].sha256);
    expect(bytes.length).toBe(manifest.versions[version].bytes);
  });

  test('a versão 2027-1 está fixada: qualquer alteração de conteúdo exige nova versão (2027-2…), nunca editar a 2027-1', () => {
    const bytes = bytesOf('2027-1');
    expect(sha(bytes)).toBe(PINNED.sha256);
    expect(bytes.length).toBe(PINNED.bytes);
    expect(manifest.versions['2027-1'].sha256).toBe(PINNED.sha256);
  });

  test('forma dos bytes: UTF-8 válido, sem BOM, só LF, termina com exatamente um LF e sem espaço antes dele', () => {
    const bytes = bytesOf(manifest.current);
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).not.toThrow();
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(bytes.includes(0x0d)).toBe(false);
    const text = bytes.toString('utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(/[ \t]\n$/.test(text)).toBe(false);
    expect(text.startsWith('VALLE PASS 2027\n')).toBe(true);
  });

  test('o .gitattributes impede a conversão para CRLF no checkout (o hash é dos bytes)', () => {
    const attrs = readFileSync(path.resolve(root, '../../.gitattributes'), 'utf8');
    expect(attrs).toMatch(/^docs\/termos\/oficial\/\*\s+text\s+eol=lf\s*$/m);
  });
});

describe('texto oficial dos termos: fidelidade ao documento recebido do Anderson', () => {
  const text = bytesOf('2027-1').toString('utf8');

  test('é cópia exata da Seção A do arquivo recebido (sem cortes, acréscimos ou reescrita)', () => {
    const received = path.join(root, 'TERMOS_RECEBIDOS_ANDERSON_2026-11-01.md');
    expect(existsSync(received)).toBe(true);
    const raw = readFileSync(received, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
    const start = raw.indexOf('\n---\n');
    expect(start).toBeGreaterThan(0);
    const expected = raw.slice(start + 5).replace(/^\n+/, '').replace(/\s+$/, '') + '\n';
    expect(text).toBe(expected);
  });

  test('todas as seções e cláusulas numeradas do original estão presentes e em ordem', () => {
    const ids = [
      '## 1. DO VALLE PASS', '1.1.', '1.2.', '1.3.',
      '## 2. DOS BENEFÍCIOS INCLUSOS', '2.1.', '2.2.', '2.3.',
      '## 3. DO PERÍODO DE VENDAS', '3.1.', '3.2.', '3.3.',
      '## 4. DA VALIDADE E UTILIZAÇÃO', '4.1.', '4.2.', '4.3.', '4.4.', '4.5.',
      '## 5. DA POLÍTICA DE CANCELAMENTO E REEMBOLSO', '### 5.1. Direito de arrependimento', '### 5.2. Garantia de satisfação presencial',
      '### 5.3. Condições para reembolso pela garantia presencial', 'a) O cliente compareça', 'b) Não tenha utilizado', 'c) Não tenha utilizado', 'd) Não tenha utilizado', 'e) Solicite',
      '### 5.4. Do valor e prazo de reembolso',
      '## 6. DA UTILIZAÇÃO DOS BENEFÍCIOS E NÃO REEMBOLSABILIDADE', '6.1.', '6.2.', '6.3.', '6.4.',
      '## 7. DAS DISPOSIÇÕES GERAIS', '7.1.', '7.2.', '7.3.', '7.4.', '7.5.', '7.6.',
      '## 8. DA ACEITAÇÃO DOS TERMOS', 'GRUPO VALLE',
    ];
    let from = 0;
    for (const id of ids) {
      const at = text.indexOf(id, from);
      expect(at, `ausente ou fora de ordem: ${id}`).toBeGreaterThanOrEqual(from);
      from = at;
    }
  });

  test('condições comerciais essenciais do texto autorizado, literalmente', () => {
    for (const fragment of [
      'R$ 350,00 (trezentos e cinquenta reais)', 'R$ 500,00 em crédito para aluguel de roupas de neve na Valle Showroom', 'R$ 50,00 em crédito para aluguel de roupas casuais',
      '10% de desconto nos passeios e serviços participantes', '1º de novembro de 2026', '31 de maio de 2027', 'prazo legal de 7 (sete) dias', 'artigo 49 do Código de Defesa do Consumidor',
      'reembolso integral', 'será devolvido 100% do valor efetivamente pago pelo Valle Pass, correspondente a R$ 350,00', 'até 3 (três) dias úteis',
      'A utilização de apenas um dos benefícios será suficiente para encerrar a possibilidade de reembolso voluntário',
    ]) {
      expect(text, fragment).toContain(fragment);
    }
  });
});

describe('prontidão da configuração (nada é ativado)', () => {
  const version = manifest.current;
  const sha256 = manifest.versions[version].sha256;
  const secret = 'segredo-de-teste-0123456789-abcdefghij-xyz';

  test('versão e hash do manifesto são aceitos pela configuração do backend', () => {
    const config = loadTermsAcceptanceConfig({ VALE_PASS_TERMS_ACCEPTANCE: 'on', VALE_PASS_TERMS_VERSION: version, VALE_PASS_TERMS_SHA256: sha256, VALE_PASS_TERMS_TOKEN_SECRET: secret });
    expect(approvedTerms(config)).toMatchObject({ version, sha256 });
  });

  test('versão + hash + segredo SEM a chave de ativação não aprovam nada e não exigem aceite', () => {
    const config = loadTermsAcceptanceConfig({ VALE_PASS_TERMS_VERSION: version, VALE_PASS_TERMS_SHA256: sha256, VALE_PASS_TERMS_TOKEN_SECRET: secret });
    expect(approvedTerms(config)).toBeNull();
    expect(config.enabled).toBe(false);
    expect(config.required).toBe(false);
  });

  test('ativação ligada NÃO liga a exigência: retenção por falta de aceite só com VALE_PASS_TERMS_REQUIRED=on', () => {
    const config = loadTermsAcceptanceConfig({ VALE_PASS_TERMS_ACCEPTANCE: 'on', VALE_PASS_TERMS_VERSION: version, VALE_PASS_TERMS_SHA256: sha256, VALE_PASS_TERMS_TOKEN_SECRET: secret });
    expect(config.required).toBe(false);
  });

  test('o ambiente real deste teste não tem variáveis de termos (nada é lido de produção)', () => {
    for (const key of Object.keys(process.env).filter((name) => name.startsWith('VALE_PASS_TERMS_'))) {
      expect(process.env[key], `${key} definida no ambiente do teste`).toBeUndefined();
    }
  });
});
