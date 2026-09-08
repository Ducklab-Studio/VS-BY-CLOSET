/**
 * Aplicação Next.js ativa: vitrine pública + carrinho + ClosetAdmin.
 *
 * Catálogo/carrinho usam Shopify; disponibilidade e regras de aluguel usam
 * o reservations-api. O proxy `/api/availability` mantém a consulta pública
 * same-origin e evita depender de CORS ou de uma URL absoluta gravada no
 * bundle durante o build.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  images: {
    remotePatterns: [
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
