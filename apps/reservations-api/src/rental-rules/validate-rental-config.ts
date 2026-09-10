import type { RentalRuleConfig } from './rental-rule-config';
import { TECHNICAL_MAX_PIECES } from './rental-limits';

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
  for (const field of ['blackoutStart', 'blackoutEnd']) {
    const date = config[field];
    if (typeof date !== 'string' || !/^\d{2}-\d{2}$/.test(date)) throw new Error(`${field} inválido.`);
    const [month, day] = date.split('-').map(Number);
    const parsed = new Date(Date.UTC(2000, month - 1, day));
    if (parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) throw new Error(`${field} inválido.`);
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
