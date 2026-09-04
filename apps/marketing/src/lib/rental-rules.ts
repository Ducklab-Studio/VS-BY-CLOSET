/**
 * Utilitários de data GENÉRICOS — sem regra de negócio nenhuma.
 *
 * Até a Fase 4.1, este arquivo também tinha a tabela peças→dias, o
 * cálculo de temporada bloqueada e o estado do dia no calendário — uma
 * cópia local do que o motor server-side (apps/reservations-api/src/
 * rental-rules) já decide com autoridade. Removidas de propósito: o
 * calendário e o carrinho agora leem `durationDays`/`bookable`/
 * `calculatedReturnDate` prontos de GET /availability e GET
 * /rental-plan/duration — nunca recalculam. Duplicar essa lógica aqui
 * de novo reintroduziria exatamente o risco que motivou removê-la
 * (frontend calculando uma duração, backend calculando outra).
 *
 * O que sobra aqui é só aritmética de calendário pra desenhar a grade
 * (mês, dia da semana, ISO) — sem opinião nenhuma sobre o que é uma
 * data válida pra alugar.
 */

/* Datas em horário local, sempre. "10 de setembro" tem que ser 10 de
   setembro no Brasil e no Chile — converter pra UTC no meio do caminho
   gera reserva com um dia de diferença dependendo do fuso do cliente. */

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  const c = startOfDay(d);
  c.setDate(c.getDate() + n);
  return c;
}

export function toISO(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function fromISO(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function sameDay(a: Date, b: Date): boolean {
  return toISO(a) === toISO(b);
}
