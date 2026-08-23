import type { Metadata } from 'next';
import './globals.css';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'VS by Closet — Aluguel de roupa de neve',
    template: '%s | VS by Closet',
  },
  description: 'Reserve online. Retire ao chegar no Chile.',
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      {/* suppressHydrationWarning: extensões de navegador (ex.: Bitdefender)
          injetam atributos como bis_skin_checked no <body> antes do React
          hidratar. Isso não é bug do site — o conteúdo renderizado é sempre
          igual entre servidor e cliente, só esses atributos de terceiros
          divergem. Recomendação oficial do Next.js para esse cenário. */}
      <body className="font-body antialiased" suppressHydrationWarning>
        <Header />
        <main>{children}</main>
        <Footer />
      </body>
    </html>
  );
}
