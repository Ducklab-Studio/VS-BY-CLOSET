'use client';

import { useState, useTransition } from 'react';
import { updatePieceAction } from './actions';
import { ConfirmDialog } from '@/components/closetadmin/ConfirmDialog';

/**
 * Campo "Ativa" é especial: desativar e REATIVAR exigem confirmação explícita —
 * inclusive pra peça que a sincronização Shopify tirou de circulação, onde
 * reativar manualmente sem a variante ter voltado é uma decisão consciente
 * (ver pieces.service.ts: reativar manualmente limpa o marcador da
 * sincronização, então "assume" a responsabilidade por essa peça).
 */
export function PieceActiveToggle({
  pieceId,
  pieceName,
  initialValue,
  missingVariantReason,
}: {
  pieceId: string;
  pieceName: string;
  initialValue: boolean;
  /** Presente = foi a sincronização de catálogo que desativou (ver shopifyVariantMissingAt). */
  missingVariantReason: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function deactivate(reason?: string) {
    const result = await updatePieceAction(pieceId, { active: false, reason });
    if (result.error) throw new Error(result.error);
    setValue(false);
  }

  async function reactivate() {
    const result = await updatePieceAction(pieceId, { active: true });
    if (result.error) throw new Error(result.error);
    setValue(true);
  }

  const switchClassName = `relative h-6 w-11 rounded-full transition-colors disabled:opacity-50 ${value ? 'bg-marsala dark:bg-gold shadow-sm' : 'bg-ink/15 dark:bg-white/20'}`;
  const knobClassName = `absolute top-0.5 h-5 w-5 rounded-full bg-white dark:bg-dark-surface shadow-md transition-all ${value ? 'left-5' : 'left-0.5'}`;

  if (value) {
    return (
      <div>
        <ConfirmDialog
          trigger={<button type="button" disabled={pending} aria-pressed={value} className={switchClassName}><span className={knobClassName} /></button>}
          title="Arquivar peça?"
          description={<><strong>{pieceName}</strong> ficará fora do catálogo e de novas reservas. O histórico e reservas existentes serão preservados.</>}
          confirmLabel="Arquivar"
          requireReason
          danger
          onConfirm={(reason) => startTransition(() => deactivate(reason))}
        />
        {error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      </div>
    );
  }

  const switchEl = (
    <button type="button" aria-pressed={value} disabled={pending} className={switchClassName}>
      <span className={knobClassName} />
    </button>
  );

  return (
    <div>
      <ConfirmDialog
        trigger={switchEl}
        title="Reativar peça?"
        description={
          <>
            <strong>{pieceName}</strong> volta a ficar disponível para reserva e disponibilidade online.
            {missingVariantReason ? ' A variante desta peça foi removida da Shopify — confirme só se ela já foi restaurada ou se você quer manter a peça ativa mesmo assim.' : null}
          </>
        }
        confirmLabel="Reativar"
        onConfirm={reactivate}
      />
      {error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
