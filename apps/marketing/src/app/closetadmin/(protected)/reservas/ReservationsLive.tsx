'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { RESERVATIONS_REFRESH_MS, rowsToMarkViewed, viewKey, type AttentionRow } from '@/lib/reservation-attention';
import { notifyReservationAttentionChanged } from '@/components/closetadmin/useReservationAttention';
import { markReservationsViewedAction } from './attention-actions';
import { forgetNewReservations } from './NewReservationTag';

/**
 * Página Reservas "ao vivo", sem recarregar: a lista volta do servidor a cada
 * 30 s com a aba visível (e ao voltar para a aba) — reserva nova sincronizada
 * da Shopify aparece sozinha, com os filtros atuais. As reservas novas
 * exibidas, com a aba visível, são marcadas como vistas (uma vez por
 * reserva+status; só visualização) e o menu desta e das outras abas é avisado.
 */
export function ReservationsLive({ rows }: { rows: readonly AttentionRow[] }) {
  const router = useRouter();

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    const timer = window.setInterval(refresh, RESERVATIONS_REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      forgetNewReservations();
    };
  }, [router]);

  const sent = useRef(new Set<string>());
  useEffect(() => {
    const shown = rowsToMarkViewed(rows, sent.current);
    if (shown.length === 0) return;
    let cancelled = false;
    const mark = async () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', mark);
      shown.forEach((row) => sent.current.add(viewKey(row)));
      const result = await markReservationsViewedAction(shown);
      if ('error' in result) shown.forEach((row) => sent.current.delete(viewKey(row)));
      else if (result.marked > 0) notifyReservationAttentionChanged();
    };
    if (document.visibilityState === 'visible') void mark();
    else document.addEventListener('visibilitychange', mark);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', mark);
    };
  }, [rows]);

  return null;
}
