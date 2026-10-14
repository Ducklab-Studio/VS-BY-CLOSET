import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Quem aparece na vitrine (o TS real, transpilado): destaques, listagem e filtros por
// categoria usam a MESMA regra — só entra produto com peça física reservável cadastrada
// no ClosetAdmin. SKU sincronizado e estoque na Shopify não bastam.
const root = new URL('../', import.meta.url);
const repoRoot = new URL('../../../', import.meta.url);
const ts = createRequire(new URL('package.json', root))('typescript');
const transpile = (file) =>
  ts.transpileModule(readFileSync(new URL(file, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
const lib = {};
runInNewContext(transpile('src/lib/catalog-eligibility.ts'), { exports: lib, Object, Array, Set, String });
const { parseRentableVariantIds, parseCatalogVariantState, rentalCatalogStatus, catalogWithStatus, isRentableProduct, filterRentableProducts, productsInCategory } = lib;
const plain = (value) => JSON.parse(JSON.stringify(value));
const read = (file, base = root) => readFileSync(new URL(file, base), 'utf8').replace(/\r\n/g, '\n');

const gid = (n) => `gid://shopify/ProductVariant/${n}`;
const product = (id, handle, variantIds, extra = {}) => ({ id: `gid://shopify/Product/${id}`, handle, productType: '', variants: { nodes: variantIds.map((v) => ({ id: gid(v) })) }, ...extra });

// O catálogo do caso real: Blazer Star (SKU 03, estoque 1, SEM peça física), Conjunto Tuid (com peça), Valle Pass (compra direta).
const blazer = product(1, 'blazer-star', [67686161055844], { productType: 'Blazer' });
const conjunto = product(2, 'conjunto-tuid', [49621154103396], { productType: 'Conjunto' });
const valle = product(3, 'vs-xxx-001', [49174518595684]);
const all = [blazer, conjunto, valle];
const isValle = (p) => p.handle === 'vs-xxx-001';
const rentable = (...ids) => new Set(ids.map(gid));

test('lista da API: só { variantIds: [...] } é aceita; qualquer outra coisa é "inutilizável" (null), nunca lista vazia', () => {
  assert.deepEqual(plain([...parseRentableVariantIds({ variantIds: [gid(1), gid(2)] })]), [gid(1), gid(2)]);
  assert.deepEqual([...parseRentableVariantIds({ variantIds: [] })], [], 'lista vazia é válida: nenhuma peça cadastrada');
  assert.deepEqual(plain([...parseRentableVariantIds({ variantIds: [gid(1), 5, null, '', gid(1)] })]), [gid(1)], 'ignora lixo e repetição');
  for (const bad of [null, undefined, [], 'ok', 7, {}, { variantIds: 'x' }, { variantIds: null }, { ids: [gid(1)] }, '<html>Bad gateway</html>']) {
    assert.equal(parseRentableVariantIds(bad), null, JSON.stringify(bad));
  }
  // API mais nova com campos extras: continua funcionando (frontend antigo × backend novo)
  assert.equal(parseRentableVariantIds({ variantIds: [gid(1)], generatedAt: 'x', total: 1 }).size, 1);
});

test('produto SEM peça física (SKU e estoque na Shopify): não aparece em lugar nenhum; o Valle Pass fica; o com peça aparece', () => {
  const visible = filterRentableProducts(all, rentable(49621154103396), isValle).map((p) => p.handle);
  assert.deepEqual(visible, ['conjunto-tuid', 'vs-xxx-001']);
});

test('depois de cadastrar a peça do Blazer Star: ele aparece (destaques, listagem e filtro de Blazers); desativar tira de novo', () => {
  const withPiece = filterRentableProducts(all, rentable(49621154103396, 67686161055844), isValle);
  assert.deepEqual(withPiece.map((p) => p.handle), ['blazer-star', 'conjunto-tuid', 'vs-xxx-001']);
  const blazers = productsInCategory(withPiece, { productIds: [blazer.id] });
  assert.deepEqual(blazers.map((p) => p.handle), ['blazer-star']);
  // peça desativada/não reservável: a API deixa de listar a variante
  assert.deepEqual(filterRentableProducts(all, rentable(49621154103396), isValle).map((p) => p.handle).includes('blazer-star'), false);
});

test('destaques e listagem concordam: a mesma lista de produtos e a mesma lista permitida dão o mesmo resultado', () => {
  for (const allowed of [rentable(), rentable(49621154103396), rentable(67686161055844, 49621154103396), null]) {
    const featured = filterRentableProducts([...all].reverse(), allowed, isValle).map((p) => p.handle).sort();
    const listing = filterRentableProducts(all, allowed, isValle).map((p) => p.handle).sort();
    assert.deepEqual(featured, listing);
  }
});

test('filtros: Blazers e Conjuntos pelas coleções da Shopify (ids) ou, sem ids, pelo tipo do produto; categoria só com o que é elegível', () => {
  const visible = filterRentableProducts(all, rentable(49621154103396, 67686161055844), isValle);
  assert.deepEqual(productsInCategory(visible, { productIds: [blazer.id] }).map((p) => p.handle), ['blazer-star']);
  assert.deepEqual(productsInCategory(visible, { productIds: [conjunto.id] }).map((p) => p.handle), ['conjunto-tuid']);
  assert.deepEqual(productsInCategory(visible, { productType: 'blazer' }).map((p) => p.handle), ['blazer-star']);
  assert.deepEqual(productsInCategory(visible, { productType: 'conjunto' }).map((p) => p.handle), ['conjunto-tuid']);
  // Blazers sem peça cadastrada: o filtro fica vazio (e não mostra o produto "pela metade")
  const none = filterRentableProducts(all, rentable(49621154103396), isValle);
  assert.deepEqual(productsInCategory(none, { productIds: [blazer.id] }), []);
  // coleção sem ids e sem tipo não casa com nada
  assert.deepEqual(productsInCategory(visible, { productIds: [] }), []);
});

test('produto com várias variantes: basta UMA com peça reservável', () => {
  const multi = product(9, 'jaqueta', [901, 902, 903]);
  assert.equal(isRentableProduct(multi, rentable(902), false), true);
  assert.equal(isRentableProduct(multi, rentable(999), false), false);
  assert.equal(isRentableProduct(product(10, 'sem-variantes', []), rentable(1), false), false);
  assert.equal(isRentableProduct({ id: 'x' }, rentable(1), false), false, 'sem campo de variantes (consulta antiga): não chuta');
});

test('API fora do ar / resposta antiga (null): cai ABERTO — a vitrine continua mostrando o que a Shopify tem, igual nos três lugares', () => {
  assert.deepEqual(plain(filterRentableProducts(all, null, isValle).map((p) => p.handle)), ['blazer-star', 'conjunto-tuid', 'vs-xxx-001']);
  // e "cache desatualizado": a lista antiga (sem a peça nova) esconde, a nova mostra — não há estado em memória no filtro
  assert.equal(filterRentableProducts(all, rentable(), isValle).length, 1);
  assert.equal(filterRentableProducts(all, rentable(67686161055844), isValle).length, 2);
});

test('nenhuma lista fixa: o filtro não conhece handles, SKUs nem ids de produto', () => {
  const src = read('src/lib/catalog-eligibility.ts');
  for (const forbidden of ['blazer', 'conjunto', '49621154103396', '67686161055844', "'03'"]) assert.equal(src.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
});

// ── guardas de estrutura: o que quebrou antes não pode voltar sem o teste avisar ──────────
test('destaques (home) e listagem passam pelo MESMO filtro de peças reserváveis', () => {
  const shopify = read('src/lib/shopify.ts');
  const featured = shopify.slice(shopify.indexOf('export async function listFeaturedProducts'), shopify.indexOf('export interface CatalogCategory'));
  assert.match(featured, /filterPublicCatalogProducts\(/, 'listFeaturedProducts precisa filtrar');
  assert.match(featured, /CATALOG_VARIANT_IDS_FIELD/, 'e pedir as variantes para poder filtrar');
  const catalog = shopify.slice(shopify.indexOf('export async function listCatalog'), shopify.indexOf('async function filterPublicCatalogProducts'));
  assert.match(catalog, /filterPublicCatalogProducts\(/, 'listCatalog precisa filtrar');
  // a regra em si vive num lugar só
  assert.match(shopify, /catalogWithStatus\(products, state, isDirectPurchaseProduct, options\)/);
  // destaques só mostram o que dá para alugar; a listagem também mostra o que aguarda inventário
  assert.match(featured, /includeAwaiting: false/);
  assert.match(catalog, /includeAwaiting: true/);
  assert.equal((shopify.match(/\/availability\/catalog-variants/g) ?? []).length, 1, 'uma única leitura da lista pública');
});

test('cache: destaques com ISR curto (60 s), listagem sem cache — e a falha aberta deixa rastro no log do servidor', () => {
  const shopify = read('src/lib/shopify.ts');
  assert.match(shopify, /\{ revalidate: 60 \}/);
  assert.match(shopify, /\{ cache: 'no-store' \}/);
  assert.match(shopify, /console\.warn\('\[catalogo\]/);
  assert.match(read('src/app/pecas/page.tsx'), /export const revalidate = 0;/);
});

test('ClosetAdmin: cadastrar, ativar/desativar e sincronizar peça revalidam a vitrine pública (home, listagem e página da peça)', () => {
  const actions = read('src/app/closetadmin/(protected)/pecas/actions.ts');
  const revalidate = actions.slice(actions.indexOf('function revalidatePieceDependentViews'));
  for (const target of ["revalidatePath('/')", "revalidatePath('/pecas')", "revalidatePath('/pecas/[handle]', 'page')"]) assert.ok(revalidate.includes(target), target);
  // as três ações usam a mesma função
  assert.equal((actions.match(/revalidatePieceDependentViews\(\);/g) ?? []).length, 3);
});

test('listagem usa a regra única de categoria', () => {
  assert.match(read('src/app/pecas/page.tsx'), /productsInCategory\(products, activeCategory\)/);
});

// ── contrato frontend × API (deploys independentes) ───────────────────────────────────────
function interfaceFields(source, name) {
  const match = new RegExp(`export interface ${name}(?:\\s+extends\\s+[\\w, <>]+)?\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  assert.ok(match, `interface ${name} não encontrada`);
  const body = match[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // só campos do primeiro nível (ignora o que está dentro de objetos aninhados)
  let depth = 0;
  const top = [];
  for (const line of body.split('\n')) {
    const field = depth === 0 ? /^\s*(?:readonly\s+)?(\w+)\??:/.exec(line) : null;
    if (field) top.push(field[1]);
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
  }
  return top;
}

test('contrato: tudo o que o frontend lê do catálogo e da sincronização existe na API (deploy do site na frente do backend não quebra)', () => {
  const api = read('apps/reservations-api/src/admin-panel/shopify-catalog.service.ts', repoRoot);
  const apiClient = read('apps/reservations-api/src/admin-panel/shopify-admin.client.ts', repoRoot);
  const apiSync = read('apps/reservations-api/src/admin-panel/shopify-catalog-sync.service.ts', repoRoot);
  const front = read('src/lib/shopify-admin-data.ts');

  const apiItem = new Set([...interfaceFields(api, 'ShopifyCatalogItem'), ...interfaceFields(apiClient, 'ShopifyCatalogVariant')]);
  const frontFields = interfaceFields(front, 'ShopifyCatalogItem');
  assert.ok(frontFields.length >= 10 && apiItem.size >= 10, 'o leitor de interfaces precisa enxergar os campos');
  for (const field of frontFields) assert.ok(apiItem.has(field), `ShopifyCatalogItem.${field} não existe na API`);

  const apiUnit = new Set(interfaceFields(api, 'ShopifyMappedUnit'));
  for (const field of interfaceFields(front, 'ShopifyMappedUnit')) assert.ok(apiUnit.has(field), `ShopifyMappedUnit.${field}`);

  const apiReport = new Set(interfaceFields(apiSync, 'CatalogSyncReport'));
  for (const field of interfaceFields(front, 'CatalogSyncReport')) assert.ok(apiReport.has(field), `CatalogSyncReport.${field}`);
  const apiDivergence = new Set(interfaceFields(apiSync, 'CatalogDivergence'));
  for (const field of interfaceFields(front, 'CatalogDivergence')) assert.ok(apiDivergence.has(field), `CatalogDivergence.${field}`);
});

test('contrato: o corpo do cadastro que o ClosetAdmin envia é exatamente o que o DTO da API aceita', () => {
  const dto = read('apps/reservations-api/src/admin-panel/dto/import-shopify-units.dto.ts', repoRoot);
  const sent = interfaceFields(`export interface Sent {\n${read('src/lib/shopify-admin-data.ts').match(/input: \{([\s\S]*?)\n  \},/)[1]}\n}`, 'Sent');
  for (const field of sent) assert.ok(new RegExp(`\\b${field}[!?]?:`).test(dto), `DTO sem ${field}`);
  // o DTO rejeita campo desconhecido? (forbidNonWhitelisted) — por isso o front não pode mandar nada além
  assert.deepEqual([...sent].sort(), ['codes', 'countsTowardRentalDuration', 'reservableOnline', 'shopifyVariantId']);
});

test('contrato: os endpoints que o frontend chama ainda existem na API (nenhum endpoint antigo/renomeado)', () => {
  const calls = [
    ['/admin/shopify/catalog', 'apps/reservations-api/src/admin-panel/shopify-catalog.controller.ts', /@Controller\('admin\/shopify'\)[\s\S]*@Get\('catalog'\)/],
    ['/admin/shopify/units', 'apps/reservations-api/src/admin-panel/shopify-catalog.controller.ts', /@Post\('units'\)/],
    ['/admin/catalog/sync', 'apps/reservations-api/src/admin-panel/shopify-catalog-sync.controller.ts', /@Controller\('admin\/catalog'\)[\s\S]*@Post\('sync'\)/],
    ['/admin/catalog/reconciliation', 'apps/reservations-api/src/admin-panel/shopify-catalog-sync.controller.ts', /@Get\('reconciliation'\)/],
    ['/admin/pieces', 'apps/reservations-api/src/admin-panel/pieces.controller.ts', /@Controller\('admin\/pieces'\)/],
    ['/availability/catalog-variants', 'apps/reservations-api/src/availability/availability.controller.ts', /@Get\('catalog-variants'\)/],
    ['/availability', 'apps/reservations-api/src/availability/availability.controller.ts', /@Controller\('availability'\)/],
  ];
  const front = [read('src/lib/shopify-admin-data.ts'), read('src/lib/admin-data.ts'), read('src/lib/shopify.ts'), read('src/app/api/availability/route.ts')].join('\n');
  for (const [route, file, pattern] of calls) {
    assert.ok(front.includes(route), `o frontend não chama mais ${route}? (atualize este teste junto)`);
    assert.match(read(file, repoRoot), pattern, `a API não tem mais ${route}`);
  }
});

// ── produto novo na Shopify, ainda sem peça física: aparece como indisponível ─────────────
const state = (rentableIds, registeredIds) => ({ rentable: rentable(...rentableIds), registered: registeredIds === null ? null : rentable(...registeredIds) });
const firenze = product(11, 'jaqueta-firenze', [11001]);
const saint = product(12, 'jaqueta-saint-tropez', [12001]);
const everything = [blazer, conjunto, valle, firenze, saint];
const handles = (list) => plain(list.map((p) => p.handle));

test('API nova: lista de variantes reserváveis + variantes já cadastradas; API antiga (sem o segundo campo) continua aceita', () => {
  const parsed = parseCatalogVariantState({ variantIds: [gid(1)], registeredVariantIds: [gid(1), gid(2), 7, '', null] });
  assert.deepEqual(plain([...parsed.rentable]), [gid(1)]);
  assert.deepEqual(plain([...parsed.registered]), [gid(1), gid(2)]);
  assert.equal(parseCatalogVariantState({ variantIds: [gid(1)] }).registered, null, 'API antiga: sem lista de cadastradas');
  assert.equal(parseCatalogVariantState({ variantIds: [gid(1)], registeredVariantIds: 'x' }).registered, null);
  for (const bad of [null, [], 'ok', {}, { registeredVariantIds: [gid(1)] }, '<html>Bad gateway</html>']) assert.equal(parseCatalogVariantState(bad), null, JSON.stringify(bad));
});

test('produto novo sem NENHUMA peça cadastrada aparece como indisponível na listagem — e não nos destaques', () => {
  const s = state([49621154103396], [49621154103396]);
  const listing = catalogWithStatus(everything, s, isValle, { includeAwaiting: true });
  assert.deepEqual(handles(listing), ['blazer-star', 'conjunto-tuid', 'vs-xxx-001', 'jaqueta-firenze', 'jaqueta-saint-tropez']);
  const status = Object.fromEntries(listing.map((p) => [p.handle, p.rentalStatus]));
  assert.deepEqual(plain(status), { 'blazer-star': 'awaiting', 'conjunto-tuid': 'available', 'vs-xxx-001': 'available', 'jaqueta-firenze': 'awaiting', 'jaqueta-saint-tropez': 'awaiting' });
  const featured = catalogWithStatus(everything, s, isValle, { includeAwaiting: false });
  assert.deepEqual(handles(featured), ['conjunto-tuid', 'vs-xxx-001'], 'destaques: só o que dá para alugar');
});

test('peça cadastrada e FORA de operação (desativada/arquivada): o produto continua sumindo, como antes', () => {
  const s = state([49621154103396], [49621154103396, 67686161055844]); // Blazer: peça existe mas inativa
  assert.deepEqual(handles(catalogWithStatus(all, s, isValle, { includeAwaiting: true })), ['conjunto-tuid', 'vs-xxx-001']);
});

test('depois de cadastrar a peça: o produto passa de indisponível para disponível; desativar a peça o esconde de novo', () => {
  assert.equal(catalogWithStatus([firenze], state([], []), isValle, { includeAwaiting: true })[0].rentalStatus, 'awaiting');
  assert.equal(catalogWithStatus([firenze], state([11001], [11001]), isValle, { includeAwaiting: true })[0].rentalStatus, 'available');
  assert.deepEqual(plain(catalogWithStatus([firenze], state([], [11001]), isValle, { includeAwaiting: true })), []);
});

test('várias variantes (tamanhos): uma com peça basta; só some se TODAS já tiveram peça e nenhuma está em operação', () => {
  const sizes = product(20, 'sobretudo', [2001, 2002, 2003]);
  assert.equal(rentalCatalogStatus(sizes, state([2002], [2002]), false), 'available');
  assert.equal(rentalCatalogStatus(sizes, state([], [2001, 2002, 2003]), false), null);
  assert.equal(rentalCatalogStatus(sizes, state([], [2001, 2002]), false), 'awaiting', 'tamanho novo ainda sem peça mantém o produto visível');
  assert.equal(rentalCatalogStatus(sizes, state([], []), false), 'awaiting');
  assert.equal(rentalCatalogStatus(product(21, 'sem-variantes', []), state([], []), false), null, 'produto sem variantes não aparece');
});

test('API antiga (sem lista de cadastradas): comportamento anterior — esconde tudo que não é reservável; falha aberta com API fora', () => {
  assert.deepEqual(handles(catalogWithStatus(all, state([49621154103396], null), isValle, { includeAwaiting: true })), ['conjunto-tuid', 'vs-xxx-001']);
  const open = catalogWithStatus(all, null, isValle, { includeAwaiting: true });
  assert.deepEqual(handles(open), ['blazer-star', 'conjunto-tuid', 'vs-xxx-001']);
  assert.ok(open.every((p) => p.rentalStatus === 'available'));
});

test('Valle Pass é compra direta: sempre disponível, mesmo sem peça, e nunca fica "aguardando"', () => {
  const [v] = catalogWithStatus([valle], state([], []), isValle, { includeAwaiting: false });
  assert.equal(v.rentalStatus, 'available');
});

test('cartão do catálogo: produto aguardando inventário mostra a marca e não oferece "adicionar à reserva"', () => {
  const card = read('src/components/ProductCard.tsx');
  assert.match(card, /product\.rentalStatus === 'awaiting'/);
  assert.match(card, /data-rental-status="awaiting"/);
  assert.match(card, /catalog && !awaiting && <SelectionFlag/);
});
