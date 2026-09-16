'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eraser, RotateCcw } from 'lucide-react';
import { ConfirmDialog } from '@/components/closetadmin/ConfirmDialog';
import { clearOldReservationsAction, restoreManyAction } from './archive-actions';

/**
 * "Limpar lista" — oculta da listagem operacional as reservas
 * `expired`/`cancelled` mais antigas (nunca `returned`/`completed`,
 * nunca ativas nem aguardando pagamento). Nunca apaga do banco, nunca
 * cancela e nunca toca em pagamento — só marca `archivedAt` (ver
 * ReservationArchiveService.execute, reaproveitado por
 * clearOldReservationsAction). Elas continuam acessíveis pelo filtro
 * "Mostrar arquivadas" e podem ser desfeitas com "Restaurar lista"
 * (exatamente o lote que esta execução ocultou) ou individualmente na
 * tela de detalhe de cada reserva.
 *
 * Server refresh (não router.push) depois de limpar/restaurar — os
 * filtros atuais de origem, status, busca e datas continuam na URL,
 * intocados.
 *
 * Achado real: `revalidatePath` dentro da Server Action invalida o
 * cache no servidor, mas NÃO faz a página já montada buscar os dados
 * de novo sozinha quando a action é chamada como função direta (fora
 * de um <form>) — sem um `router.refresh()` explícito aqui, o
 * arquivamento acontecia de verdade no banco (confirmado: a reserva
 * some da listagem depois de um F5 manual) mas a tabela na tela
 * continuava mostrando o estado antigo, parecendo que o botão "não
 * fazia nada".
 */
export function ClearListButton({ estimatedCount }: { estimatedCount: number }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [lastArchivedIds, setLastArchivedIds] = useState<readonly string[] | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClear() {
    setError(null);
    const { result, error: clearError } = await clearOldReservationsAction();
    if (clearError || !result) {
      throw new Error(clearError ?? 'Não foi possível ocultar as reservas.');
    }
    setMessage(
      result.archivedCount > 0
        ? `${result.archivedCount} reserva${result.archivedCount === 1 ? '' : 's'} ${result.archivedCount === 1 ? 'foi ocultada' : 'foram ocultadas'} da lista.`
        : 'Nenhuma reserva expirada ou cancelada estava elegível para ocultar agora.',
    );
    setLastArchivedIds(result.archivedIds.length > 0 ? result.archivedIds : null);
    router.refresh();
  }

  async function handleRestore() {
    if (!lastArchivedIds) return;
    setRestoring(true);
    setError(null);
    try {
      const { restoredCount, error: restoreError } = await restoreManyAction(lastArchivedIds);
      if (restoreError) {
        setError(restoreError);
        return;
      }
      setMessage(`${restoredCount} reserva${restoredCount === 1 ? '' : 's'} ${restoredCount === 1 ? 'foi restaurada' : 'foram restauradas'} para a lista.`);
      setLastArchivedIds(null);
      router.refresh();
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ConfirmDialog
        trigger={
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink/15 dark:border-white/15 px-3 py-2 text-xs font-medium text-ink/55 dark:text-dark-muted transition hover:bg-ink/5 hover:text-ink dark:hover:bg-white/5 dark:hover:text-dark-text"
          >
            <Eraser size={14} />
            Limpar lista
          </button>
        }
        title="Limpar lista?"
        description={
          <>
            Isso vai ocultar da listagem as reservas <strong>expiradas</strong> e <strong>canceladas</strong> mais antigas
            {estimatedCount > 0 ? ` (até ${estimatedCount} candidata${estimatedCount === 1 ? '' : 's'})` : ''}. Reservas ativas,
            aguardando pagamento ou que precisam de atenção nunca são afetadas. Nenhuma reserva é apagada nem tem o status
            alterado — elas continuam disponíveis pelo filtro &quot;Mostrar arquivadas&quot; e podem ser restauradas depois.
          </>
        }
        confirmLabel="Limpar lista"
        onConfirm={handleClear}
      />

      {message ? (
        <span className="inline-flex flex-wrap items-center gap-2 rounded-lg bg-ink/5 dark:bg-white/5 px-2.5 py-1.5 text-xs text-ink/70 dark:text-dark-muted">
          {message}
          {lastArchivedIds ? (
            <button
              type="button"
              disabled={restoring}
              onClick={handleRestore}
              className="inline-flex items-center gap-1 font-medium text-marsala dark:text-gold hover:underline disabled:opacity-60"
            >
              <RotateCcw size={12} />
              {restoring ? 'Restaurando…' : 'Restaurar lista'}
            </button>
          ) : null}
        </span>
      ) : null}

      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </div>
  );
}
