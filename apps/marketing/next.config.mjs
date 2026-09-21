/**
 * Aplicação Next.js ativa: vitrine pública + carrinho + ClosetAdmin.
 *
 * Catálogo/carrinho usam Shopify; disponibilidade e regras de aluguel usam
 * o reservations-api. O proxy `/api/availability` mantém a consulta pública
 * same-origin e evita depender de CORS ou de uma URL absoluta gravada no
 * bundle durante o build.
 */

const isDev = process.env.NODE_ENV !== 'production';

/**
 * Origens que o NAVEGADOR realmente chama, derivadas das mesmas variáveis
 * que o código do cliente usa — em vez de um host fixo escrito aqui, que
 * ficaria errado no dia em que a API mudasse de endereço. Cada valor é uma
 * URL completa de endpoint; só o `origin` entra na CSP.
 *
 * Se uma variável não estiver definida no build (é o caso da CI e do build
 * de demonstração), ela simplesmente não contribui com nada: a vitrine cai
 * no proxy same-origin `/api/availability`, já coberto por `'self'`.
 */
const apiOrigins = [
  process.env.NEXT_PUBLIC_AVAILABILITY_URL,
  process.env.NEXT_PUBLIC_RENTAL_PLAN_URL,
  process.env.NEXT_PUBLIC_HOLDS_URL,
  process.env.NEXT_PUBLIC_CHECKOUT_URL,
  process.env.NEXT_PUBLIC_RESERVATIONS_URL,
  process.env.NEXT_PUBLIC_RESERVATIONS_API_URL,
]
  .map((value) => {
    try {
      const { origin, protocol } = new URL(String(value ?? '').trim());
      return protocol === 'https:' || protocol === 'http:' ? origin : null;
    } catch {
      return null;
    }
  })
  .filter((origin) => origin !== null);

const uniqueApiOrigins = [...new Set(apiOrigins)];

/**
 * Content-Security-Policy.
 *
 * Segunda camada contra XSS: a primeira é a sanitização da descrição da
 * peça em `src/lib/product-description.ts`. Esta política existe porque
 * sanitizador de HTML tem histórico de bypass, e porque esta origem é a
 * mesma do `/closetadmin`.
 *
 * ⚠️ `script-src` precisa de `'unsafe-inline'`, e isso limita o que a CSP
 * consegue prometer. O app tem dois scripts inline legítimos em
 * `layout.tsx` (`theme-init` e `extension-attr-scrub`, ambos
 * `beforeInteractive`) e o Next injeta os próprios scripts inline de
 * hidratação. A alternativa seria nonce por requisição, que no App Router
 * exige um `middleware.ts` — arquivo que este projeto não tem, e criar um
 * passa a interceptar TODAS as rotas. Fica como melhoria futura, decidida
 * à parte.
 *
 * Mesmo com `'unsafe-inline'`, a política ainda barra o que dá alcance a um
 * XSS: carregar script de outro domínio, enviar dado para fora via fetch ou
 * formulário, trocar a base de URLs relativas, embutir a página num iframe
 * e carregar plugin/objeto.
 */
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "form-action 'self'",
  // `'unsafe-eval'` só no dev: o Fast Refresh do Next depende dele.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  // Tailwind compila para arquivo, mas framer-motion e GSAP escrevem
  // `style=""` direto no elemento, o que `'unsafe-inline'` cobre.
  "style-src 'self' 'unsafe-inline'",
  // cdn.shopify.com e res.cloudinary.com são os mesmos hosts já liberados
  // em `images.remotePatterns` abaixo. `blob:` cobre as texturas do three.js.
  "img-src 'self' data: blob: https://cdn.shopify.com https://res.cloudinary.com",
  "font-src 'self' data:",
  "media-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  // `ws:`/`wss:` só no dev, para o socket do Fast Refresh.
  `connect-src 'self'${uniqueApiOrigins.length ? ` ${uniqueApiOrigins.join(' ')}` : ''}${isDev ? ' ws: wss:' : ''}`,
  'upgrade-insecure-requests',
].join('; ');

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
          { key: 'Content-Security-Policy', value: csp },
          // Nenhuma tela do projeto usa câmera, microfone, localização,
          // giroscópio ou pagamento pelo navegador — o pagamento acontece
          // no checkout da Shopify, em outra origem.
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
