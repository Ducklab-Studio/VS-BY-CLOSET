'use client';

import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@/components/closetadmin/ConfirmDialog';
import { restoreReservationAction } from './actions';

/**
 * Achado real (mesmo bug do ClearListButton): `revalidatePath` dentro
 * da Server Action invalida o cache no servidor, mas não faz esta
 * página já montada buscar os dados de novo sozinha — sem
 * `router.refresh()` aqui, a restauração acontecia de verdade no banco
 * mas o selo "Arquivada" e o botão continuavam com o estado antigo até
 * um F5 manual.
 */
export function RestoreButton({ reservationId }: { reservationId: string }) {
  const router = useRouter();
  return (
    <ConfirmDialog
      trigger={
        <button
          type="button"
          className="rounded-lg border border-ink/15 dark:border-white/15 bg-white dark:bg-dark-surface px-3.5 py-2 text-sm font-medium text-ink/70 dark:text-dark-text transition hover:bg-ink/5 dark:hover:bg-white/10"
        >
          Restaurar reserva
        </button>
      }
      title="Restaurar esta reserva?"
      description="Ela volta a aparecer na listagem operacional padrão. O status, itens e histórico não mudam — só o arquivamento é desfeito."
      confirmLabel="Restaurar"
      onConfirm={async () => {
        const result = await restoreReservationAction(reservationId);
        if (result.error) throw new Error(result.error);
        router.refresh();
      }}
    />
  );
}
