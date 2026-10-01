'use client';

import { useEffect } from 'react';
import { notifyReservationAttentionChanged } from '@/components/closetadmin/useReservationAttention';
import { markReservationsViewedAction } from '../attention-actions';

/** Abrir o detalhe de uma reserva nova (aba visível) a marca como vista neste
 *  status. Só visualização: status, pagamento, datas e peças não mudam. */
export function MarkReservationViewed({ id, status, needsAttention }: { id: string; status: string; needsAttention: boolean }) {
  useEffect(() => {
    if (!needsAttention) return;
    let done = false;
    const mark = async () => {
      if (done || document.visibilityState !== 'visible') return;
      done = true;
      document.removeEventListener('visibilitychange', mark);
      const result = await markReservationsViewedAction([{ id, status }]);
      if ('error' in result) done = false;
      else if (result.marked > 0) notifyReservationAttentionChanged();
    };
    void mark();
    document.addEventListener('visibilitychange', mark);
    return () => {
      done = true;
      document.removeEventListener('visibilitychange', mark);
    };
  }, [id, status, needsAttention]);
  return null;
}
