/**
 * Datas de validade dos vouchers do Valle Pass 2027 no ClosetAdmin.
 *
 * A validade é gravada como INSTANTES (`validFrom` = 00:00 do primeiro dia; `expiresAt` = 00:00 do dia seguinte ao último, no fuso
 * comercial). Para mostrar o dia certo a qualquer pessoa — navegador em UTC, em Santiago ou em São Paulo, ou renderização no servidor —,
 * o dia é sempre calculado NESTE fuso, nunca no do aparelho.
 *
 * `America/Sao_Paulo` é o fuso PROVISÓRIO da regra atual (o mesmo padrão da API, `VALE_PASS_VALIDITY_TIMEZONE`). A definição comercial
 * definitiva do fuso continua pendente de confirmação: este arquivo não a decide, só evita que a tela dependa do aparelho.
 */
export const VALLE_PASS_DISPLAY_TIMEZONE = 'America/Sao_Paulo';

function dayIn(instant: Date, timeZone: string): string {
  return instant.toLocaleDateString('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Primeiro dia de uso (a partir de `validFrom`). */
export function formatVoucherFirstDay(validFromIso: string, timeZone: string = VALLE_PASS_DISPLAY_TIMEZONE): string {
  return dayIn(new Date(validFromIso), timeZone);
}

/** Último dia de uso, inclusive: o dia do instante imediatamente anterior a `expiresAt` (que é 00:00 do dia seguinte). */
export function formatVoucherLastDay(expiresAtIso: string, timeZone: string = VALLE_PASS_DISPLAY_TIMEZONE): string {
  return dayIn(new Date(new Date(expiresAtIso).getTime() - 1), timeZone);
}

/** Qualquer data do cartão do voucher (ex.: "Comprado em") no mesmo fuso comercial, para não variar com o aparelho nem causar divergência de hidratação. */
export function formatVoucherDisplayDay(iso: string, timeZone: string = VALLE_PASS_DISPLAY_TIMEZONE): string {
  return dayIn(new Date(iso), timeZone);
}
