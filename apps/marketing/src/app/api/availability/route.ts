import { NextRequest, NextResponse } from 'next/server';

/**
 * Proxy same-origin para a disponibilidade pública do reservations-api.
 *
 * Motivo: o RentalCalendar roda no navegador. Em desenvolvimento/local e
 * em deploys onde NEXT_PUBLIC_AVAILABILITY_URL não foi injetada no build,
 * ele ainda precisa conseguir consultar a API sem expor ADMIN_API_TOKEN e
 * sem depender de CORS entre domínios.
 *
 * O endpoint /availability do reservations-api é público; por isso este
 * proxy NÃO envia credencial administrativa.
 *
 * Contrato com o calendário (FAIL CLOSED): 2xx só sai daqui com JSON de verdade
 * vindo da API; qualquer outra coisa (API fora do ar, página de erro da
 * hospedagem, demora, corpo vazio) vira um erro JSON com status de erro — nunca
 * um corpo que o calendário pudesse ler como "disponível" ou "ocupado".
 */

/** Prazo para a API responder; o calendário tem o dele (10 s), este vem antes. */
const UPSTREAM_TIMEOUT_MS = 8_000;
/** Só estes parâmetros seguem para a API: o resto da query nunca é repassado. */
const FORWARDED_PARAMS = ['shopifyVariantId', 'countedPieces', 'from', 'to'] as const;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function failure(status: number, message: string) {
  return NextResponse.json({ message }, { status, headers: NO_STORE });
}

export async function GET(request: NextRequest) {
  const base = reservationsApiBase();

  if (!base) {
    return failure(503, 'API de disponibilidade não configurada.');
  }

  let target: URL;
  try {
    target = new URL('/availability', `${base}/`);
  } catch {
    return failure(503, 'API de disponibilidade não configurada.');
  }
  for (const key of FORWARDED_PARAMS) {
    for (const value of request.nextUrl.searchParams.getAll(key)) target.searchParams.append(key, value);
  }

  let upstream: Response;
  let body: string;
  try {
    upstream = await fetch(target, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    body = await upstream.text();
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return timedOut
      ? failure(504, 'O serviço de disponibilidade demorou demais para responder.')
      : failure(502, 'Não foi possível conectar ao serviço de disponibilidade.');
  }

  const json = parseJson(body);

  if (!upstream.ok) {
    // 404 da própria API (NestJS: peça sem unidade cadastrada) tem `statusCode`.
    // 404 de uma hospedagem sem aplicação ("Application not found") não tem: o
    // serviço está fora do ar, e é assim que o calendário deve tratá-lo.
    const fromApi = json !== null && typeof json === 'object' && 'statusCode' in json;
    if (upstream.status === 404 && !fromApi) {
      return failure(502, 'O serviço de disponibilidade está fora do ar.');
    }
    if (!fromApi) {
      return failure(upstream.status >= 500 ? 502 : upstream.status, 'O serviço de disponibilidade respondeu com erro.');
    }
    return new NextResponse(body, { status: upstream.status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE } });
  }

  if (json === null) {
    // 2xx sem JSON (vazio, HTML de erro de proxy): não repassa como se fosse dado.
    return failure(502, 'O serviço de disponibilidade respondeu de forma inválida.');
  }

  return new NextResponse(body, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE },
  });
}

function parseJson(text: string): unknown | null {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function reservationsApiBase(): string | null {
  const raw =
    process.env.RESERVATIONS_API_URL ??
    process.env.RESERVATIONS_API_ADMIN_URL ??
    process.env.NEXT_PUBLIC_RESERVATIONS_API_URL;

  const value = raw?.trim();
  return value ? value.replace(/\/+$/, '') : null;
}
