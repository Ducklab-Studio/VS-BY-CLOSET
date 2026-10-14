/**
 * Conferência de devolução — regras puras (sem rede, sem React), compartilhadas
 * pela tela e pela server action. O backend revalida tudo: isto só evita ida e
 * volta e mantém as mensagens consistentes. Não há nenhum valor monetário aqui:
 * atraso e condição são FATOS registrados; multas e diárias adicionais dependem
 * de regra comercial ainda não aprovada e não são calculadas.
 */

export const RETURN_CONDITIONS = ['good', 'needs_cleaning', 'needs_maintenance', 'damaged'] as const;
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number];

export interface ConditionInfo {
  readonly label: string;
  readonly hint: string;
  /** Segura a peça fora do estoque até a liberação de um ADMIN. */
  readonly holds: boolean;
  /** Descrição obrigatória. */
  readonly needsNotes: boolean;
  readonly tone: 'ok' | 'warn' | 'bad';
}

export const CONDITION_INFO: Record<ReturnCondition, ConditionInfo> = {
  good: { label: 'Em boas condições', hint: 'Segue para a higienização de rotina.', holds: false, needsNotes: false, tone: 'ok' },
  needs_cleaning: { label: 'Precisa de higienização especial', hint: 'Mancha, odor ou sujeira acima do normal. Segue para a higienização.', holds: false, needsNotes: false, tone: 'warn' },
  needs_maintenance: { label: 'Precisa de manutenção', hint: 'Fica fora do estoque até um administrador liberar.', holds: true, needsNotes: true, tone: 'warn' },
  damaged: { label: 'Danificada', hint: 'Fica fora do estoque até um administrador liberar.', holds: true, needsNotes: true, tone: 'bad' },
};

export const MIN_TEXT = 3;
export const MAX_TEXT = 2000;

export function isReturnCondition(value: unknown): value is ReturnCondition {
  return typeof value === 'string' && (RETURN_CONDITIONS as readonly string[]).includes(value);
}

export interface InspectionInput {
  readonly condition: ReturnCondition;
  readonly notes?: string;
}

/** Devolve a mensagem de erro ou `null` quando a conferência pode ser enviada. */
export function validateInspection(input: { condition?: unknown; notes?: unknown }): string | null {
  if (!isReturnCondition(input.condition)) return 'Escolha a condição da peça antes de confirmar.';
  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  if (notes.length > MAX_TEXT) return `A observação pode ter no máximo ${MAX_TEXT} caracteres.`;
  if (CONDITION_INFO[input.condition].needsNotes && notes.length < MIN_TEXT) {
    return 'Descreva a ocorrência (mínimo 3 caracteres) para peça danificada ou com manutenção.';
  }
  if (notes.length > 0 && notes.length < MIN_TEXT) return 'A observação precisa ter pelo menos 3 caracteres.';
  return null;
}

/** Corpo enviado à API: observação vazia nem é enviada. */
export function toInspectionBody(input: InspectionInput): { condition: ReturnCondition; notes?: string } {
  const notes = input.notes?.trim();
  return notes ? { condition: input.condition, notes } : { condition: input.condition };
}

export function lateLabel(days: number): string {
  if (days <= 0) return 'No prazo';
  return days === 1 ? '1 dia de atraso' : `${days} dias de atraso`;
}

/** Peça que o operador ainda pode receber. */
export function canReceiveItem(item: { status: string }, reservationArchived: boolean): boolean {
  return !reservationArchived && (item.status === 'confirmed' || item.status === 'picked_up');
}

/** Peça devida e já atrasada: permite registrar "não devolvida". */
export function canRecordNotReturned(item: { status: string; overdueDays: number }, reservationArchived: boolean): boolean {
  return canReceiveItem(item, reservationArchived) && item.overdueDays > 0;
}

export interface InspectionView {
  readonly condition: ReturnCondition;
  readonly awaitingRelease: boolean;
}

/** Só ADMIN libera, e só peça retida que ainda não foi liberada. */
export function canReleaseHold(inspection: InspectionView | null, itemStatus: string, isAdmin: boolean, reservationArchived: boolean): boolean {
  return isAdmin && !reservationArchived && inspection?.awaitingRelease === true && (itemStatus === 'returned' || itemStatus === 'cleaning');
}

/** A higienização só pode ser concluída quando a peça não está retida. */
export function canCompleteCleaning(inspection: InspectionView | null, itemStatus: string, reservationArchived: boolean): boolean {
  return !reservationArchived && itemStatus === 'cleaning' && inspection?.awaitingRelease !== true;
}
