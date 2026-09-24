/**
 * Configuração das regras de aluguel, centralizada — nenhum número mágico
 * (15, 3, 2...) deve aparecer solto em outro arquivo do motor.
 *
 * Bootstrap/test defaults only. Runtime services load and validate the
 * singleton in PostgreSQL; database failures never fall back to these values.
 */

export interface PiecesToDaysRule {
  readonly upTo: number;
  readonly days: number;
}

export interface RentalRuleConfig {
  readonly minAdvanceDays: number;
  readonly prepDays: number;
  readonly cleaningDays: number;
  /** YYYY-MM-DD: primeira data de retirada aceita. `null` = sem restrição.
   *  Períodos fechados não moram aqui: são `operational_blocks`. */
  readonly operationStartDate: string | null;
  readonly maxPieces: number;
  readonly piecesToDaysTable: readonly PiecesToDaysRule[];
  readonly timezone: string;
}

export const DEFAULT_RENTAL_RULE_CONFIG: RentalRuleConfig = {
  minAdvanceDays: 15,
  prepDays: 3,
  cleaningDays: 2,
  operationStartDate: null,
  maxPieces: 6,
  piecesToDaysTable: [
    { upTo: 2, days: 2 },
    { upTo: 4, days: 3 },
    { upTo: 6, days: 4 },
  ],
  timezone: 'America/Santiago',
};
