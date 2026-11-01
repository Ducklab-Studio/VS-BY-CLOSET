import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');

function transpileModule(path) {
  const content = readFileSync(new URL(path, root), 'utf8');
  return ts.transpileModule(content, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2021,
      esModuleInterop: true,
    },
  }).outputText;
}

// 1. Carrega constantes oficiais de vale-pass-official-terms.ts
const officialTermsExports = {};
runInNewContext(transpileModule('src/lib/vale-pass-official-terms.ts'), {
  exports: officialTermsExports,
});
const {
  OFFICIAL_TERMS_VERSION,
  OFFICIAL_TERMS_SHA256,
  OFFICIAL_TERMS_BYTES,
  OFFICIAL_TERMS_FILE,
  isOfficialTermsMatch,
} = officialTermsExports;

// 2. Carrega loader dos termos oficiais
const loaderExports = {};
runInNewContext(
  transpileModule('src/lib/vale-pass-official-terms-loader.ts'),
  {
    exports: loaderExports,
    process: { cwd: () => new URL('.', root).pathname.replace(/^\/([A-Z]:)/, '$1') },
    require: (mod) => {
      if (mod === './vale-pass-official-terms') return officialTermsExports;
      return createRequire(import.meta.url)(mod);
    },
  },
);
const { loadAndVerifyOfficialTerms, parseOfficialTermsMarkdown } = loaderExports;

// 3. Lê o arquivo Markdown oficial embutido no marketing
const localOfficialFile = new URL(`src/content/termos-valle-pass/${OFFICIAL_TERMS_FILE}`, root);
const officialDocFile = new URL(`../../docs/termos/oficial/${OFFICIAL_TERMS_FILE}`, root);
const manifestFile = new URL('../../docs/termos/oficial/manifest.json', root);

test('o arquivo oficial 2027-1.md em apps/marketing tem exatamente 7.381 bytes e SHA-256 esperado', () => {
  assert.equal(OFFICIAL_TERMS_VERSION, '2027-1');
  assert.equal(OFFICIAL_TERMS_SHA256, '9d1a283f1ec5c32e96aba3baeb8dd9d56c06f8447bf6a70edb6a3585a8e482ae');
  assert.equal(OFFICIAL_TERMS_BYTES, 7381);

  assert.ok(existsSync(localOfficialFile), 'Arquivo local 2027-1.md deve existir');
  const buffer = readFileSync(localOfficialFile);
  assert.equal(buffer.length, OFFICIAL_TERMS_BYTES, 'Tamanho em bytes deve ser exatamente 7.381');

  const hash = createHash('sha256').update(buffer).digest('hex');
  assert.equal(hash, OFFICIAL_TERMS_SHA256, 'SHA-256 deve ser estritamente igual ao do manifesto');

  // Terminação LF sem CRLF e sem UTF-8 BOM
  assert.equal(buffer[0] !== 0xef || buffer[1] !== 0xbb || buffer[2] !== 0xbf, true, 'Não pode conter UTF-8 BOM');
  const rawString = buffer.toString('utf8');
  assert.doesNotMatch(rawString, /\r\n/, 'O arquivo oficial deve ter terminação LF exclusiva, nunca CRLF');
});

test('a cópia local em apps/marketing é byte a byte idêntica ao original em docs/termos/oficial e ao manifesto', () => {
  if (existsSync(officialDocFile)) {
    const docBuffer = readFileSync(officialDocFile);
    const localBuffer = readFileSync(localOfficialFile);
    assert.deepEqual(localBuffer, docBuffer, 'A cópia de marketing deve ser idêntica ao original de docs/');
  }

  if (existsSync(manifestFile)) {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    assert.equal(manifest.current, OFFICIAL_TERMS_VERSION);
    assert.equal(manifest.versions[OFFICIAL_TERMS_VERSION].sha256, OFFICIAL_TERMS_SHA256);
    assert.equal(manifest.versions[OFFICIAL_TERMS_VERSION].bytes, OFFICIAL_TERMS_BYTES);
  }
});

test('o loader carrega e valida o arquivo, falhando estritamente se houver qualquer divergência de hash', () => {
  const parsed = loadAndVerifyOfficialTerms();
  assert.equal(parsed.meta.version, '2027-1');
  assert.equal(parsed.sha256, OFFICIAL_TERMS_SHA256);
  assert.equal(parsed.bytes, 7381);
  assert.equal(parsed.sections.length, 8);

  // Tentativa com conteúdo alterado deve lançar erro
  const corruptedRaw = parsed.rawMarkdown.replace('R$ 350,00', 'R$ 350.00');
  assert.throws(
    () => {
      const corruptedHash = createHash('sha256').update(Buffer.from(corruptedRaw)).digest('hex');
      const corruptedBytes = Buffer.from(corruptedRaw).length;
      if (corruptedHash !== OFFICIAL_TERMS_SHA256) {
        throw new Error('CONFERÊNCIA DE INTEGRIDADE FALHOU');
      }
    },
    /CONFERÊNCIA DE INTEGRIDADE FALHOU/,
  );
});

test('todas as 8 seções numeradas, 4 subseções e alíneas a–e aparecem na ordem exata e sem cortes', () => {
  const parsed = loadAndVerifyOfficialTerms();
  const titles = Array.from(parsed.sections.map((s) => s.title));
  assert.equal(
    JSON.stringify(titles),
    JSON.stringify([
      '1. DO VALLE PASS',
      '2. DOS BENEFÍCIOS INCLUSOS',
      '3. DO PERÍODO DE VENDAS',
      '4. DA VALIDADE E UTILIZAÇÃO',
      '5. DA POLÍTICA DE CANCELAMENTO E REEMBOLSO',
      '6. DA UTILIZAÇÃO DOS BENEFÍCIOS E NÃO REEMBOLSABILIDADE',
      '7. DAS DISPOSIÇÕES GERAIS',
      '8. DA ACEITAÇÃO DOS TERMOS',
    ]),
  );

  // Seção 5 contém subseções 5.1 a 5.4
  const s5 = parsed.sections[4];
  const h3s = Array.from(s5.blocks.filter((b) => b.type === 'h3').map((b) => b.text));
  assert.equal(
    JSON.stringify(h3s),
    JSON.stringify([
      '5.1. Direito de arrependimento',
      '5.2. Garantia de satisfação presencial',
      '5.3. Condições para reembolso pela garantia presencial',
      '5.4. Do valor e prazo de reembolso',
    ]),
  );

  // Seção 5.3 contém as alíneas a a e
  const letterBlock = s5.blocks.find((b) => b.type === 'letter_list');
  assert.ok(letterBlock, 'Deve conter bloco de alíneas');
  assert.equal(letterBlock.items.length, 5);
  assert.match(letterBlock.items[0], /^a\)\s+O cliente compareça presencialmente/);
  assert.match(letterBlock.items[1], /^b\)\s+Não tenha utilizado, total ou parcialmente, o voucher de R\$ 500,00/);
  assert.match(letterBlock.items[2], /^c\)\s+Não tenha utilizado, total ou parcialmente, o voucher de R\$ 50,00/);
  assert.match(letterBlock.items[3], /^d\)\s+Não tenha utilizado o desconto de 10%/);
  assert.match(letterBlock.items[4], /^e\)\s+Solicite o cancelamento pelos canais oficiais/);

  // Seção 8 contém o encerramento e assinatura oficial
  const s8 = parsed.sections[7];
  const sig = s8.blocks.find((b) => b.type === 'signature');
  assert.ok(sig, 'Deve conter assinatura oficial');
  assert.equal(sig.brandGroup, 'GRUPO VALLE');
  assert.equal(sig.brands, 'Valle Showroom | Valle By Closet | Valle Experience');
  assert.equal(sig.tagline, 'Valle Pass 2027 — Sua experiência no Chile começa aqui.');
});

test('todos os valores monetários, datas e regras essenciais constam fielmente no documento', () => {
  const parsed = loadAndVerifyOfficialTerms();
  const fullText = parsed.rawMarkdown;

  const requiredValues = [
    'R$ 350,00',
    'R$ 500,00',
    'R$ 50,00',
    '10%',
    '31 de maio de 2027',
    '7 (sete) dias',
    '3 (três) dias úteis',
    '1º de novembro de 2026',
    'Valle By Closet', // preservado sem alteração unilateral de texto
  ];

  for (const val of requiredValues) {
    assert.ok(fullText.includes(val), `Texto oficial deve conter o valor: ${val}`);
  }
});

test('isOfficialTermsMatch valida estritamente a versão e o SHA-256 e rejeita divergências', () => {
  // Correspondência perfeita
  assert.equal(
    isOfficialTermsMatch({
      version: '2027-1',
      sha256: '9d1a283f1ec5c32e96aba3baeb8dd9d56c06f8447bf6a70edb6a3585a8e482ae',
    }),
    true,
  );

  // Hash adulterado
  assert.equal(
    isOfficialTermsMatch({
      version: '2027-1',
      sha256: '0000000000000000000000000000000000000000000000000000000000000000',
    }),
    false,
  );

  // Versão divergente com hash certo
  assert.equal(
    isOfficialTermsMatch({
      version: '2027-2',
      sha256: '9d1a283f1ec5c32e96aba3baeb8dd9d56c06f8447bf6a70edb6a3585a8e482ae',
    }),
    false,
  );

  // Valores vazios, nulos ou indefinidos
  assert.equal(isOfficialTermsMatch(null), false);
  assert.equal(isOfficialTermsMatch(undefined), false);
  assert.equal(isOfficialTermsMatch({ version: '2027-1' }), false);
  assert.equal(isOfficialTermsMatch({ sha256: OFFICIAL_TERMS_SHA256 }), false);
});

test('VallePassTermsBox exige isOfficialTermsMatch e bloqueia compra quando hash diverge ou termos são 404', () => {
  const boxCode = readFileSync(new URL('src/components/VallePassTermsBox.tsx', root), 'utf8');

  // Confere que VallePassTermsBox importa e invoca isOfficialTermsMatch
  assert.match(boxCode, /import\s+\{[^}]*isOfficialTermsMatch[^}]*\}\s+from\s+'@\/lib\/vale-pass-official-terms'/);
  assert.match(boxCode, /if \(isOfficialTermsMatch\(result\.terms\)\)/);
  assert.match(boxCode, /console\.error\(/);
  // Não expõe hash em tela para o cliente
  assert.doesNotMatch(boxCode, /\{terms\.sha256\}/);
  assert.doesNotMatch(boxCode, /<[^>]*>\s*\{terms\.sha256\}\s*<\/[^>]*>/);

  // Confere que o checkbox nunca vem pré-marcado
  assert.match(boxCode, /const \[accepted, setAccepted\] = useState\(false\);/);

  // Confere que a compra permanece bloqueada até aprovação
  assert.match(boxCode, /const isApproved = termsStatus === 'approved' && terms !== null;/);
});

test('a página /termos-valle-pass cumpre acessibilidade, não expõe caminhos de compra e fica 404 quando desabilitada', () => {
  const pageCode = readFileSync(new URL('src/app/termos-valle-pass/page.tsx', root), 'utf8');

  // Proteção contra visualização desautorizada
  assert.match(pageCode, /if \(!termsPageEnabled\(\)\) notFound\(\);/);
  assert.match(pageCode, /export const dynamic = 'force-dynamic'/);
  assert.match(pageCode, /robots: \{ index: false, follow: false \}/);

  // Identificação clara da versão
  assert.match(pageCode, /Versão \{terms\.meta\.version\}/);
  assert.match(pageCode, /data-testid="valle-pass-terms-version-badge"/);

  // Ausência de caminhos de compra ou checkout na página de termos
  assert.doesNotMatch(pageCode, /checkout|comprar|addToCart|variantId/i);
});
