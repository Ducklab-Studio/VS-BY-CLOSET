'use client';

import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@/components/closetadmin/ConfirmDialog';
import { recordOccurrenceAction, releaseHoldAction } from './actions';

type ItemAction = 'release-hold' | 'not-returned' | 'note';

const CONTENT: Record<ItemAction, { label: string; title: string; description: string; danger?: boolean }> = {
  'release-hold': {
    label: 'Liberar peça',
    title: 'Liberar peça retida?',
    description: 'Confirma que a manutenção/avaria foi resolvida. A peça só volta ao estoque depois de concluir a higienização. A liberação fica registrada com o seu nome.',
  },
  'not-returned': {
    label: 'Peça não devolvida',
    title: 'Registrar peça não devolvida?',
    description: 'Fica registrado no histórico. A peça continua indisponível e nenhuma cobrança é gerada.',
    danger: true,
  },
  note: {
    label: 'Adicionar observação',
    title: 'Adicionar observação à peça',
    description: 'A observação fica no histórico da peça e não pode ser editada nem apagada.',
  },
};

/** Ações com motivo/texto obrigatório (ConfirmDialog já protege contra duplo clique). */
export function ItemActionButton({
  reservationId,
  reservationItemId,
  action,
  code,
}: {
  reservationId: string;
  reservationItemId: string;
  action: ItemAction;
  code: string;
}) {
  const router = useRouter();
  const content = CONTENT[action];
  return (
    <ConfirmDialog
      trigger={
        <button
          type="button"
          data-testid={`${action}-${code}`}
          className="rounded-lg border border-ink/15 dark:border-white/15 px-3.5 py-2 text-sm font-medium text-ink dark:text-dark-text hover:bg-ink/5 dark:hover:bg-white/10 transition"
        >
          {content.label}
        </button>
      }
      title={content.title}
      description={content.description}
      confirmLabel={content.label}
      requireReason
      danger={content.danger}
      onConfirm={async (text) => {
        const reason = text ?? '';
        const result =
          action === 'release-hold'
            ? await releaseHoldAction(reservationId, reservationItemId, reason)
            : await recordOccurrenceAction(reservationId, reservationItemId, action === 'not-returned' ? 'not_returned' : 'note', reason);
        if (result.error) throw new Error(result.error);
        router.refresh();
      }}
    />
  );
}
