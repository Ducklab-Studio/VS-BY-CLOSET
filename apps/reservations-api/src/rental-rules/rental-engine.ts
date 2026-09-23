/**
 * Motor puro das regras de locação. Sem banco, sem HTTP, sem Shopify —
 * só funções determinísticas que recebem dados e devolvem dados. O
 * frontend não é autoridade sobre nada disto: quando estas funções
 * forem chamadas pela API (fase futura), o backend recalcula tudo do
 * zero a partir do que está no banco, nunca confia em duração/data/preço
 * que o navegador mandou.
 */

import { type CivilDate, addDays, civilDateFromISO, civilDateInZone, diffDays, isBefore, isSunday } from './civil-date';
import { DEFAULT_RENTAL_RULE_CONFIG, type RentalRuleConfig } from './rental-rule-config';

export { isSunday };

export class MaxPiecesExceededError extends Error {
  constructor(pieces: number, max: number) {
    super(`${pieces} peças excede o máximo de ${max} por reserva.`);
    this.name = 'MaxPiecesExceededError';
  }
}

/**
 * "Hoje" na operação — nunca "hoje" na máquina que está rodando o
 * processo. Todo cálculo de antecedência parte daqui, não de `new
 * Date()` cru em outro lugar do código.
 */
export function today(
  config: RentalRuleConfig = DEFAULT_RENTAL_RULE_CONFIG,
  now: Date = new Date(),
): CivilDate {
  return civilDateInZone(now, config.timezone);
}

/**
 * Dois booleanos separados, de propósito — são perguntas diferentes:
 *
 *   reservableOnline           — este item PODE entrar numa reserva
 *                                 online? Acessório: não. Sobretudo/
 *                                 jaqueta/bota: sim.
 *   countsTowardRentalDuration — este item CONTA na conta de dias
 *                                 (1-2:2d / 3-4:3d / 5-6:4d)?
 *
 * Hoje as duas coincidem pra tudo que existe (roupa/bota = true/true,
 * acessório = false/false), mas são coisas conceitualmente diferentes —
 * nada garante que vão continuar sempre juntas (ex.: uma categoria futura
 * podia ser reservável mas não contar pra duração por algum motivo de
 * negócio ainda não imaginado). Separar agora evita que o dia em que
 * elas divergirem vire uma migração de tipo, não só de dado.
 */
export interface RentalCartItem {
  readonly reservableOnline: boolean;
  readonly countsTowardRentalDuration: boolean;
}

export function countRentalPieces(items: readonly RentalCartItem[]): {
  totalPieces: number;
  countedPieces: number;
} {
  const totalPieces = items.length;
  const countedPieces = items.filter((item) => item.countsTowardRentalDuration).length;
  return { totalPieces, countedPieces };
}

/**
 * Peças contáveis → dias de aluguel.
 *
 * Confirmado pelo Anderson: 1–2 peças = 2 dias, 3–4 = 3 dias, 5–6 = 4
 * dias, máximo 6.
 *
 * Contrato estrito: espera countedPieces entre 1 e maxPieces. Não é
 * função desta função decidir o que fazer com 0 ou com excesso — isso é
 * papel de quem monta a reserva (`calculateRentalPlan`), que barra os
 * dois casos ANTES de chamar aqui (0 vira a violação
 * `no_reservable_items`; acima do máximo vira `max_pieces_exceeded`).
 * Acessório não é reservável online (`reservableOnline: false`), então
 * uma reserva legítima nunca chega a 0 peças contáveis por construção —
 * isto aqui é só a rede de segurança pra quem chamar esta função direto,
 * fora do fluxo normal.
 */
export function durationForPieces(
  countedPieces: number,
  config: RentalRuleConfig = DEFAULT_RENTAL_RULE_CONFIG,
): number {
  if (countedPieces <= 0) {
    throw new Error(
      `durationForPieces espera ao menos 1 peça contável (recebeu ${countedPieces}). ` +
        'Uma reserva sem item contável nunca deveria chegar até aqui.',
    );
  }
  if (countedPieces > config.maxPieces) {
    throw new MaxPiecesExceededError(countedPieces, config.maxPieces);
  }
  for (const rule of config.piecesToDaysTable) {
    if (countedPieces <= rule.upTo) return rule.days;
  }
  // Só é alcançável se a tabela de configuração estiver malformada (não
  // cobre até maxPieces) — falha claro em vez de devolver um número
  // arbitrário que mascararia o erro de configuração.
  throw new Error('piecesToDaysTable não cobre a quantidade de peças até maxPieces — configuração inconsistente.');
}

export function validateMaxPieces(
  pieces: number,
  config: RentalRuleConfig = DEFAULT_RENTAL_RULE_CONFIG,
): boolean {
  return pieces >= 0 && pieces <= config.maxPieces;
}

/**
 * CONFIRMADO pelo Anderson: retirada + duração, direto — não é "o
 * último dia com o cliente". Retirada 18 + 3 dias = devolução 21.
 */
export function calculateReturnDate(pickupDate: CivilDate, durationDays: number): CivilDate {
  return addDays(pickupDate, durationDays);
}

/**
 * Início da operação apenas: retirada antes de `operationStartDate` não é
 * aceita; sem data configurada, não há restrição. Data completa (com ano),
 * então nada se repete de um ano pro outro. Períodos fechados são
 * `operational_blocks`; domingo e antecedência são regras separadas (ver
 * `calculateRentalPlan`).
 */
export function isOnlineReservationAllowed(
  date: CivilDate,
  config: RentalRuleConfig = DEFAULT_RENTAL_RULE_CONFIG,
): boolean {
  if (config.operationStartDate === null) return true;
  return !isBefore(date, civilDateFromISO(config.operationStartDate));
}

/**
 * Antecedência mínima: `pickupDate - today >= minAdvanceDays`. Exemplo
 * confirmado: hoje dia 03, +15 = dia 18 é a PRIMEIRA data válida (18
 * permitido, 17 não) — por isso `>=`, não `>`.
 */
export function validateMinimumAdvance(
  pickupDate: CivilDate,
  todayDate: CivilDate,
  config: RentalRuleConfig = DEFAULT_RENTAL_RULE_CONFIG,
): boolean {
  return diffDays(pickupDate, todayDate) >= config.minAdvanceDays;
}

export interface SundayReturnOption {
  readonly type: 'saturday' | 'mondayMorning';
  readonly date: CivilDate;
  /** Só existe pra mondayMorning — sábado ainda não tem horário
   *  definido; o Anderson foi explícito em não inventar um. */
  readonly window?: string;
}

export interface RentalPlanInput {
  readonly pickupDate: CivilDate;
  /**
   * Itens crus, não números pré-somados — de propósito. Precisamos ver
   * cada item pra checar `reservableOnline`, não só contar quantidade;
   * se este contrato recebesse só `totalPieces`/`countedPieces` já
   * somados, o sinal de "tem acessório aqui" se perderia antes de
   * chegar aqui, e o backend não teria como rejeitar.
   */
  readonly items: readonly RentalCartItem[];
}

export type PlanViolation =
  /** Presença de item com reservableOnline=false — ex.: acessório. A
   *  reserva inteira é rejeitada, o item não é só descartado da soma. */
  | 'contains_non_reservable_item'
  /** Nenhum item contável sobrou (carrinho vazio, ou só itens que não
   *  entram na conta de duração). Não existe duração pra calcular. */
  | 'no_reservable_items'
  | 'max_pieces_exceeded'
  | 'pickup_before_minimum_advance'
  | 'pickup_before_operation_start'
  | 'pickup_is_sunday';

export interface RentalPlan {
  readonly pickupDate: CivilDate;
  readonly totalPieces: number;
  readonly countedPieces: number;
  readonly durationDays: number;
  readonly calculatedReturnDate: CivilDate;
  readonly hasSundayReturnException: boolean;
  readonly returnOptions: readonly SundayReturnOption[];
}

/**
 * FAIL CLOSED por construção de tipo, não por convenção: não existe
 * jeito de "esquecer de checar violations" e usar `plan` sem querer,
 * porque quando `ok` é `false` não existe `plan` nenhum no objeto — o
 * TypeScript recusa o acesso. A versão anterior devolvia sempre um
 * `RentalPlan` com um array `violations` que podia estar cheio; nada
 * impedia um código futuro de ler `plan.calculatedReturnDate` sem antes
 * checar `plan.violations.length === 0`. Esta forma torna esse erro
 * impossível de escrever, não só improvável.
 */
export type RentalPlanResult =
  | { readonly ok: true; readonly plan: RentalPlan }
  | { readonly ok: false; readonly violations: readonly PlanViolation[] };

/**
 * Compõe todas as regras de retirada. Valida TUDO antes de calcular
 * qualquer data — se houver qualquer violação, devolve `{ ok: false,
 * violations }` sem sequer tentar montar um plano.
 *
 * A checagem de `reservableOnline` acontece aqui, no servidor, não só
 * no frontend: mesmo que a tela nunca deixe abrir calendário pra
 * acessório, uma tentativa de HOLD que chegasse com um item não
 * reservável (bug, ou requisição forjada direto na API) é rejeitada
 * aqui — a reserva inteira, não só aquele item.
 *
 * NÃO decide sozinha o `effectiveReturnDate` quando a devolução
 * calculada cai domingo — ver `resolveEffectiveReturnDate`.
 */
export function calculateRentalPlan(
  input: RentalPlanInput,
  config: RentalRuleConfig = DEFAULT_RENTAL_RULE_CONFIG,
  todayDate: CivilDate = today(config),
): RentalPlanResult {
  const isPickupDaySunday = isSunday(input.pickupDate);
  const isOperationStarted = isOnlineReservationAllowed(input.pickupDate, config);
  const isMinimumAdvanceSatisfied = validateMinimumAdvance(input.pickupDate, todayDate, config);
  const hasNonReservableItem = input.items.some((item) => !item.reservableOnline);
  const { totalPieces, countedPieces } = countRentalPieces(input.items);

  const violations: PlanViolation[] = [];
  // Item não reservável barra a tentativa inteira — checado antes (e
  // independente) da contagem, porque mesmo um carrinho com peças
  // contáveis suficientes não pode "passar" se tiver um acessório junto.
  if (hasNonReservableItem) violations.push('contains_non_reservable_item');
  if (countedPieces === 0) violations.push('no_reservable_items');
  else if (!validateMaxPieces(countedPieces, config)) violations.push('max_pieces_exceeded');
  if (!isMinimumAdvanceSatisfied) violations.push('pickup_before_minimum_advance');
  if (!isOperationStarted) violations.push('pickup_before_operation_start');
  if (isPickupDaySunday) violations.push('pickup_is_sunday');

  if (violations.length > 0) {
    return { ok: false, violations };
  }

  // A partir daqui countedPieces já está garantido em [1, maxPieces], e
  // nenhum item é não-reservável — durationForPieces nunca lança aqui.
  const durationDays = durationForPieces(countedPieces, config);
  const calculatedReturnDate = calculateReturnDate(input.pickupDate, durationDays);
  const hasSundayReturnException = isSunday(calculatedReturnDate);
  const returnOptions: SundayReturnOption[] = hasSundayReturnException
    ? [
        { type: 'saturday', date: addDays(calculatedReturnDate, -1) },
        { type: 'mondayMorning', date: addDays(calculatedReturnDate, 1), window: '10:00–12:00' },
      ]
    : [];

  return {
    ok: true,
    plan: {
      pickupDate: input.pickupDate,
      totalPieces,
      countedPieces,
      durationDays,
      calculatedReturnDate,
      hasSundayReturnException,
      returnOptions,
    },
  };
}

/**
 * Resolve a devolução EFETIVA — a que de fato vale pra bloquear a peça.
 *
 * Sem exceção de domingo: sempre igual à calculada, não existe escolha.
 * Com exceção: exige que o chamador informe a escolha explicitamente.
 * Devolve `null` (em vez de lançar erro) quando ainda não há escolha —
 * "ainda não escolhido" é um estado de negócio normal e esperado
 * (o cliente ainda não decidiu sábado ou segunda), não uma falha de
 * programação. Quem decide o que fazer com esse `null` (bloquear
 * checkout, mostrar as opções de novo) é a camada de cima.
 */
export function resolveEffectiveReturnDate(
  plan: Pick<RentalPlan, 'calculatedReturnDate' | 'hasSundayReturnException' | 'returnOptions'>,
  choice?: 'saturday' | 'mondayMorning',
): CivilDate | null {
  if (!plan.hasSundayReturnException) return plan.calculatedReturnDate;
  if (!choice) return null;
  const option = plan.returnOptions.find((candidate) => candidate.type === choice);
  return option ? option.date : null;
}

export interface BlockedRange {
  /** Inclusivo — primeiro dia bloqueado. */
  readonly blockedFrom: CivilDate;
  /** EXCLUSIVO — primeiro dia já livre de novo. Intervalo meio-aberto
   *  [blockedFrom, blockedUntilExclusive), igual ao `daterange` do
   *  Postgres. Nomeado explicitamente "Exclusive" pra nunca confundir
   *  com "o último dia bloqueado" (que seria blockedUntilExclusive - 1
   *  dia). */
  readonly blockedUntilExclusive: CivilDate;
}

/**
 * blockedFrom = pickupDate - prepDays
 * blockedUntilExclusive = effectiveReturnDate + cleaningDays + 1
 *
 * O "+1" existe porque o intervalo é meio-aberto: se a higienização
 * bloqueia `cleaningDays` dias DEPOIS da devolução efetiva, o último dia
 * bloqueado é effectiveReturnDate + cleaningDays, e o primeiro dia livre
 * é o seguinte — daí o +1. Validado contra os exemplos dados: retirada
 * 15 → bloqueia 12,13,14 (15-3=12 ✓); devolução efetiva 20 → bloqueia
 * 21,22, livre 23 (20+2+1=23 ✓).
 *
 * Recebe `effectiveReturnDate` explícito — nunca deriva sozinha do
 * `calculatedReturnDate` quando há exceção de domingo, porque essa
 * conversão passa por uma escolha humana (ver `resolveEffectiveReturnDate`).
 * Isto é o que o item 4 pediu: `calculatedReturnDate` e
 * `effectiveReturnDate` são conceitos diferentes, e só o segundo entra
 * aqui.
 */
export function calculateBlockedRange(
  pickupDate: CivilDate,
  effectiveReturnDate: CivilDate,
  config: RentalRuleConfig = DEFAULT_RENTAL_RULE_CONFIG,
): BlockedRange {
  return {
    blockedFrom: addDays(pickupDate, -config.prepDays),
    blockedUntilExclusive: addDays(effectiveReturnDate, config.cleaningDays + 1),
  };
}

/**
 * Duas janelas se sobrepõem? Meio-aberto nos dois lados — mesma
 * semântica do `daterange` do Postgres. `[aFrom, aUntil)` intersecta
 * `[bFrom, bUntil)` sse `aFrom < bUntil` E `bFrom < aUntil`. Fica aqui
 * (não na camada de API) porque é a MESMA definição de sobreposição que
 * a EXCLUDE constraint do banco usa — reimplementar isso na API,
 * separado do motor, seria exatamente o tipo de duplicação que a Fase
 * 3.1 foi feita pra evitar.
 */
export function blockedRangesOverlap(a: BlockedRange, b: BlockedRange): boolean {
  return isBefore(a.blockedFrom, b.blockedUntilExclusive) && isBefore(b.blockedFrom, a.blockedUntilExclusive);
}
