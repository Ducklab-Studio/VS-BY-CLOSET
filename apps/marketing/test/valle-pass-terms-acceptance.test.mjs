import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const root = new URL('../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');

function transpileAndLoad(relativePath, env = {}) {
  const source = readFileSync(new URL(relativePath, root), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  const customRequire = (id) => {
    if (id === './shopify') {
      return {
        storeUrl: (path = '/') => `https://test-store.myshopify.com${path.startsWith('/') ? path : `/${path}`}`,
      };
    }
    return createRequire(new URL(relativePath, root))(id);
  };
  runInNewContext(js, {
    module: mod,
    exports: mod.exports,
    process: { env },
    require: customRequire,
    AbortSignal,
    fetch: globalThis.fetch,
    URL: globalThis.URL,
    encodeURIComponent: globalThis.encodeURIComponent,
  });
  return mod.exports;
}

const termsApi = transpileAndLoad('src/lib/vale-pass-terms-api.ts');
const productLib = transpileAndLoad('src/lib/vale-pass-product.ts');
const holdsLib = transpileAndLoad('src/lib/valle-pass-holds.ts');

test('vale-pass-terms-api: mapeia mensagens amigáveis conforme a especificação do guia', () => {
  assert.equal(termsApi.formatTermsErrorMessage(429), 'Muitas tentativas. Aguarde um minuto.');
  assert.equal(
    termsApi.formatTermsErrorMessage(409, 'TERMS_VERSION_MISMATCH'),
    'Os termos foram atualizados. Por favor, leia e confirme a versão vigente antes de continuar.',
  );
  assert.equal(
    termsApi.formatTermsErrorMessage(404, 'TERMS_NOT_APPROVED'),
    'Os termos ainda não estão disponíveis para aceite.',
  );
  assert.equal(
    termsApi.formatTermsErrorMessage(400, 'ACCEPTANCE_NOT_AFFIRMATIVE'),
    'É obrigatório marcar a caixa de confirmação dos termos.',
  );
  assert.equal(
    termsApi.formatTermsErrorMessage(400, 'UNKNOWN_VARIANT'),
    'Variante do Valle Pass não reconhecida.',
  );
  assert.equal(
    termsApi.formatTermsErrorMessage(500),
    'Serviço temporariamente indisponível. Tente novamente em instantes.',
  );
});

test('vale-pass-terms-api: fetchPublicTerms trata 200 (sucesso) e 404 (termos não aprovados)', async () => {
  // Simula 200 OK da API
  const mockFetch200 = async () =>
    new Response(
      JSON.stringify({
        version: '2027-1',
        sha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        acceptanceRequired: true,
        tokenTtlMinutes: 360,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  const res200 = await termsApi.fetchPublicTerms('http://fake-api', mockFetch200);
  assert.equal(res200.ok, true);
  assert.equal(res200.status, 200);
  assert.equal(res200.terms.version, '2027-1');
  assert.equal(res200.terms.acceptanceRequired, true);

  // Simula 404 TERMS_NOT_APPROVED
  const mockFetch404 = async () =>
    new Response(
      JSON.stringify({
        code: 'TERMS_NOT_APPROVED',
        message: 'Os termos ainda não estão disponíveis para aceite.',
      }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );

  const res404 = await termsApi.fetchPublicTerms('http://fake-api', mockFetch404);
  assert.equal(res404.ok, false);
  assert.equal(res404.status, 404);
  assert.equal(res404.code, 'TERMS_NOT_APPROVED');
});

test('vale-pass-terms-api: postTermsAcceptance envia payload estrito e trata 201, 409 e 429', async () => {
  let capturedBody = null;
  const mockFetch201 = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(
      JSON.stringify({
        token: 'token.hmac.assinado.123',
        termsVersion: '2027-1',
        termsSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        issuedAt: '2026-11-01T12:00:00.000Z',
        expiresAt: '2026-11-01T18:00:00.000Z',
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const res201 = await termsApi.postTermsAcceptance(
    {
      termsVersion: '2027-1',
      termsSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      accepted: true,
      variantId: '49174518595684',
    },
    'http://fake-api',
    mockFetch201,
  );

  assert.equal(res201.ok, true);
  assert.equal(res201.status, 201);
  assert.equal(res201.grant.token, 'token.hmac.assinado.123');
  assert.deepEqual(capturedBody, {
    termsVersion: '2027-1',
    termsSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    accepted: true,
    variantId: '49174518595684',
  });

  // Simula 409 TERMS_VERSION_MISMATCH
  const mockFetch409 = async () =>
    new Response(
      JSON.stringify({
        code: 'TERMS_VERSION_MISMATCH',
        message: 'Versão dos termos desatualizada.',
      }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    );

  const res409 = await termsApi.postTermsAcceptance(
    {
      termsVersion: '2027-0',
      termsSha256: '1111111111111111111111111111111111111111111111111111111111111111',
      accepted: true,
      variantId: '49174518595684',
    },
    'http://fake-api',
    mockFetch409,
  );
  assert.equal(res409.ok, false);
  assert.equal(res409.status, 409);
  assert.equal(res409.code, 'TERMS_VERSION_MISMATCH');

  // Simula 429 Too Many Requests
  const mockFetch429 = async () =>
    new Response(
      JSON.stringify({ message: 'ThrottlerException: Too Many Requests' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    );

  const res429 = await termsApi.postTermsAcceptance(
    {
      termsVersion: '2027-1',
      termsSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      accepted: true,
      variantId: '49174518595684',
    },
    'http://fake-api',
    mockFetch429,
  );
  assert.equal(res429.ok, false);
  assert.equal(res429.status, 429);
  assert.match(res429.message, /Muitas tentativas/);
});

test('valePassCheckoutWithTermsToken monta permalink com attributes[valle_pass_terms_token]', () => {
  const url = productLib.valePassCheckoutWithTermsToken('49174518595684', 'test.token_123');
  assert.match(url, /\/cart\/49174518595684:1\?attributes\[valle_pass_terms_token\]=test\.token_123/);

  // Normalização de variante GID
  const urlGid = productLib.valePassCheckoutWithTermsToken(
    'gid://shopify/ProductVariant/49174518595684',
    'token-abc',
  );
  assert.match(urlGid, /\/cart\/49174518595684:1\?attributes\[valle_pass_terms_token\]=token-abc/);

  // Codificação segura do token
  const urlEncoded = productLib.valePassCheckoutWithTermsToken('1001', 'token+com=caracteres');
  assert.match(urlEncoded, /attributes\[valle_pass_terms_token\]=token%2Bcom%3Dcaracteres/);
});

test('valle-pass-holds orienta sobre TERMS_ACCEPTANCE_REQUIRED no ClosetAdmin', () => {
  const guidance = holdsLib.holdGuidance('FINANCIAL_MISMATCH', ['TERMS_ACCEPTANCE_REQUIRED']);
  assert.match(guidance, /O aceite dos termos não foi comprovado: conferir antes de emitir/);

  const adminPage = readFileSync(
    new URL('src/app/closetadmin/(protected)/valle-pass/HoldsAndBenefits.tsx', root),
    'utf8',
  );
  assert.match(
    adminPage,
    /TERMS_ACCEPTANCE_REQUIRED:\s*'aceite dos termos não comprovado — conferir antes de emitir'/,
  );
});

test('VallePassTermsBox: código-fonte cumpre os requisitos de conformidade e acessibilidade', () => {
  const componentSrc = readFileSync(
    new URL('src/components/VallePassTermsBox.tsx', root),
    'utf8',
  );

  // 1. Checkbox nunca pré-marcada (estado inicial false)
  assert.match(componentSrc, /const \[accepted, setAccepted\] = useState\(false\);/);

  // 2. Não salva token em storage ou cookies
  assert.doesNotMatch(componentSrc, /localStorage|sessionStorage|document\.cookie/);

  // 3. Clicar no link dos termos não desmarca o checkbox
  assert.match(componentSrc, /onClick=\{\(e\) => e\.stopPropagation\(\)\}/);

  // 4. Input com rótulo acessível e alvo de toque
  assert.match(componentSrc, /<input[\s\S]*?type="checkbox"/);
  assert.match(componentSrc, /<label htmlFor=\{checkboxId\}/);

  // 5. Tratamento de 409 recarrega os termos e desmarca a caixa
  assert.match(componentSrc, /if \(result\.status === 409\)[\s\S]*?setAccepted\(false\)/);

  // 6. Reset no pageshow ao voltar da Shopify
  assert.match(componentSrc, /window\.addEventListener\('pageshow'/);
  assert.match(componentSrc, /setAccepted\(false\)/);

  // 7. Botão desabilitado enquanto desmarcado (sem href de checkout)
  assert.match(componentSrc, /disabled=\{!accepted \|\| submitting\}/);
  assert.match(componentSrc, /aria-disabled=\{!accepted \|\| submitting\}/);
});

test('proxy de aceite: não repassa IP arbitrário do cliente e usa clientIpFromHeaders', () => {
  const proxySrc = readFileSync(
    new URL('src/app/api/valle-pass/terms-acceptances/route.ts', root),
    'utf8',
  );
  assert.match(proxySrc, /import \{ clientIpFromHeaders \} from '@\/lib\/client-ip'/);
  assert.match(proxySrc, /const verifiedIp = clientIpFromHeaders\(request\.headers\)/);
  assert.doesNotMatch(proxySrc, /request\.headers\.get\('x-forwarded-for'\)\?\.split/);
  assert.doesNotMatch(proxySrc, /console\.(log|info|warn|error)/);
});
