import type { Metadata } from 'next';
import Script from 'next/script';
import './globals.css';
import { SiteChrome } from '@/components/SiteChrome';
import { ExtensionAttrGuard } from '@/components/ExtensionAttrGuard';
import { EXTENSION_ATTR_SCRIPT } from '@/lib/extension-attrs';

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

const THEME_SCRIPT = `
(function() {
  try {
    // Dark mode é exclusivo do /closetadmin — o site público nunca deve
    // herdar a preferência de tema salva pela equipe neste navegador.
    // Fora dessa rota, nem lê o localStorage: o <html> fica sem a classe
    // 'dark' e a vitrine renderiza sempre na identidade cream/bordô.
    if (!location.pathname.startsWith('/closetadmin')) return;
    var stored = localStorage.getItem('closetadmin_theme');
    var dark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (dark) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  } catch(e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      {/* suppressHydrationWarning cobre só os atributos do próprio <body> —
          é o alcance real da prop: um nível. Os <div> descendentes, que são
          a maioria dos carimbos de extensão, ficam por conta do script
          abaixo (ver src/lib/extension-attrs.ts). */}
      <body className="font-body antialiased" suppressHydrationWarning>
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_SCRIPT}
        </Script>
        {/* next/script em vez de <script> cru: um <script> escrito direto no
            JSX faz o React avisar "Scripts inside React components are never
            executed when rendering on the client" — trocaria um erro de
            console por outro. Precisa vir antes do Header pra instalar o
            observer antes de esses <div> serem analisados. */}
        <Script id="extension-attr-scrub" strategy="beforeInteractive">
          {EXTENSION_ATTR_SCRIPT}
        </Script>
        <ExtensionAttrGuard />
        <SiteChrome>{children}</SiteChrome>
      </body>
    </html>
  );
}
