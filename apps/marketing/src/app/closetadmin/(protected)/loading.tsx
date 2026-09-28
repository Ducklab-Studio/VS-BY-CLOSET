import { Skeleton } from '@/components/closetadmin/ui';

/** Enquanto a tela busca os dados na API: o menu continua usável e a área
 *  de conteúdo mostra o esqueleto, em vez de a navegação parecer travada. */
export default function ClosetAdminLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Carregando…</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="mt-2 h-4 w-72" />
      <div className="mt-6 space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}
