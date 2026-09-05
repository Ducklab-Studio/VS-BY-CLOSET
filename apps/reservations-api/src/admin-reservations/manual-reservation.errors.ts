/**
 * Sinais internos, mesmo padrão de holds.errors.ts — nunca vazam pro
 * cliente como estão, sempre viram uma HttpException apropriada em
 * AdminReservationsService.
 */

/** Uma ou mais violações do motor de regras não tinham override
 *  correspondente. Nunca lançado depois de qualquer INSERT — sempre
 *  antes, então não há nada pra desfazer (item 1: 100% transacional). */
export class ManualReservationRuleViolationError extends Error {
  constructor(readonly violations: readonly string[]) {
    super(`Violações sem override: ${violations.join(', ')}`);
    this.name = 'ManualReservationRuleViolationError';
  }
}

/** Peça física já ocupada no mesmo intervalo — item 6, nunca contornável
 *  por override. Calculado ANTES do INSERT (depois do FOR UPDATE); a
 *  EXCLUDE constraint é o backstop se esta checagem por algum motivo não
 *  pegar (mesmo desenho de InsufficientCapacityError em holds.errors.ts). */
export class ManualReservationUnitConflictError extends Error {
  constructor(readonly conflictingUnitIds: readonly string[]) {
    super(`Unidade(s) já ocupada(s) no período: ${conflictingUnitIds.join(', ')}`);
    this.name = 'ManualReservationUnitConflictError';
  }
}

/** RentalUnit inexistente OU inativo — os dois tratados juntos porque a
 *  resposta pro chamador é a mesma (item 6: nenhum dos dois é permitido,
 *  "salvo mecanismo futuro explicitamente projetado" pra inativo — que
 *  não existe ainda). */
export class ManualReservationInvalidUnitError extends Error {
  constructor(readonly invalidUnitIds: readonly string[]) {
    super(`RentalUnit inexistente ou inativo: ${invalidUnitIds.join(', ')}`);
    this.name = 'ManualReservationInvalidUnitError';
  }
}

/** Fase 9, item 13: bloqueio operacional ativo (loja fechada ou peça
 *  específica fora de operação) cobrindo o período pedido — nunca
 *  contornável por override, mesmo princípio de double booking. */
export class ManualReservationBlockedError extends Error {
  constructor(
    readonly reason: string,
    readonly rentalUnitId?: string,
  ) {
    super(`Bloqueio operacional ativo: ${reason}`);
    this.name = 'ManualReservationBlockedError';
  }
}
