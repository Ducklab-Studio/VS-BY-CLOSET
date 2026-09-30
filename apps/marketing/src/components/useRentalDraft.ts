'use client';

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { RENTAL_DRAFT_COOKIE, RENTAL_DRAFT_EVENT, RENTAL_DRAFT_KEY, RENTAL_DRAFT_TTL_MS, draftCookie, parseDraft, readDraftRaw, saveDraft, type RentalDraft } from '@/lib/rental-draft';
import { isValePassProduct } from '@/lib/vale-pass-product';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === RENTAL_DRAFT_KEY) onChange();
  };
  window.addEventListener(RENTAL_DRAFT_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(RENTAL_DRAFT_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

/** O texto guardado (string, já sem os vencidos): compara por valor, então
 *  re-render só quando muda. */
const snapshot = () => readDraftRaw(storage(), Date.now());

/**
 * Reserva em montagem, compartilhada entre calendário, catálogo e cards — nesta
 * aba (evento) e nas outras (evento `storage`). No servidor e na hidratação
 * vale `initialRaw` (o cookie espelho lido pela página; ausente = vazia), para
 * o HTML do servidor e o do navegador serem iguais; depois vale o armazenamento.
 */
export function useRentalDraft(initialRaw?: string | null): { draft: RentalDraft; loaded: boolean; write: (next: RentalDraft) => void } {
  const raw = useSyncExternalStore(subscribe, snapshot, () => (initialRaw === undefined ? undefined : initialRaw));
  // Valle Pass nunca entra na reserva de aluguel, nem vindo de um armazenamento adulterado.
  const draft = useMemo(() => {
    const parsed = parseDraft(raw ?? null);
    const pieces = parsed.pieces.filter((piece) => !isValePassProduct({ variantId: piece.variantId }));
    return pieces.length === parsed.pieces.length ? parsed : { ...parsed, pieces };
  }, [raw]);
  const write = useCallback((next: RentalDraft) => {
    const now = Date.now();
    saveDraft(storage(), next, now);
    const cookie = draftCookie(next, now);
    document.cookie = cookie
      ? `${RENTAL_DRAFT_COOKIE}=${cookie}; Path=/; Max-Age=${Math.floor(RENTAL_DRAFT_TTL_MS / 1000)}; SameSite=Lax`
      : `${RENTAL_DRAFT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
    window.dispatchEvent(new Event(RENTAL_DRAFT_EVENT));
  }, []);
  return { draft, loaded: raw !== undefined, write };
}
