/**
 * Fase 9 — utilitários de data mínimos para as telas do ClosetAdmin.
 * "Hoje" é calculado no fuso da operação (America/Santiago, mesmo fuso
 * usado por `rental-engine.ts` no reservations-api) — nunca o fuso do
 * servidor Next.js, que pode ser UTC em produção (Vercel).
 */
const TIMEZONE = 'America/Santiago';

export function civilDateToISOToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')!.value;
  const month = parts.find((p) => p.type === 'month')!.value;
  const day = parts.find((p) => p.type === 'day')!.value;
  return `${year}-${month}-${day}`;
}

/**
 * 'AAAA-MM-DD' → 'DD/MM/AAAA' por corte de string, nunca via `new Date()`:
 * uma data civil sem hora interpretada como UTC recua um dia em qualquer
 * fuso negativo (America/Santiago, America/Sao_Paulo). Devolve a entrada
 * intacta se não tiver o formato esperado.
 */
export function formatIsoDatePt(iso: string): string {
  const [year, month, day] = iso.split('-');
  if (!year || !month || !day) return iso;
  return `${day}/${month}/${year}`;
}

export function isoAddDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
