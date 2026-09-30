/**
 * Reserva em montagem ("Adicionar outra peça"): as peças escolhidas, a data de
 * retirada e a opção de devolução ficam guardadas no navegador enquanto o
 * cliente volta ao catálogo para escolher mais peças. Nada disso é reserva:
 * não cria HOLD nem pedido — só vira carrinho no "Alugar agora", todas as
 * peças juntas, com as mesmas datas. Arquivo puro (sem imports) para
 * test/rental-draft.test.mjs.
 */
import type { ReturnChoice } from './rental-selection';

export const RENTAL_DRAFT_KEY = 'vsc_rental_draft';
/** Cópia em cookie (só peças e datas; nada pessoal) para o catálogo já sair do
 *  servidor com a seleção desenhada — sem a barra "pular" depois de carregar. */
export const RENTAL_DRAFT_COOKIE = 'vsc_rental_draft';
/** Mesma aba: avisa catálogo e calendário que a seleção mudou. */
export const RENTAL_DRAFT_EVENT = 'closet:rental-draft';
/** Seleção esquecida: some depois de 3 dias sem mexer. */
export const RENTAL_DRAFT_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export interface DraftPiece {
  readonly variantId: string;
  readonly sku: string;
  readonly title: string;
  readonly handle: string;
  readonly priceAmount: string;
  readonly currencyCode: string;
}

export interface RentalDraft {
  readonly pickup: string | null;
  readonly returnOption: ReturnChoice | null;
  readonly pieces: readonly DraftPiece[];
  readonly updatedAt: number;
}

export const EMPTY_DRAFT: RentalDraft = { pickup: null, returnOption: null, pieces: [], updatedAt: 0 };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** O handle vira link (`/pecas/<handle>`): só o formato de handle da Shopify. */
const HANDLE = /^[a-z0-9][a-z0-9-]{0,200}$/i;
const isPiece = (value: unknown): value is DraftPiece => {
  const p = value as Record<string, unknown> | null;
  return (
    !!p &&
    ['variantId', 'sku', 'title', 'handle', 'priceAmount', 'currencyCode'].every((key) => typeof p[key] === 'string' && (p[key] as string).length > 0 && (p[key] as string).length <= 300) &&
    HANDLE.test(p.handle as string)
  );
};

/** Guardado há mais de RENTAL_DRAFT_TTL_MS (ou ilegível)? */
export function isDraftExpired(raw: string | null, now: number): boolean {
  if (!raw) return false;
  try {
    const updatedAt = (JSON.parse(raw) as Partial<RentalDraft>).updatedAt;
    return typeof updatedAt !== 'number' || now - updatedAt > RENTAL_DRAFT_TTL_MS;
  } catch {
    return true;
  }
}

/** Lê o que estava guardado; qualquer coisa inválida vira seleção vazia. A
 *  validade (TTL) é conferida por quem lê o armazenamento (`loadDraft`). */
export function parseDraft(raw: string | null): RentalDraft {
  if (!raw) return EMPTY_DRAFT;
  try {
    const value = JSON.parse(raw) as Partial<RentalDraft>;
    if (typeof value.updatedAt !== 'number') return EMPTY_DRAFT;
    const pieces = Array.isArray(value.pieces) ? dedupe(value.pieces.filter(isPiece)) : [];
    const pickup = typeof value.pickup === 'string' && ISO_DATE.test(value.pickup) ? value.pickup : null;
    const returnOption = value.returnOption === 'saturday' || value.returnOption === 'mondayMorning' ? value.returnOption : null;
    return { pickup, returnOption, pieces, updatedAt: value.updatedAt };
  } catch {
    return EMPTY_DRAFT;
  }
}

function dedupe(pieces: readonly DraftPiece[]): DraftPiece[] {
  const seen = new Set<string>();
  return pieces.filter((piece) => (seen.has(piece.variantId) ? false : (seen.add(piece.variantId), true)));
}

/** Peças da reserva: as já escolhidas + a peça da página (uma vez só). */
export function selectionWith(draft: RentalDraft, current: DraftPiece | null): DraftPiece[] {
  return dedupe(current ? [...draft.pieces, current] : [...draft.pieces]);
}

export type AddResult = { readonly draft: RentalDraft; readonly added: true } | { readonly draft: RentalDraft; readonly added: false; readonly reason: 'duplicate' | 'limit' };

/**
 * Inclui uma peça. Mesma variante nunca entra duas vezes. `otherPieces` são as
 * peças que já estão no carrinho fora desta seleção: contam para o limite.
 */
export function addPiece(draft: RentalDraft, piece: DraftPiece, maxPieces: number | null, otherPieces: number): AddResult {
  if (draft.pieces.some((p) => p.variantId === piece.variantId)) return { draft, added: false, reason: 'duplicate' };
  if (maxPieces !== null && draft.pieces.length + otherPieces + 1 > maxPieces) return { draft, added: false, reason: 'limit' };
  return { draft: { ...draft, pieces: [...draft.pieces, piece] }, added: true };
}

export function removePiece(draft: RentalDraft, variantId: string): RentalDraft {
  return { ...draft, pieces: draft.pieces.filter((p) => p.variantId !== variantId) };
}

/** Retirada e opção de devolução valem para TODAS as peças da reserva. */
export function withDates(draft: RentalDraft, pickup: string | null, returnOption: ReturnChoice | null): RentalDraft {
  return { ...draft, pickup: pickup && ISO_DATE.test(pickup) ? pickup : null, returnOption };
}

/** Já atingiu o máximo de peças por reserva? */
export function atPieceLimit(selectionCount: number, otherPieces: number, maxPieces: number | null): boolean {
  return maxPieces !== null && selectionCount + otherPieces >= maxPieces;
}

/** Soma dos valores (o valor do aluguel não muda com os dias). `null` se as moedas divergirem. */
export function totalPrice(pieces: readonly DraftPiece[]): { amount: string; currencyCode: string } | null {
  if (pieces.length === 0) return null;
  const currency = pieces[0].currencyCode;
  if (pieces.some((p) => p.currencyCode !== currency)) return null;
  const cents = pieces.reduce((sum, p) => sum + Math.round(Number(p.priceAmount) * 100), 0);
  return Number.isFinite(cents) ? { amount: (cents / 100).toFixed(2), currencyCode: currency } : null;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Texto guardado ainda válido (vencido = `null`). */
export function readDraftRaw(storage: KeyValueStore | null, now: number): string | null {
  try {
    const raw = storage?.getItem(RENTAL_DRAFT_KEY) ?? null;
    return isDraftExpired(raw, now) ? null : raw;
  } catch {
    return null;
  }
}

export function loadDraft(storage: KeyValueStore | null, now: number): RentalDraft {
  return parseDraft(readDraftRaw(storage, now));
}

/** Valor do cookie espelho (`null` = apagar). Mesmo conteúdo do armazenamento. */
export function draftCookie(draft: RentalDraft, now: number): string | null {
  return draft.pieces.length === 0 ? null : encodeURIComponent(JSON.stringify({ ...draft, updatedAt: now }));
}

/** Lê o cookie espelho (no servidor). Vencido ou inválido = `null`. */
export function draftRawFromCookie(value: string | undefined, now: number = Date.now()): string | null {
  if (!value) return null;
  try {
    const raw = decodeURIComponent(value);
    return isDraftExpired(raw, now) || parseDraft(raw).pieces.length === 0 ? null : raw;
  } catch {
    return null;
  }
}

/** Seleção sem peças não fica guardada; o carimbo de tempo é o do momento de salvar. */
export function saveDraft(storage: KeyValueStore | null, draft: RentalDraft, now: number): void {
  try {
    if (draft.pieces.length === 0) storage?.removeItem(RENTAL_DRAFT_KEY);
    else storage?.setItem(RENTAL_DRAFT_KEY, JSON.stringify({ ...draft, updatedAt: now }));
  } catch {
    // Navegador anônimo/armazenamento bloqueado: a seleção vale só nesta página.
  }
}
