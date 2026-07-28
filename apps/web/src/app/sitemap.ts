import type { MetadataRoute } from 'next';

const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

/**
 * Sitemap das páginas do site.
 *
 * O catálogo em si não entra: os produtos são renderizados pelo Booqable no
 * navegador, então não existem como URLs próprias aqui. Quem indexa produto é
 * a loja do Booqable.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const rotas: Array<{ path: string; priority: number; changeFrequency: 'weekly' | 'monthly' | 'yearly' }> = [
    { path: '', priority: 1, changeFrequency: 'weekly' },
    { path: '/catalogo', priority: 0.9, changeFrequency: 'weekly' },
    { path: '/como-funciona', priority: 0.8, changeFrequency: 'monthly' },
    { path: '/faq', priority: 0.7, changeFrequency: 'monthly' },
    { path: '/contato', priority: 0.6, changeFrequency: 'yearly' },
    { path: '/trocas-e-devolucoes', priority: 0.4, changeFrequency: 'yearly' },
    { path: '/termos-de-uso', priority: 0.3, changeFrequency: 'yearly' },
    { path: '/politica-de-privacidade', priority: 0.3, changeFrequency: 'yearly' },
  ];

  const lastModified = new Date();

  return rotas.map(({ path, priority, changeFrequency }) => ({
    url: `${siteUrl}${path}`,
    lastModified,
    changeFrequency,
    priority,
  }));
}
