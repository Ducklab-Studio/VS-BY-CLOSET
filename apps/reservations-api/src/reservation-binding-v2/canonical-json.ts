import { createHash } from 'node:crypto';

/**
 * JSON canônico e hash da REGRA DE PREÇO congelada (`reservations.pricing_snapshot`, Fase 3). Módulo PURO.
 *
 * Chaves ordenadas por unidade de código, sem espaços, só valores sem ambiguidade: texto, inteiro seguro, booleano,
 * `null`, listas e objetos simples. Rejeita (lança) número fracionário, `NaN`/`Infinity`, `undefined`, função, `bigint`,
 * símbolo, objeto não simples (Date, Map...), ciclo e profundidade excessiva — dois processos sempre geram os mesmos
 * bytes para o mesmo conteúdo lógico.
 */
const SNAPSHOT_DOMAIN = 'vsbc-snapshot/v2';
const MAX_DEPTH = 8;

export class CanonicalJsonError extends Error {}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new CanonicalJsonError('profundidade acima do máximo');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) throw new CanonicalJsonError('só inteiros seguros são permitidos');
      return String(value === 0 ? 0 : value); // nunca "-0"
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
      if (!isPlainObject(value)) throw new CanonicalJsonError('objeto não simples');
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`).join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(`tipo não permitido: ${typeof value}`);
  }
}

/** SHA-256 hex da regra de preço congelada, com etiqueta de domínio. */
export function hashPricingSnapshot(snapshot: unknown): string {
  return createHash('sha256').update(`${SNAPSHOT_DOMAIN}\n${canonicalJson(snapshot)}`, 'utf8').digest('hex');
}
