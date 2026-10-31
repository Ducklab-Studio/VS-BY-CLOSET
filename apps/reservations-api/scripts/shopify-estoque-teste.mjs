#!/usr/bin/env node
/**
 * SOMENTE LEITURA — estado de estoque das variantes do Valle Pass na Shopify (produto de TESTE de R$ 0,10 e produto OFICIAL), para a homologação do AUTO_VERIFY.
 *
 *   railway run -p <projeto> -e <ambiente> -s "@valle/reservations-api" -- node apps/reservations-api/scripts/shopify-estoque-teste.mjs --expect closed
 *   --expect closed   a variante de teste precisa estar INDISPONÍVEL (rastreada, availableForSale=false) e a oficial também  → código 0, senão 2
 *   --expect open     a variante de teste precisa estar DISPONÍVEL com estoque 1 (rastreada, availableForSale=true, quantidade 1) e a oficial INDISPONÍVEL → código 0, senão 2
 *   sem --expect      só imprime
 * Só envia consultas GraphQL (nenhuma mutation) e nunca imprime credenciais. Estoque da variante de teste: −2 (hoje) → 1 (abertura controlada, +3) → 0 (encerramento).
 */
const expectArg = process.argv.includes('--expect') ? process.argv[process.argv.indexOf('--expect') + 1] : null;
if (expectArg && !['closed', 'open'].includes(expectArg)) {
  console.error('Use --expect closed|open.');
  process.exit(1);
}
const domain = process.env.SHOPIFY_STORE_DOMAIN?.trim();
const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
if (!domain || !clientId || !clientSecret) {
  console.error('Credenciais da Shopify ausentes neste ambiente.');
  process.exit(1);
}
const tokenResponse = await fetch(`https://${domain}/admin/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }) });
const token = (await tokenResponse.json().catch(() => null))?.access_token;
if (!token) {
  console.error(`Não foi possível autenticar na Shopify (HTTP ${tokenResponse.status}).`);
  process.exit(1);
}
const fields = 'title status tracksInventory totalInventory variants(first: 3) { nodes { id price availableForSale inventoryPolicy inventoryQuantity inventoryItem { tracked } } }';
const response = await fetch(`https://${domain}/admin/api/2026-07/graphql.json`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
  body: JSON.stringify({ query: `{ teste: productByHandle(handle: "valle-pass-teste") { ${fields} } oficial: product(id: "gid://shopify/Product/8723909804132") { ${fields} } }` }),
});
const body = await response.json().catch(() => null);
if (!response.ok || body?.errors || !body?.data?.teste || !body?.data?.oficial) {
  console.error(`Consulta recusada ou incompleta (HTTP ${response.status}).`);
  process.exit(1);
}
const describe = (label, product) => {
  const [variant] = product.variants.nodes;
  const state = { rastreada: variant.inventoryItem.tracked, disponivel: variant.availableForSale, quantidade: variant.inventoryQuantity, politica: variant.inventoryPolicy, preco: variant.price };
  console.log(`${label}: ${JSON.stringify(state)} produto=${product.status}`);
  return state;
};
const teste = describe('TESTE  (R$ 0,10)', body.data.teste);
const oficial = describe('OFICIAL (R$ 350)', body.data.oficial);
if (!expectArg) process.exit(0);
const problems = [];
if (!teste.rastreada) problems.push('teste: estoque NÃO rastreado (a quantidade e a política DENY seriam ignoradas)');
if (teste.politica !== 'DENY') problems.push('teste: política de estoque diferente de DENY');
if (teste.preco !== '0.10') problems.push('teste: preço diferente de 0,10');
if (oficial.disponivel !== false) problems.push('OFICIAL disponível para compra');
if (expectArg === 'closed' && teste.disponivel !== false) problems.push('teste: variante DISPONÍVEL (esperado: indisponível)');
if (expectArg === 'open' && (teste.disponivel !== true || teste.quantidade !== 1)) problems.push('teste: esperado disponível com quantidade 1');
for (const problem of problems) console.log(`FALHA  ${problem}`);
console.log(problems.length === 0 ? `\nRESULTADO: OK (${expectArg})` : '\nRESULTADO: REPROVADO');
process.exit(problems.length === 0 ? 0 : 2);
