'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/closetadmin/ui';

/**
 * Falha inesperada numa tela do painel (API fora do ar, timeout, bug). Antes
 * caía no erro da loja pública; agora fica dentro do painel, com o menu, e
 * "Tentar novamente" usa `retry()` — busca os dados de novo, não só redesenha.
 * A mensagem é genérica: detalhe técnico do erro nunca vai para a tela.
 */
export default function ClosetAdminError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="space-y-4">
      <ErrorState message="Algo falhou ao carregar os dados. Verifique a conexão e tente novamente." />
      <button
        type="button"
        onClick={() => retry()}
        className="rounded-lg bg-marsala px-3.5 py-2 text-sm font-medium text-white transition hover:opacity-90 dark:bg-gold dark:text-ink"
      >
        Tentar novamente
      </button>
    </div>
  );
}
