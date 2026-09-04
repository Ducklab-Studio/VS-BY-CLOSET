/**
 * Item 17 da Fase 6 — UMA integração controlada contra a Storefront API
 * REAL. Cria só um CART de teste (sem pagamento, sem pedido) usando o
 * produto de teste já existente na loja (`vestido-teste-vs-by-closet`,
 * o mesmo usado no build do apps/marketing). Não é rodado como parte de
 * `pnpm test` (não queremos bater na Shopify real a cada execução da
 * suíte) — é um script manual, mesmo padrão de test:concurrency.
 *
 * Uso: pnpm --filter @valle/reservations-api test:real-shopify
 * Requer SHOPIFY_STORE_DOMAIN e SHOPIFY_STOREFRONT_TOKEN no .env (ver
 * .env.example) — os mesmos valores que apps/marketing já usa.
 *
 * NÃO conclui pagamento. NÃO gera pedido. Só confirma: cartCreate →
 * sucesso, checkoutUrl → domínio Shopify correto, linha → correta,
 * atributos → corretos. O carrinho fica pra inspeção manual, se
 * necessário — nunca é finalizado por este script.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveShopifyStorefrontCredentials } from '../src/checkout/checkout.config';
import { shopifyCartCreate } from '../src/checkout/shopify-storefront-cart.client';

// Diferente de concurrency.manual.ts (que só usa PrismaClient, e o
// Prisma carrega .env sozinho), este script lê process.env diretamente
// — sem um loader de .env, SHOPIFY_STORE_DOMAIN/TOKEN nunca chegariam
// aqui. Parser mínimo, só pra este script manual (não é dependência
// nova do projeto).
function loadDotEnv(): void {
  let content: string;
  try {
    content = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of content.split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
  }
}
loadDotEnv();

const TEST_PRODUCT_HANDLE = 'vestido-teste-vs-by-closet';
const API_VERSION = '2025-01';

async function fetchFirstVariantId(domain: string, token: string): Promise<{ variantId: string; title: string } | null> {
  const res = await fetch(`https://${domain}/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': token },
    body: JSON.stringify({
      query: `query($handle: String!) { product(handle: $handle) { title variants(first: 1) { nodes { id title } } } }`,
      variables: { handle: TEST_PRODUCT_HANDLE },
    }),
  });
  if (!res.ok) throw new Error(`Falha ao consultar o produto de teste: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { product: { title: string; variants: { nodes: { id: string; title: string }[] } } | null } };
  const variant = json.data?.product?.variants.nodes[0];
  if (!variant) return null;
  return { variantId: variant.id, title: `${json.data?.product?.title} — ${variant.title}` };
}

async function main() {
  const credentials = resolveShopifyStorefrontCredentials();

  console.log(`Buscando produto de teste "${TEST_PRODUCT_HANDLE}" em ${credentials.shopifyDomain}...`);
  const variant = await fetchFirstVariantId(credentials.shopifyDomain, credentials.storefrontToken);
  if (!variant) {
    console.log(`\n❌ FALHOU: produto "${TEST_PRODUCT_HANDLE}" não encontrado ou sem variantes na loja real.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Variante encontrada: ${variant.title} (${variant.variantId})`);

  const attributes = [
    { key: 'reservation_id', value: '00000000-0000-0000-0000-000000000000' },
    { key: 'pickup_date', value: '2027-01-10' },
    { key: 'effective_return_date', value: '2027-01-12' },
    { key: 'rental_duration_days', value: '2' },
    { key: 'terms_version', value: 'test-real-shopify-cart-script' },
  ];

  console.log('\nChamando cartCreate (Storefront API real, sem pagamento)...');
  const result = await shopifyCartCreate(credentials, [{ merchandiseId: variant.variantId, quantity: 1 }], attributes);

  if (!result.ok) {
    console.log('\n❌ FALHOU: Storefront API recusou o cart.');
    console.log('userErrors:', JSON.stringify(result.userErrors, null, 2));
    process.exitCode = 1;
    return;
  }

  const checkoutHost = new URL(result.checkoutUrl).host;
  const domainMatches = checkoutHost.endsWith('.myshopify.com') || checkoutHost === credentials.shopifyDomain || checkoutHost.endsWith('myshopify.com');

  console.log('\n✅ cartCreate teve sucesso:');
  console.log('  cartId:      ', result.cartId);
  console.log('  checkoutUrl: ', result.checkoutUrl);
  console.log('  domínio ok:  ', domainMatches);
  console.log('\nEste script NÃO abre o checkout nem conclui pagamento nenhum — o carrinho');
  console.log('fica órfão (sem pedido, sem pagamento), o que é aceitável por design (ver');
  console.log('item 8 do relatório da Fase 6). Se quiser inspecionar visualmente, abra a');
  console.log('checkoutUrl acima manualmente e NÃO finalize.');

  process.exitCode = domainMatches ? 0 : 1;
}

main().catch((err) => {
  console.error('Erro inesperado:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
