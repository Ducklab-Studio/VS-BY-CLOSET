'use client';

import { ConfirmDialog } from '@/components/closetadmin/ConfirmDialog';
import { cancelReservationAction } from './actions';

export function CancelButton({ reservationId }: { reservationId: string }) {
  return (
    <ConfirmDialog
      trigger={
        <button type="button" className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50/50 dark:bg-red-950/30 px-3.5 py-2 text-sm font-medium text-red-700 dark:text-red-400 hover:bg-red-100/60 dark:hover:bg-red-900/40 transition">
          Cancelar reserva
        </button>
      }
      title="Cancelar esta reserva?"
      description="A unidade será liberada e o cliente deixa de constar como ocupando a peça. Esta ação fica registrada na auditoria."
      confirmLabel="Cancelar reserva"
      requireReason
      danger
      onConfirm={async (reason) => {
        const result = await cancelReservationAction(reservationId, reason ?? '');
        if (result.error) throw new Error(result.error);
      }}
    />
  );
}
