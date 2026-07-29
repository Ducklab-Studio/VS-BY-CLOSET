import type { Metadata } from 'next';
import { Poppins, Cinzel } from 'next/font/google';
import './globals.css';
import { SiteChrome } from '@/components/layout/SiteChrome';
import { BooqableScript } from '@/components/booqable/BooqableScript';

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
    default: "Valle's Closet — Aluguel de roupa de neve",
    template: "%s | Valle's Closet",
  },
  description:
    'Alugue roupa de neve premium pelo período exato da sua viagem. Macacões, jaquetas, botas e acessórios com curadoria — receba em casa e devolva sem lavar.',
  keywords: [
    'aluguel de roupa de neve',
    'locação de roupa de neve',
    'macacão de neve',
    'jaqueta de neve',
    'moon boots',
    'roupa para esqui',
  ],
  openGraph: {
    type: 'website',
    locale: 'pt_BR',
    siteName: "Valle's Closet",
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
        {/* Precisa viver no layout raiz: montado por página, cada navegação
            recarregaria a integração e zeraria o carrinho. */}
        <BooqableScript />
      </body>
    </html>
  );
}
