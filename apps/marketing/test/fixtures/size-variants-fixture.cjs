// SOMENTE TESTE. Shopify simulada no servidor do Next (carregada com NODE_OPTIONS=--require): responde às consultas da página da peça com produtos
// que têm variantes (tamanho, tamanho × cor) e ao Valle Pass. Nenhuma rede externa; só responde ao host local configurado como loja.
const STORE_HOST = '127.0.0.1:8443';
const photo = { url: '/editorial/winter-campaign.webp', altText: 'Imagem de teste', width: 800, height: 1000 };
const variant = (id, sku, title, price, available, options) => ({
  id: `gid://shopify/ProductVariant/${id}`,
  sku,
  title,
  availableForSale: available,
  quantityAvailable: available ? 3 : 0,
  currentlyNotInStock: !available,
  price: { amount: price, currencyCode: 'BRL' },
  selectedOptions: options,
});
const product = (id, handle, title, variants, productType = 'Jaquetas') => ({
  id: `gid://shopify/Product/${id}`,
  handle,
  title,
  description: 'Produto simulado para o teste de escolha de variante.',
  descriptionHtml: '<p>Produto simulado para o teste de escolha de variante.</p>',
  productType,
  featuredImage: photo,
  images: { nodes: [photo] },
  priceRange: { minVariantPrice: { amount: '140.00', currencyCode: 'BRL' } },
  variants: { nodes: variants },
});

const products = [
  product(7001, 'peca-tamanhos', 'Casaco Tamanhos', [
    variant(70011, 'TAM-P', 'P', '140.00', true, [{ name: 'Tamanho', value: 'P' }]),
    variant(70012, 'TAM-M', 'M', '150.00', true, [{ name: 'Tamanho', value: 'M' }]),
    variant(70013, 'TAM-G', 'G', '160.00', false, [{ name: 'Tamanho', value: 'G' }]),
  ]),
  product(7002, 'peca-duas-opcoes', 'Vestido Duas Opções', [
    variant(70021, 'DUO-P-PRETO', 'P / Preto', '200.00', true, [{ name: 'Tamanho', value: 'P' }, { name: 'Cor', value: 'Preto' }]),
    variant(70022, 'DUO-P-VINHO', 'P / Vinho', '200.00', true, [{ name: 'Tamanho', value: 'P' }, { name: 'Cor', value: 'Vinho' }]),
    variant(70023, 'DUO-M-PRETO', 'M / Preto', '200.00', true, [{ name: 'Tamanho', value: 'M' }, { name: 'Cor', value: 'Preto' }]),
    variant(70024, 'DUO-M-VINHO', 'M / Vinho', '200.00', false, [{ name: 'Tamanho', value: 'M' }, { name: 'Cor', value: 'Vinho' }]),
  ]),
  product(7003, 'peca-unica', 'Peça de Variante Única', [variant(70031, 'UNI-1', 'Default Title', '120.00', true, [{ name: 'Title', value: 'Default Title' }])]),
  product(8723909804132, 'valle-pass-fixture', 'Valle Pass', [variant(49174518595684, 'VP-1', 'Default Title', '350.00', true, [{ name: 'Title', value: 'Default Title' }])], 'Valle Pass'),
];
// O Valle Pass da loja real traz uma descrição editável que cita um benefício sem condições aprovadas: a fixture a reproduz para provar que a vitrine NÃO a exibe.
Object.assign(products.find((item) => item.handle === 'valle-pass-fixture'), {
  description: 'Valle Compras 500,00 - Valle Showroom 50,00- valle by closet 10% de desconto - Valle Experience',
  descriptionHtml: '<p>Valle Compras </p>\n<p>500,00 - Valle Showroom</p>\n<p>50,00- valle by closet </p>\n<p>10% de desconto - Valle Experience </p>',
});
module.exports = { products, STORE_HOST };

// Disponibilidade do Valle Pass simulada, lida A CADA consulta de um arquivo de estado ("open" | "closed") indicado pelo teste. Sem a variável, o produto
// continua à venda como sempre (os testes antigos não mudam). Serve só para provar as duas telas sem abrir venda real.
const fs = require('node:fs');
function valePassAvailable() {
  const file = process.env.VALLE_PASS_FIXTURE_STATE_FILE;
  if (!file) return true;
  try { return fs.readFileSync(file, 'utf8').trim() === 'open'; } catch { return false; }
}
function withValePassAvailability(item) {
  if (!item.handle.startsWith('valle-pass')) return item;
  const available = valePassAvailable();
  return { ...item, variants: { nodes: item.variants.nodes.map((v) => ({ ...v, availableForSale: available, quantityAvailable: available ? 3 : 0, currentlyNotInStock: !available })) } };
}

if (process.env.SIZE_VARIANTS_FIXTURE === '1') {
  if (process.env.NODE_ENV === 'production') throw new Error('Fixture de variantes restrita a testes locais.');
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (url.host !== STORE_HOST) return original(input, init);
    const body = JSON.parse(init?.body || '{}');
    const handle = body.variables?.handle;
    const id = body.variables?.id; // consulta por ID (página /valle-pass): GID do produto
    const current = products.map(withValePassAvailability);
    const data = handle
      ? { product: current.find((item) => item.handle === handle) || null }
      : id
        ? { product: current.find((item) => item.id === id) || null }
        : { products: { nodes: current } };
    return Response.json({ data });
  };
}
