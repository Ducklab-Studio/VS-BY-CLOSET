/**
 * Vitrine em Next.js — front puro, sem carrinho nem checkout.
 *
 * Lê produtos da Storefront API do Shopify (leitura pública, sem PRP) só para
 * exibir catálogo com o visual da marca. O botão "Reservar" leva ao tema
 * Liquid (../../theme), onde o PRP e o checkout de fato funcionam — o widget
 * de aluguel usa App Blocks, mecanismo que só existe dentro do tema Shopify.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  images: {
    remotePatterns: [
      // CDN de imagem de produto do Shopify.
      { protocol: 'https', hostname: 'cdn.shopify.com' },
      { protocol: 'https', hostname: 'res.cloudinary.com' },
    ],
    formats: ['image/avif', 'image/webp'],
  },

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
