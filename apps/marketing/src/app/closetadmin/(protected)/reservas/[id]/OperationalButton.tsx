'use client';

import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@/components/closetadmin/ConfirmDialog';
import { operationalReservationAction } from './actions';

type Action = 'receive' | 'start-cleaning' | 'complete-cleaning';

const CONTENT: Record<Action, { label: string; title: string; description: string }> = {
  receive: {
    label: 'Registrar devolução', title: 'Confirmar recebimento da peça?',
    description: 'A peça continuará indisponível até a higienização ser concluída.',
  },
  'start-cleaning': {
    label: 'Iniciar higienização', title: 'Iniciar higienização?',
    description: 'A peça continuará indisponível durante a higienização.',
  },
  'complete-cleaning': {
    label: 'Concluir higienização', title: 'Confirmar higienização concluída?',
    description: 'A peça será liberada para novas reservas após esta confirmação.',
  },
};

export function OperationalButton({ reservationId, reservationItemId, action }: { reservationId: string; reservationItemId: string; action: Action }) {
  const router = useRouter();
  const content = CONTENT[action];
  return <ConfirmDialog
    trigger={<button type="button" className="rounded-lg border border-ink/15 dark:border-white/15 px-3.5 py-2 text-sm font-medium text-ink dark:text-dark-text hover:bg-ink/5 dark:hover:bg-white/10 transition">{content.label}</button>}
    title={content.title}
    description={content.description}
    confirmLabel={content.label}
    onConfirm={async () => {
      const result = await operationalReservationAction(reservationId, reservationItemId, action);
      if (result.error) throw new Error(result.error);
      router.refresh();
    }}
  />;
}
