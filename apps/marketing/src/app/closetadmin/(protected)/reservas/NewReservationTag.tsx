'use client';

import { useEffect } from 'react';
import { RESERVATION_ATTENTION_STATUSES } from '@/lib/reservation-attention';

/** Reservas que estavam novas quando apareceram nesta página: continuam com a
 *  etiqueta até sair da página, mesmo depois de marcadas como vistas. */
const seenAsNew = new Set<string>();

export function forgetNewReservations(): void {
  seenAsNew.clear();
}

/** Etiqueta "Nova" na linha da reserva (mesma ideia do "Novo" do Valle Pass). */
export function NewReservationTag({ id, status, needsAttention }: { id: string; status: string; needsAttention: boolean }) {
  useEffect(() => {
    if (needsAttention) seenAsNew.add(`${id}@${status}`);
  }, [id, status, needsAttention]);
  const stillNew = (RESERVATION_ATTENTION_STATUSES as readonly string[]).includes(status) && seenAsNew.has(`${id}@${status}`);
  if (!needsAttention && !stillNew) return null;
  return (
    <span
      data-testid="reservation-new-tag"
      className="rounded-full bg-marsala px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cream dark:bg-gold dark:text-neutral-950"
    >
      Nova
    </span>
  );
}
