/**
 * Configuração das regras de aluguel, centralizada — nenhum número mágico
 * (15, 3, 2, "06-01"...) deve aparecer solto em outro arquivo do motor.
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
  /** MM-DD, inclusive nas duas pontas. */
  readonly blackoutStart: string;
  readonly blackoutEnd: string;
  readonly maxPieces: number;
  readonly piecesToDaysTable: readonly PiecesToDaysRule[];
  readonly timezone: string;
}

export const DEFAULT_RENTAL_RULE_CONFIG: RentalRuleConfig = {
  minAdvanceDays: 15,
  prepDays: 3,
  cleaningDays: 2,
  // Confirmado: reserva online funciona até 31/mai, some 01/jun a 30/set,
  // volta 01/out.
  blackoutStart: '06-01',
  blackoutEnd: '09-30',
  maxPieces: 6,
  piecesToDaysTable: [
    { upTo: 2, days: 2 },
    { upTo: 4, days: 3 },
    { upTo: 6, days: 4 },
  ],
  timezone: 'America/Santiago',
};
