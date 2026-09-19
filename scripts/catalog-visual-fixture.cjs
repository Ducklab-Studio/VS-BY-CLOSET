// Local visual test transport ONLY. No production import and no external service.
// Start Next with NODE_OPTIONS=--require=<absolute path to this file>,
// CATALOG_VISUAL_FIXTURE=1 and NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN=catalog-fixture.invalid.
const photo = { url: '/editorial/winter-campaign.webp', altText: 'Campanha de inverno existente — imagem de teste de layout' };
const second = { url: '/brand/logo-stacked-marsala.png', altText: 'Marca existente — teste de segunda imagem' };
const titles = ['Jaqueta Preta', 'Sobretudo de lã com nome longo para verificar a quebra de texto', 'Conjunto Vinho', 'Valle Pass', 'Peça sem foto', 'Bota Marrom', 'Jaqueta Cinza', 'Capa Creme'];
const products = titles.map((title, index) => ({
  id: `gid://shopify/Product/${index === 3 ? '8723909804132' : 1000 + index}`,
  handle: index === 3 ? 'valle-pass-fixture' : `peca-fixture-${index}`,
  title, description: 'Dados simulados para revisão local. Não representam o catálogo ou a disponibilidade da loja.',
  descriptionHtml: '<p>Dados simulados para revisão local. Não representam o catálogo ou a disponibilidade da loja.</p>',
  productType: index === 3 ? 'Valle Pass' : 'Jaquetas de couro',
  featuredImage: index === 4 ? null : photo,
  images: { nodes: index === 4 ? [] : [photo, second] },
  priceRange: { minVariantPrice: { amount: index === 1 ? '1234.00' : '150.00', currencyCode: 'BRL' } },
  variants: { nodes: [{ id: `gid://shopify/ProductVariant/${index === 3 ? '49174518595684' : 2000 + index}`, sku: `TEST-${index}`, title: 'Padrão', availableForSale: true, quantityAvailable: 3, price: { amount: index === 1 ? '1234.00' : '150.00', currencyCode: 'BRL' } }] },
}));
module.exports = { products };

if (process.env.CATALOG_VISUAL_FIXTURE === '1') {
  if (process.env.NODE_ENV === 'production' || process.env.NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN !== 'catalog-fixture.invalid') throw new Error('Visual fixture is restricted to the local test domain.');
  // Optional public-content snapshot for checking the store's existing images.
  // Contains URLs only; no downloaded or generated image assets.
  if (process.env.CATALOG_VISUAL_PRODUCTS_FILE) {
    const snapshot = JSON.parse(require('node:fs').readFileSync(process.env.CATALOG_VISUAL_PRODUCTS_FILE, 'utf8'));
    for (const [index, item] of snapshot.entries()) {
      const product = products[index === 0 ? 0 : 3];
      product.title = item.title;
      product.descriptionHtml = item.description;
      product.featuredImage = item.images[0];
      product.images = { nodes: item.images };
    }
    products.splice(1, 2);
    products.splice(2);
  }
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== 'catalog-fixture.invalid') return original(input, init);
    const body = JSON.parse(init?.body || '{}');
    const data = body.variables?.handle
      ? { product: products.find(product => product.handle === body.variables.handle) || null }
      : { products: { nodes: body.variables?.query ? products.filter(product => body.variables.query.includes(product.productType)) : products } };
    return Response.json({ data });
  };
}
