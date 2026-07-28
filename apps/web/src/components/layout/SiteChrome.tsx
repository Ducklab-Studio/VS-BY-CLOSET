'use client';

import { usePathname } from 'next/navigation';
import { Header } from './Header';
import { Footer } from './Footer';

/** O painel admin tem seu próprio layout — não exibe header/footer da loja. */
export function SiteChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname.startsWith('/admin')) return <>{children}</>;

  return (
    <>
      <Header />
      <main id="conteudo" className="min-h-screen">
        {children}
      </main>
      <Footer />
    </>
  );
}
