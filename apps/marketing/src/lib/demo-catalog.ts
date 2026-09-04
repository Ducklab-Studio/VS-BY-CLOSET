/**
 * Catálogo fictício, só pra visualizar o layout localmente antes de ter o
 * token da Storefront API configurado.
 *
 * Fica separado de lib/shopify.ts de propósito: aquele arquivo nunca deve
 * inventar produto — é o que garante que, em produção, "sem token" mostra
 * o aviso certo em vez de dado falso. Este aqui só entra quando
 * NEXT_PUBLIC_DEMO_CATALOG=1 estiver setado explicitamente (não é o
 * padrão nem em dev), e as páginas que o usam deixam isso visível na tela.
 */

import type { StorefrontProduct, StorefrontProductDetail } from './shopify';

export const isDemoCatalogEnabled = process.env.NEXT_PUBLIC_DEMO_CATALOG === '1';

function price(amount: string) {
  return { minVariantPrice: { amount, currencyCode: 'BRL' } };
}

// Sem featuredImage de propósito: sem imagem real cadastrada, a página já
// sabe mostrar "Sem foto" — evita depender de arquivo de exemplo que não
// existe no repositório e não distorce a expectativa de como fica com foto.
export const DEMO_PRODUCTS: StorefrontProduct[] = [
  {
    id: 'demo-1',
    handle: 'jaqueta-preta-demo',
    title: 'Jaqueta Preta',
    description: 'Jaqueta de couro forrada, ideal para dias de neve intensa.',
    productType: 'Jaquetas de couro',
    featuredImage: null,
    priceRange: price('150.00'),
  },
  {
    id: 'demo-2',
    handle: 'sobretudo-marrom-demo',
    title: 'Sobretudo Marrom',
    description: 'Sobretudo de couro longo, com forro térmico removível.',
    productType: 'Sobretudo de couro',
    featuredImage: null,
    priceRange: price('300.00'),
  },
  {
    id: 'demo-3',
    handle: 'jaqueta-cinza-la-demo',
    title: 'Jaqueta Cinza',
    description: 'Jaqueta de lã leve, para temperaturas amenas.',
    productType: 'Jaquetas de lã',
    featuredImage: null,
    priceRange: price('150.00'),
  },
  {
    id: 'demo-4',
    handle: 'sobretudo-bege-demo',
    title: 'Sobretudo Bege',
    description: 'Sobretudo médio de lã, corte reto.',
    productType: 'Sobretudo médio de lã',
    featuredImage: null,
    priceRange: price('150.00'),
  },
  {
    id: 'demo-5',
    handle: 'conjunto-tricot-vinho-demo',
    title: 'Conjunto Vinho',
    description: 'Conjunto de tricô — blusa e calça.',
    productType: 'Conjuntos de tricô',
    featuredImage: null,
    priceRange: price('150.00'),
  },
  {
    id: 'demo-6',
    handle: 'bota-marrom-demo',
    title: 'Bota Marrom',
    description: 'Bota de couro impermeável, cano alto.',
    productType: 'Botas de couro',
    featuredImage: null,
    priceRange: price('120.00'),
  },
  {
    id: 'demo-7',
    handle: 'bota-premium-preta-demo',
    title: 'Bota Premium Preta',
    description: 'Bota premium com tratamento térmico reforçado.',
    productType: 'Botas premium',
    featuredImage: null,
    priceRange: price('180.00'),
  },
  {
    id: 'demo-8',
    handle: 'capa-tricot-creme-demo',
    title: 'Capa Creme',
    description: 'Capa de tricô com fechamento frontal.',
    productType: 'Capas de tricô',
    featuredImage: null,
    priceRange: price('150.00'),
  },
];

export function getDemoProductDetail(handle: string): StorefrontProductDetail | null {
  const base = DEMO_PRODUCTS.find((p) => p.handle === handle);
  if (!base) return null;

  return {
    ...base,
    descriptionHtml: `<p>${base.description}</p>`,
    images: [],
    variants: [
      {
        // gid fictício, mas no formato real — evita que o carrinho de
        // demonstração pareça um id qualquer.
        id: `gid://shopify/ProductVariant/${base.id}`,
        sku: base.handle.toUpperCase().replace(/-DEMO$/, '').replace(/-/g, '-'),
        title: 'Padrão',
        availableForSale: true,
        price: { amount: base.priceRange.minVariantPrice.amount, currencyCode: 'BRL' },
      },
    ],
  };
}
