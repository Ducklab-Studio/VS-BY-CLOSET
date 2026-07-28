import type { Metadata } from 'next';
import { Poppins, Cinzel } from 'next/font/google';
import './globals.css';
import { SiteChrome } from '@/components/layout/SiteChrome';

const poppins = Poppins({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-body',
});

const cinzel = Cinzel({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-heading',
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'Minha Loja — Moon Boots e acessórios de neve',
    template: '%s | Minha Loja',
  },
  description:
    'Moon Boots e acessórios premium para a neve. Qualidade, conforto térmico e entrega rápida.',
  keywords: ['moon boots', 'botas de neve', 'acessórios de neve', 'e-commerce', 'loja online'],
  openGraph: {
    type: 'website',
    locale: 'pt_BR',
    siteName: 'Minha Loja',
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${poppins.variable} ${cinzel.variable}`}>
      <body className="bg-ink font-sans text-white">
        <a href="#conteudo" className="skip-link">
          Pular para o conteúdo
        </a>
        <SiteChrome>{children}</SiteChrome>
      </body>
    </html>
  );
}
