import type { MetadataRoute } from 'next';

const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

// Exigido pelo `output: export`: sem isto o Next trata a rota como dinâmica e
// aborta o build estático.
export const dynamic = 'force-static';

/**
 * Gerado em vez de estático em public/: o sitemap precisa de URL absoluta, e o
 * domínio só é conhecido em tempo de build pela NEXT_PUBLIC_SITE_URL.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
