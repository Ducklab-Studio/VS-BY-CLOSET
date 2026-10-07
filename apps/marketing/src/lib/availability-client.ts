/**
 * Cliente da disponibilidade (GET /availability do reservations-api).
 *
 * Arquivo puro (sem imports) para test/availability-client.test.mjs.
 *
 * Regras que ele garante para o calendário:
 *  - FAIL CLOSED: só devolve dias quando a resposta é válida e COMPLETA. Erro,
 *    timeout, JSON inválido, corpo vazio ou dias faltando viram uma falha — nunca
 *    uma data "livre" e nunca uma data "ocupada" inventada;
 *  - a disponibilidade em si continua sendo da API: aqui só se confere o formato;
 *  - toda consulta tem prazo e pode ser cancelada (trocar de mês/peça cancela a
 *    anterior); só falha transitória (rede, prazo, 502/503/504) tenta de novo, uma vez;
 *  - o que sai daqui é uma cópia só com os campos conhecidos.
 */

export type ReturnChoiceType = 'saturday' | 'mondayMorning';

export interface ReturnOption {
  type: ReturnChoiceType;
  date: string;
  window?: string;
  /** Disponibilidade da própria data desta opção (API). */
  available?: boolean;
}

export interface AvailabilityDay {
  date: string;
  bookable: boolean;
  quantityAvailable: number;
  reason: string | null;
  durationDays?: number;
  calculatedReturnDate?: string;
  hasSundayReturnException?: boolean;
  returnOptions?: ReturnOption[];
  /** Motivo real da indisponibilidade (API do ClosetAdmin), do mais prioritário ao menos. Só códigos. */
  unavailableReason?: string | null;
  unavailableReasons?: string[] | null;
}

export interface AvailabilityResponse {
  shopifyVariantId: string;
  countedPieces: number;
  unitsTotal: number;
  /** YYYY-MM-DD da primeira retirada online aceita (configurada no painel), ou null. */
  operationStartDate?: string | null;
  /** Máximo de peças por reserva (painel → Regras). Ausente em API antiga. */
  maxPieces?: number;
  days: AvailabilityDay[];
}

/** Por que a consulta não deu resposta utilizável. */
export type AvailabilityFailure =
  /** Sem conexão com o serviço (API fora, DNS, CORS, rede). */
  | 'network'
  /** Passou do prazo sem resposta. */
  | 'timeout'
  /** O serviço respondeu com erro HTTP. */
  | 'http'
  /** Respondeu 2xx, mas vazio, não-JSON ou fora do contrato. */
  | 'invalid'
  /** O endereço configurado não é uma URL válida. */
  | 'config'
  /** A consulta foi cancelada de propósito (troca de mês/peça). Não é erro para o cliente. */
  | 'aborted';

export type AvailabilityResult =
  | { readonly ok: true; readonly data: AvailabilityResponse }
  | { readonly ok: false; readonly failure: AvailabilityFailure; readonly status?: number };

export interface AvailabilityQuery {
  readonly variantId: string;
  readonly countedPieces: number;
  /** YYYY-MM-DD */
  readonly from: string;
  /** YYYY-MM-DD */
  readonly to: string;
}

export interface FetchAvailabilityOptions {
  /** Endereço do endpoint: caminho do site (`/api/availability`) ou URL pública completa. */
  readonly base: string;
  /** Origem da página (para resolver o caminho relativo). */
  readonly origin: string;
  /** Endereço do proxy do site, tentado uma vez se a URL pública falhar por rede/CORS. */
  readonly fallbackBase?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Novas tentativas só para falha transitória. */
  readonly retries?: number;
  readonly retryDelayMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export const AVAILABILITY_PROXY_PATH = '/api/availability';
export const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 500;
/** O proxy/API pedem no máximo 180 dias; mais que isso é resposta fora do contrato. */
const MAX_DAYS = 400;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` que existe no calendário (rejeita 2026-02-30). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const check = new Date(time);
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

/** Todas as datas de `from` até `to` (inclusive), em ordem. Vazio se o intervalo é inválido. */
export function datesBetween(from: string, to: string): string[] {
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) return [];
  const out: string[] = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  let time = Date.UTC(fy, fm - 1, fd);
  for (let i = 0; i < MAX_DAYS; i++) {
    const d = new Date(time);
    const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    out.push(iso);
    if (iso === to) return out;
    time += 86_400_000;
  }
  return [];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseReturnOptions(value: unknown): ReturnOption[] | null {
  if (!Array.isArray(value)) return null;
  const out: ReturnOption[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    if (raw.type !== 'saturday' && raw.type !== 'mondayMorning') return null;
    if (!isIsoDate(raw.date)) return null;
    if (raw.available !== undefined && typeof raw.available !== 'boolean') return null;
    if (raw.window !== undefined && raw.window !== null && typeof raw.window !== 'string') return null;
    out.push({
      type: raw.type,
      date: raw.date,
      ...(typeof raw.window === 'string' ? { window: raw.window } : {}),
      ...(typeof raw.available === 'boolean' ? { available: raw.available } : {}),
    });
  }
  return out;
}

function parseDay(raw: unknown): AvailabilityDay | null {
  if (!isRecord(raw)) return null;
  if (!isIsoDate(raw.date) || typeof raw.bookable !== 'boolean') return null;
  if (typeof raw.quantityAvailable !== 'number' || !Number.isFinite(raw.quantityAvailable) || raw.quantityAvailable < 0) return null;
  if (raw.reason !== null && raw.reason !== undefined && typeof raw.reason !== 'string') return null;

  const day: AvailabilityDay = {
    date: raw.date,
    bookable: raw.bookable,
    quantityAvailable: raw.quantityAvailable,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
  };

  if (raw.durationDays !== undefined) {
    if (typeof raw.durationDays !== 'number' || !Number.isInteger(raw.durationDays) || raw.durationDays < 1) return null;
    day.durationDays = raw.durationDays;
  }
  if (raw.calculatedReturnDate !== undefined) {
    if (!isIsoDate(raw.calculatedReturnDate)) return null;
    day.calculatedReturnDate = raw.calculatedReturnDate;
  }
  if (raw.hasSundayReturnException !== undefined) {
    if (typeof raw.hasSundayReturnException !== 'boolean') return null;
    day.hasSundayReturnException = raw.hasSundayReturnException;
  }
  if (raw.returnOptions !== undefined) {
    const options = parseReturnOptions(raw.returnOptions);
    if (!options) return null;
    day.returnOptions = options;
  }
  if (raw.unavailableReason !== undefined && raw.unavailableReason !== null) {
    if (typeof raw.unavailableReason !== 'string') return null;
    day.unavailableReason = raw.unavailableReason;
  }
  if (raw.unavailableReasons !== undefined && raw.unavailableReasons !== null) {
    if (!Array.isArray(raw.unavailableReasons) || raw.unavailableReasons.some((r) => typeof r !== 'string')) return null;
    day.unavailableReasons = raw.unavailableReasons as string[];
  }

  // Um dia só é "livre" com os dados que a reserva usa; sem eles a resposta não é confiável.
  if (day.bookable && (day.calculatedReturnDate === undefined || day.durationDays === undefined)) return null;
  if (day.bookable && day.hasSundayReturnException && (!day.returnOptions || day.returnOptions.length === 0)) return null;
  return day;
}

/**
 * Valida a resposta contra o que foi pedido. `null` = fora do contrato (o
 * chamador trata como falha, nunca como disponibilidade).
 */
export function parseAvailability(json: unknown, query: AvailabilityQuery): AvailabilityResponse | null {
  if (!isRecord(json)) return null;
  if (json.shopifyVariantId !== query.variantId) return null;
  if (json.countedPieces !== query.countedPieces) return null;
  if (!Array.isArray(json.days) || json.days.length > MAX_DAYS) return null;

  const wanted = datesBetween(query.from, query.to);
  if (wanted.length === 0) return null;
  const wantedSet = new Set(wanted);

  const byDate = new Map<string, AvailabilityDay>();
  for (const raw of json.days) {
    const day = parseDay(raw);
    if (!day) return null;
    if (!wantedSet.has(day.date)) continue; // dia fora do pedido: ignora
    if (byDate.has(day.date)) return null; // duplicado: resposta ambígua
    byDate.set(day.date, day);
  }
  // Dia que faltou não pode virar "ocupado" nem "livre": a resposta está incompleta.
  if (byDate.size !== wanted.length) return null;

  let unitsTotal = 0;
  if (json.unitsTotal !== undefined) {
    if (typeof json.unitsTotal !== 'number' || !Number.isFinite(json.unitsTotal) || json.unitsTotal < 0) return null;
    unitsTotal = json.unitsTotal;
  }
  let operationStartDate: string | null = null;
  if (json.operationStartDate !== undefined && json.operationStartDate !== null) {
    if (!isIsoDate(json.operationStartDate)) return null;
    operationStartDate = json.operationStartDate;
  }
  let maxPieces: number | undefined;
  if (json.maxPieces !== undefined) {
    if (typeof json.maxPieces !== 'number' || !Number.isInteger(json.maxPieces) || json.maxPieces < 1) return null;
    maxPieces = json.maxPieces;
  }

  return {
    shopifyVariantId: json.shopifyVariantId,
    countedPieces: json.countedPieces,
    unitsTotal,
    operationStartDate,
    ...(maxPieces !== undefined ? { maxPieces } : {}),
    days: wanted.map((date) => byDate.get(date) as AvailabilityDay),
  };
}

/**
 * Falhas que valem uma segunda tentativa (a API pode ter acabado de subir).
 * `retryNetwork` é falso na URL pública quando há o proxy do site como saída:
 * CORS/DNS não melhoram em meio segundo, e o proxy resolve na hora.
 */
function isTransient(result: AvailabilityResult, retryNetwork: boolean): boolean {
  if (result.ok) return false;
  if (result.failure === 'network') return retryNetwork;
  if (result.failure === 'timeout') return true;
  return result.failure === 'http' && (result.status === 502 || result.status === 503 || result.status === 504);
}

function buildUrl(base: string, origin: string, query: AvailabilityQuery): URL | null {
  try {
    const url = new URL(base.trim() || AVAILABILITY_PROXY_PATH, origin);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.searchParams.set('shopifyVariantId', query.variantId);
    url.searchParams.set('countedPieces', String(query.countedPieces));
    url.searchParams.set('from', query.from);
    url.searchParams.set('to', query.to);
    return url;
  } catch {
    return null;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Uma tentativa, com prazo (cobre também a leitura do corpo) e cancelamento. */
async function attemptOnce(url: URL, query: AvailabilityQuery, options: FetchAvailabilityOptions): Promise<AvailabilityResult> {
  const { signal, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl } = options;
  if (signal?.aborted) return { ok: false, failure: 'aborted' };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const doFetch = fetchImpl ?? fetch;
    const res = await doFetch(url.toString(), {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, failure: 'http', status: res.status };
    const text = await res.text();
    if (text.trim() === '') return { ok: false, failure: 'invalid', status: res.status };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, failure: 'invalid', status: res.status };
    }
    const data = parseAvailability(json, query);
    return data ? { ok: true, data } : { ok: false, failure: 'invalid', status: res.status };
  } catch {
    if (signal?.aborted) return { ok: false, failure: 'aborted' };
    return { ok: false, failure: timedOut ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function withRetries(
  base: string,
  query: AvailabilityQuery,
  options: FetchAvailabilityOptions,
  retryNetwork = true,
): Promise<AvailabilityResult> {
  const url = buildUrl(base, options.origin, query);
  if (!url) return { ok: false, failure: 'config' };
  const retries = Math.max(0, options.retries ?? 1);
  let result = await attemptOnce(url, query, options);
  for (let i = 0; i < retries && isTransient(result, retryNetwork); i++) {
    const waited = await sleep(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS, options.signal);
    if (!waited) return { ok: false, failure: 'aborted' };
    result = await attemptOnce(url, query, options);
  }
  return result;
}

/**
 * Consulta a disponibilidade real. Sem fallback inventado: se a URL pública
 * configurada falhar por rede/CORS, tenta UMA vez o proxy do próprio site; se
 * também falhar, é falha — nunca disponibilidade.
 */
export async function fetchAvailability(query: AvailabilityQuery, options: FetchAvailabilityOptions): Promise<AvailabilityResult> {
  const fallback = options.fallbackBase;
  const hasFallback = !!fallback && fallback !== options.base;
  const primary = await withRetries(options.base, query, options, !hasFallback);
  if (hasFallback && !primary.ok && primary.failure === 'network') {
    return withRetries(fallback, query, options);
  }
  return primary;
}

/**
 * Qual texto mostrar: o cliente só precisa saber se foi a conexão, a demora ou
 * uma resposta inesperada. 502/503/504 (o proxy do site não alcançou a API, ou
 * ela está parada) contam como "não conectou"; 504 é demora.
 */
export function availabilityFailureMessage(failure: AvailabilityFailure, status?: number): string {
  if (failure === 'http' && status === 504) failure = 'timeout';
  else if (failure === 'http' && (status === 502 || status === 503)) failure = 'network';
  switch (failure) {
    case 'timeout':
      return 'O serviço de reservas demorou demais para responder.';
    case 'network':
      return 'Não conseguimos nos conectar ao serviço de reservas.';
    case 'config':
    case 'http':
    case 'invalid':
    default:
      return 'O serviço de reservas respondeu de forma inesperada.';
  }
}
