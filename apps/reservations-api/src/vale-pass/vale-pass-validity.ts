/**
 * Janela de uso dos vouchers do Valle Pass ("durante 2027"). Puro (sem banco).
 *
 * DECISÃO PENDENTE: em que FUSO "01/01/2027 a 31/12/2027" vale (Brasil ou Chile)? Enquanto o Anderson não confirmar, o padrão é
 * `America/Sao_Paulo` e pode ser trocado por `VALE_PASS_VALIDITY_TIMEZONE` sem mexer em código. O fuso muda só horas na virada do ano; a conta
 * é feita em UM lugar (aqui) para que a troca seja uma linha de configuração.
 */

export const DEFAULT_VALIDITY_TIMEZONE = 'America/Sao_Paulo';

export function resolveValidityTimezone(env: NodeJS.ProcessEnv = process.env): string {
  const zone = env.VALE_PASS_VALIDITY_TIMEZONE?.trim() || DEFAULT_VALIDITY_TIMEZONE;
  // Lança RangeError para fuso inexistente: melhor falhar claro do que emitir voucher com validade errada.
  new Intl.DateTimeFormat('en-US', { timeZone: zone });
  return zone;
}

/** Deslocamento (ms) do fuso em relação ao UTC no instante dado: hora local − UTC. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Instante UTC em que começa o dia `YYYY-MM-DD` no fuso dado (00:00 local). */
export function zonedMidnightUtc(isoDay: string, timeZone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  if (!match) throw new RangeError(`data inválida: ${isoDay}`);
  const guess = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0);
  let instant = guess - zoneOffsetMs(guess, timeZone);
  // Segunda passada: o deslocamento pode mudar entre o palpite e o instante real (horário de verão).
  instant = guess - zoneOffsetMs(instant, timeZone);
  return new Date(instant);
}

function addDays(isoDay: string, days: number): string {
  const date = new Date(`${isoDay}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export interface VoucherWindow {
  /** Primeiro instante em que o voucher pode ser usado. */
  readonly validFrom: Date;
  /** Primeiro instante em que NÃO vale mais (o dia seguinte ao último dia de validade, 00:00 no fuso). */
  readonly expiresAt: Date;
}

/** `from`/`until` = primeiro e último dia de uso (inclusive), como configurados na campanha. */
export function voucherWindow(from: string, until: string, timeZone: string = resolveValidityTimezone()): VoucherWindow {
  if (until < from) throw new RangeError('o último dia de validade é anterior ao primeiro');
  return { validFrom: zonedMidnightUtc(from, timeZone), expiresAt: zonedMidnightUtc(addDays(until, 1), timeZone) };
}
