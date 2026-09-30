/**
 * Seleção do período de aluguel — UMA regra para o resumo da tela, o item do
 * carrinho e o HOLD do checkout, para a data exibida ser sempre a data
 * enviada. Arquivo puro (sem imports) para test/rental-selection.test.mjs.
 *
 * Datas são civis (YYYY-MM-DD), sem hora nem fuso: 2026-10-12 é 12/10 no
 * Chile e em qualquer lugar. Nunca passam por `toISOString()` (UTC).
 */
export type ReturnChoice = 'saturday' | 'mondayMorning';

export interface ReturnOptionInfo {
  readonly type: ReturnChoice;
  readonly date: string;
  readonly window?: string;
  /** Disponibilidade da PRÓPRIA data desta opção (ausente = API antiga: tratada como disponível). */
  readonly available?: boolean;
}

export interface RentalDayInfo {
  readonly date: string;
  readonly bookable: boolean;
  readonly calculatedReturnDate?: string;
  readonly hasSundayReturnException?: boolean;
  readonly returnOptions?: readonly ReturnOptionInfo[];
}

export interface RentalSelection {
  readonly pickup: string;
  readonly return: string;
  /** Opção escolhida quando a devolução calculada cai no domingo. */
  readonly returnOption: ReturnChoice | null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Domingo pela data civil (sem UTC). Data inválida conta como domingo: nunca é enviada. */
export function isSundayISO(iso: string): boolean {
  const match = ISO_DATE.exec(iso);
  if (!match) return true;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getMonth() !== Number(match[2]) - 1 || date.getDay() === 0;
}

/** Opções que podem ser escolhidas: disponíveis e fora do domingo. */
export function selectableReturnOptions(day: RentalDayInfo | undefined): ReturnOptionInfo[] {
  return (day?.returnOptions ?? []).filter((option) => option.available !== false && !isSundayISO(option.date));
}

/**
 * Período efetivo. `null` = ainda não pode alugar: dia indisponível, devolução
 * no domingo sem opção escolhida, opção indisponível ou qualquer devolução
 * num domingo.
 */
export function resolveRentalSelection(day: RentalDayInfo | undefined, choice: ReturnChoice | null): RentalSelection | null {
  if (!day?.bookable || !ISO_DATE.test(day.date)) return null;
  if (!day.hasSundayReturnException) {
    const calculated = day.calculatedReturnDate;
    if (!calculated || isSundayISO(calculated)) return null;
    return { pickup: day.date, return: calculated, returnOption: null };
  }
  const option = selectableReturnOptions(day).find((candidate) => candidate.type === choice);
  return option ? { pickup: day.date, return: option.date, returnOption: option.type } : null;
}

export interface CartLineLike {
  readonly id: string;
  readonly merchandise: { readonly id: string };
  readonly attributes: readonly { readonly key: string; readonly value: string }[];
}

const attribute = (line: CartLineLike, key: string) => line.attributes.find((a) => a.key === key)?.value ?? null;

/**
 * O que fazer no carrinho ao alugar esta peça. A mesma peça nunca vira duas
 * linhas: mesmas datas → nada a fazer (clique duplo, clicar de novo); datas
 * diferentes → a linha existente passa a ter as novas datas (o cliente trocou
 * a opção de devolução antes do checkout).
 */
export function planCartChange(
  lines: readonly CartLineLike[],
  input: { readonly variantId: string; readonly pickup: string; readonly return: string; readonly returnOption?: ReturnChoice | null },
): { readonly kind: 'add' } | { readonly kind: 'noop' | 'update'; readonly lineId: string } {
  const line = lines.find((candidate) => candidate.merchandise.id === input.variantId);
  if (!line) return { kind: 'add' };
  const same =
    attribute(line, '_vsc_pickup') === input.pickup &&
    attribute(line, '_vsc_return') === input.return &&
    (attribute(line, '_vsc_return_option') ?? null) === (input.returnOption ?? null);
  return { kind: same ? 'noop' : 'update', lineId: line.id };
}

/**
 * Opção de devolução de domingo já escolhida na página da peça, para o HOLD
 * do checkout receber exatamente a mesma. Só vale se todas as linhas que a
 * informam concordam; senão `null` (o checkout pergunta).
 */
export function returnOptionFromLines(lines: readonly CartLineLike[]): ReturnChoice | null {
  const values = new Set(lines.map((line) => attribute(line, '_vsc_return_option')).filter((value): value is string => value !== null));
  if (values.size !== 1) return null;
  const [value] = [...values];
  return value === 'saturday' || value === 'mondayMorning' ? value : null;
}
