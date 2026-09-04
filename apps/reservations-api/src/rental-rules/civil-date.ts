/**
 * Datas civis da operação (America/Santiago) — nunca instantes.
 *
 * Toda aritmética aqui passa por Date.UTC / getUTC*, nunca pelo construtor
 * local (`new Date(y,m,d)`) nem pelos getters locais (`.getDate()`,
 * `.getMonth()`...). Isso é proposital: o construtor e os getters locais
 * usam o fuso da MÁQUINA que está rodando o processo — numa serverless
 * function da Vercel isso pode ser qualquer região do mundo, e "15 de
 * outubro" não pode virar "14" ou "16" dependendo de onde o código está
 * rodando naquele momento. Usando só UTC como representação INTERNA de
 * calendário (não como fuso real), a aritmética fica determinística — o
 * mesmo resultado em qualquer máquina, sempre.
 *
 * A única função que de fato converte um instante real (agora) numa data
 * civil usando fuso de verdade é `civilDateInZone` — e ela usa
 * Intl.DateTimeFormat com o banco de fusos do próprio Node (ICU completo
 * desde o Node 13), que já sabe as regras de DST de cada país/época sem
 * precisar de código manual pra isso.
 */

export interface CivilDate {
  readonly year: number;
  /** 1–12, não 0-indexado — o índice 0 do JS Date pra mês é um dos erros
   *  mais comuns em código de datas; esta API não repete isso. */
  readonly month: number;
  readonly day: number;
}

export function civilDate(year: number, month: number, day: number): CivilDate {
  // Normaliza via Date.UTC: overflow de dia/mês (32, 13...) rola pro
  // próximo mês/ano corretamente — é o motor de calendário do próprio JS
  // fazendo o trabalho, não um `if` tentando reinventar isso.
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function civilDateFromISO(iso: string): CivilDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`Data inválida (esperado YYYY-MM-DD): ${iso}`);
  return civilDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

export function civilDateToISO(date: CivilDate): string {
  const y = String(date.year).padStart(4, '0');
  const m = String(date.month).padStart(2, '0');
  const d = String(date.day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toEpochMs(date: CivilDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

export function addDays(date: CivilDate, days: number): CivilDate {
  const d = new Date(toEpochMs(date) + days * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** `a - b`, em dias. Positivo se `a` é depois de `b`. */
export function diffDays(a: CivilDate, b: CivilDate): number {
  return Math.round((toEpochMs(a) - toEpochMs(b)) / 86_400_000);
}

export function compareCivilDates(a: CivilDate, b: CivilDate): -1 | 0 | 1 {
  const diff = diffDays(a, b);
  return diff === 0 ? 0 : diff > 0 ? 1 : -1;
}

export function isBefore(a: CivilDate, b: CivilDate): boolean {
  return compareCivilDates(a, b) < 0;
}

export function isSameOrAfter(a: CivilDate, b: CivilDate): boolean {
  return compareCivilDates(a, b) >= 0;
}

/** 0 = domingo ... 6 = sábado. Fato de calendário, não depende de fuso. */
export function dayOfWeek(date: CivilDate): number {
  return new Date(toEpochMs(date)).getUTCDay();
}

export function isSunday(date: CivilDate): boolean {
  return dayOfWeek(date) === 0;
}

/**
 * Converte um `date`/`daterange` do Postgres, já lido pelo driver como
 * `Date` do JS, de volta pra `CivilDate`.
 *
 * ⚠️ Isto é DIFERENTE de `civilDateInZone`: aqui não existe conversão de
 * fuso nenhuma pra fazer — confirmado empiricamente (não por suposição)
 * que o driver do Postgres devolve `date` como meia-noite UTC. Por
 * isso, e só por isso, os acessores `getUTC*` são os corretos aqui —
 * `getFullYear()`/`getDate()` (locais) dão o dia ERRADO dependendo do
 * fuso da máquina que roda o processo (visto na prática: uma instância
 * rodando em fuso negativo lia "14" onde o banco tinha "15"). Nunca
 * troque os `getUTC*` daqui por acessores locais.
 */
export function civilDateFromPgDate(value: Date): CivilDate {
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

/**
 * Converte um instante real (ex.: `new Date()`) na data civil que esse
 * instante representa dentro de um fuso IANA — é a única ponte entre
 * "agora, de verdade" e "que dia é hoje na operação". Usa Intl porque é
 * o próprio Node que carrega a tabela de fusos/DST; nada aqui é
 * calculado à mão, então não existe bug de deslocamento de dia por causa
 * de horário de verão pra eu escrever.
 */
export function civilDateInZone(instant: Date, timeZone: string): CivilDate {
  // en-CA formata como YYYY-MM-DD — é o locale embutido cujo formato
  // curto já sai na ordem certa sem eu precisar remontar a string.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const get = (type: string): string => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Intl.DateTimeFormat não devolveu a parte "${type}".`);
    return part.value;
  };

  return civilDate(Number(get('year')), Number(get('month')), Number(get('day')));
}
