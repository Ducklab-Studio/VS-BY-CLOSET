import type { MetadataRoute } from 'next';

const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

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
