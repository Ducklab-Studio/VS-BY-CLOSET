/**
 * Configuração do Next para produção em container.
 *
 * O site é estático em essência: todo o comércio (catálogo, disponibilidade,
 * carrinho, checkout) roda pelos componentes embedados do Booqable. Não há API
 * própria nem banco.
 */

const isProd = process.env.NODE_ENV === 'production';

/** Build para hospedagem estática (sem Node no servidor). */
const isStaticExport = process.env.NEXT_OUTPUT_EXPORT === 'true';

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

  // Exportação estática: gera HTML puro em `out/`, sem precisar de Node no
  // servidor. Roda em qualquer hospedagem compartilhada. Possível porque todo
  // o comércio acontece no navegador, via Booqable — este site não busca nada
  // no servidor.
  ...(isStaticExport && {
    output: 'export',
    // Gera `catalogo/index.html` em vez de `catalogo.html`: o Apache serve
    // esse caminho nativamente, sem regra de rewrite.
    trailingSlash: true,
  }),

  eslint: { ignoreDuringBuilds: true },

  images: {
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 60,
    // Sem servidor Node não há otimização de imagem sob demanda.
    ...(isStaticExport && { unoptimized: true }),
  },

  // Em export estático não há servidor para enviar cabeçalho — o Next ignora
  // esta função. Nesse modo os mesmos headers vêm do `public/.htaccess`, e as
  // duas listas precisam ser mantidas em sincronia.
  ...(isStaticExport
    ? {}
    : {
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
                  ? [
                      {
                        key: 'Strict-Transport-Security',
                        value: 'max-age=31536000; includeSubDomains',
                      },
                    ]
                  : []),
              ],
            },
          ];
        },
      }),
};

export default nextConfig;
