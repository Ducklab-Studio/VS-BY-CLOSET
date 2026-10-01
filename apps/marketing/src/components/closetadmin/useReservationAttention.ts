'use client';

import { getReservationAttentionAction } from '@/app/closetadmin/(protected)/reservas/attention-actions';
import { RESERVATION_ATTENTION_CHANNEL, RESERVATION_ATTENTION_EVENT } from '@/lib/reservation-attention';
import { notifyAttentionChanged, useAdminAttention, type AdminAttention, type AdminAttentionSource } from './useAdminAttention';

const SOURCE: AdminAttentionSource = {
  fetchCount: () => getReservationAttentionAction(),
  event: RESERVATION_ATTENTION_EVENT,
  channel: RESERVATION_ATTENTION_CHANNEL,
};

/** Contador de novas reservas de aluguel para o menu — ver useAdminAttention. */
export function useReservationAttention(enabled: boolean): AdminAttention {
  return useAdminAttention(enabled, SOURCE);
}

/** Avisa o menu desta aba e das outras abas que a contagem de reservas mudou. */
export function notifyReservationAttentionChanged(): void {
  notifyAttentionChanged(RESERVATION_ATTENTION_EVENT, RESERVATION_ATTENTION_CHANNEL);
}
