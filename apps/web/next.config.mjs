/**
 * Configuração do Next para produção em container.
 *
 * Estratégia de mesmo domínio: o navegador fala com `/api/v1/...` na própria
 * origem e o Next repassa para o container da API pela rede interna. Isso
 * elimina CORS, permite cookie `sameSite=lax` (imune ao bloqueio de cookie de
 * terceiros do Safari/Brave) e mantém a API fora da internet pública.
 */

/** URL interna da API — nome do serviço no compose, não acessível de fora. */
const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:3333';

/** Origem pública da API. Só é definida quando NÃO se usa o proxy. */
const PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL;

const isProd = process.env.NODE_ENV === 'production';

/**
 * CSP. `unsafe-inline` em script-src é exigido pelo runtime do Next (hidratação
 * e boot dos chunks); o resto fica fechado.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  ...(isProd ? ['upgrade-insecure-requests'] : []),
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Bundle autocontido com só as dependências alcançadas: a imagem cai de
  // ~1.2 GB para ~150 MB. Ligado só no build da imagem (o Dockerfile define a
  // variável) porque o tracing usa symlink, e o Windows barra symlink sem modo
  // desenvolvedor — deixar ligado sempre quebraria o `pnpm build` local.
  ...(process.env.NEXT_OUTPUT_STANDALONE === 'true' && { output: 'standalone' }),

  // O typecheck e o lint rodam no CI; repetir aqui só deixa o build lento.
  eslint: { ignoreDuringBuilds: true },

  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
      ...(isProd ? [] : [{ protocol: 'http', hostname: 'localhost' }]),
    ],
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 60,
  },

  async rewrites() {
    // Em modo cross-domain o navegador fala direto com a API — sem proxy.
    if (PUBLIC_API_URL) return [];
    return [
      {
        source: '/api/v1/:path*',
        destination: `${API_INTERNAL_URL}/api/v1/:path*`,
      },
    ];
  },

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          ...(isProd
            ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
            : []),
        ],
      },
      {
        // O painel nunca deve ser cacheado por CDN ou proxy intermediário.
        source: '/admin/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }],
      },
    ];
  },
};

export default nextConfig;
