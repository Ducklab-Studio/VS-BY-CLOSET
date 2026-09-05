'use client';

import { useEffect } from 'react';
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

  // Isolamento do dark mode (Fase 10, item 1): o script em layout.tsx só
  // cobre o carregamento inicial (full reload). Navegação client-side do
  // Next (ex.: usar o botão "voltar" saindo do /closetadmin) não
  // reexecuta esse script — este efeito roda a cada troca de rota e
  // garante, de forma redundante e barata, que a vitrine pública nunca
  // fique com a classe 'dark' herdada de uma sessão anterior do painel
  // no mesmo navegador.
  useEffect(() => {
    if (!isClosetAdmin) document.documentElement.classList.remove('dark');
  }, [pathname, isClosetAdmin]);

  if (isClosetAdmin) return <>{children}</>;

  return (
    <div className="storefront">
      <Header />
      <main>{children}</main>
      <Footer />
    </div>
  );
}
