'use client';

import { usePathname } from 'next/navigation';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';

/**
 * Fase 9 — /closetadmin precisa ficar "isolado estruturalmente das
 * páginas públicas" (Header/Footer/nav do site nunca aparecem lá; o
 * painel tem seu próprio chrome, ver AdminShell). Sem duplicar
 * `app/layout.tsx` num segundo root layout (que exigiria mover as 8
 * rotas públicas existentes pra dentro de um route group — risco
 * desnecessário pra uma mudança puramente visual), este wrapper client
 * decide por pathname. A parte pública continua exatamente como antes.
 */
export function SiteChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isClosetAdmin = pathname?.startsWith('/closetadmin') ?? false;

  if (isClosetAdmin) return <>{children}</>;

  return (
    <div className="storefront">
      <Header />
      <main>{children}</main>
      <Footer />
    </div>
  );
}
