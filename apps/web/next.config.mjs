/**
 * Configuração do Next para produção em container.
 *
 * O site é estático em essência: todo o comércio (catálogo, disponibilidade,
 * carrinho, checkout) roda pelos componentes embedados do Booqable. Não há API
 * própria nem banco.
 */

const isProd = process.env.NODE_ENV === 'production';

/**
 * Origens do Booqable liberadas no CSP.
 *
 * Sem isso o navegador bloqueia o script da integração e o site fica sem
 * catálogo — o CSP é a primeira coisa a conferir se os componentes não
 * aparecerem. `booqable.com` cobre o script; o subdomínio da conta é onde ficam
 * as chamadas de dados e as imagens dos produtos.
 */
const BOOQABLE_ORIGINS = [
  'https://booqable.com',
  'https://*.booqable.com',
  'https://*.booqablecdn.com',
];

const csp = [
  "default-src 'self'",
  // 'unsafe-inline' é exigido pelo runtime do Next (hidratação) e pelo próprio
  // snippet do Booqable, que injeta configuração inline.
  `script-src 'self' 'unsafe-inline' ${BOOQABLE_ORIGINS.join(' ')}${isProd ? '' : " 'unsafe-eval'"}`,
  `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com ${BOOQABLE_ORIGINS.join(' ')}`,
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  `connect-src 'self' ${BOOQABLE_ORIGINS.join(' ')}`,
  // O checkout do Booqable pode abrir em iframe.
  `frame-src 'self' ${BOOQABLE_ORIGINS.join(' ')}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  `form-action 'self' ${BOOQABLE_ORIGINS.join(' ')}`,
  ...(isProd ? ['upgrade-insecure-requests'] : []),
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Bundle autocontido para a imagem Docker. Ligado só no build da imagem
  // porque o tracing usa symlink, e o Windows barra symlink sem modo
  // desenvolvedor — deixar sempre ligado quebraria o `pnpm build` local.
  ...(process.env.NEXT_OUTPUT_STANDALONE === 'true' && { output: 'standalone' }),

  eslint: { ignoreDuringBuilds: true },

  images: {
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 60,
  },

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          ...(isProd
            ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
            : []),
        ],
      },
    ];
  },
};

export default nextConfig;
