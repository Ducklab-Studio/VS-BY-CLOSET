import type { RentalRuleConfig } from './rental-rule-config';
import { TECHNICAL_MAX_PIECES } from './rental-limits';
import { civilDateFromISO, civilDateToISO } from './civil-date';

/** Validates persisted and prospective rules without choosing commercial values. */
export function validateRentalConfig(value: unknown): asserts value is RentalRuleConfig {
  if (!value || typeof value !== 'object') throw new Error('Configuração ausente.');
  const config = value as Record<string, unknown>;
  for (const [field, min, max] of [
    ['maxPieces', 1, TECHNICAL_MAX_PIECES], ['minAdvanceDays', 0, 365],
    ['prepDays', 0, 30], ['cleaningDays', 0, 30],
  ] as const) {
    const number = config[field];
    if (!Number.isInteger(number) || Number(number) < min || Number(number) > max) {
      throw new Error(`${field} inválido.`);
    }
  }
  const start = config.operationStartDate;
  if (start !== null && (typeof start !== 'string' || !isStrictIsoDate(start))) {
    throw new Error('operationStartDate inválido.');
  }
  if (typeof config.timezone !== 'string' || !config.timezone.trim()) throw new Error('Timezone inválido.');
  try { new Intl.DateTimeFormat('en', { timeZone: config.timezone }); }
  catch { throw new Error('Timezone inválido.'); }
  const table = config.piecesToDaysTable;
  if (!Array.isArray(table) || !table.length) throw new Error('A tabela de duração não pode ser vazia.');
  let previous = 0;
  for (const row of table) {
    if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.upTo) || !Number.isSafeInteger(row.days) || row.days < 1 || row.upTo <= previous) {
      throw new Error('A tabela exige inteiros positivos e upTo estritamente crescente.');
    }
    previous = row.upTo;
  }
  if (previous < Number(config.maxPieces)) throw new Error('A tabela de duração precisa cobrir maxPieces.');
}

/** YYYY-MM-DD que existe no calendário (recusa 2027-02-30 em vez de rolar pra março). */
export function isStrictIsoDate(value: string): boolean {
  try {
    return civilDateToISO(civilDateFromISO(value)) === value;
  } catch {
    return false;
  }
}
