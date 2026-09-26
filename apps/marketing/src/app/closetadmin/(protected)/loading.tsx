import { Skeleton } from '@/components/closetadmin/ui';

/**
 * Exibido dentro do AdminShell (menu lateral permanece) enquanto a página
 * busca dados. Erros continuam sendo tratados por cada página, não aqui.
 */
export default function ClosetAdminLoading() {
  return (
    <div aria-busy="true" aria-label="Carregando">
      <Skeleton className="mb-2 h-8 w-64" />
      <Skeleton className="mb-8 h-4 w-96 max-w-full" />
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
