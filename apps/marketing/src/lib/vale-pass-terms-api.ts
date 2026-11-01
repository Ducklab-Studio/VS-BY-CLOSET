/**
 * Cliente de integração do frontend com o aceite eletrônico de termos do Valle Pass 2027.
 * Especificação: docs/VALLE-PASS-2027-ACEITE-INTEGRACAO-GEMINI.md
 * Backend: apps/reservations-api/src/vale-pass/flow/terms-acceptance.controller.ts
 */

export interface PublicTermsData {
  readonly version: string;
  readonly sha256: string;
  readonly acceptanceRequired: boolean;
  readonly tokenTtlMinutes: number;
}

export interface TermsAcceptanceRequest {
  readonly termsVersion: string;
  readonly termsSha256: string;
  readonly accepted: boolean;
  readonly variantId: string;
}

export interface TermsAcceptanceGrant {
  readonly token: string;
  readonly termsVersion: string;
  readonly termsSha256: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export type TermsFetchResult =
  | { ok: true; status: 200; terms: PublicTermsData }
  | { ok: false; status: 404; code: 'TERMS_NOT_APPROVED'; message: string }
  | { ok: false; status: number; code?: string; message: string };

export type TermsAcceptanceResult =
  | { ok: true; status: 201; grant: TermsAcceptanceGrant }
  | { ok: false; status: 400; code?: string; message: string }
  | { ok: false; status: 404; code: 'TERMS_NOT_APPROVED'; message: string }
  | { ok: false; status: 409; code: 'TERMS_VERSION_MISMATCH'; message: string }
  | { ok: false; status: 429; code?: string; message: string }
  | { ok: false; status: number; code?: string; message: string };

/**
 * Determina a URL base pública da API.
 * Se nenhuma URL remota estiver configurada, usa o caminho local proxy do Next.js.
 */
export function getTermsApiBase(): string {
  const custom =
    process.env.NEXT_PUBLIC_VALE_PASS_API_URL?.trim() ||
    process.env.NEXT_PUBLIC_RESERVATIONS_API_URL?.trim();
  return custom ? custom.replace(/\/+$/, '') : '';
}

/**
 * Mensagens amigáveis de acordo com a tabela do guia de integração.
 */
export function formatTermsErrorMessage(status: number, code?: string): string {
  if (status === 429) {
    return 'Muitas tentativas. Aguarde um minuto.';
  }
  if (status === 409 || code === 'TERMS_VERSION_MISMATCH') {
    return 'Os termos foram atualizados. Por favor, leia e confirme a versão vigente antes de continuar.';
  }
  if (status === 404 || code === 'TERMS_NOT_APPROVED') {
    return 'Os termos ainda não estão disponíveis para aceite.';
  }
  if (code === 'ACCEPTANCE_NOT_AFFIRMATIVE') {
    return 'É obrigatório marcar a caixa de confirmação dos termos.';
  }
  if (code === 'UNKNOWN_VARIANT') {
    return 'Variante do Valle Pass não reconhecida.';
  }
  if (status >= 500) {
    return 'Serviço temporariamente indisponível. Tente novamente em instantes.';
  }
  return 'Não foi possível validar o aceite dos termos. Tente novamente.';
}

/**
 * Consulta os termos públicos vigentes: GET /public/vale-pass/terms
 * Retorna os termos vigentes se 200, ou o código de status com erro.
 */
export async function fetchPublicTerms(
  base = getTermsApiBase(),
  fetchFn: typeof fetch = typeof fetch !== 'undefined' ? fetch : globalThis.fetch,
): Promise<TermsFetchResult> {
  const url = base ? `${base}/public/vale-pass/terms` : '/api/valle-pass/terms';
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });

    const data = await res.json().catch(() => null);

    if (res.status === 200 && data?.version && data?.sha256) {
      return {
        ok: true,
        status: 200,
        terms: {
          version: String(data.version),
          sha256: String(data.sha256),
          acceptanceRequired: Boolean(data.acceptanceRequired),
          tokenTtlMinutes: Number(data.tokenTtlMinutes) || 360,
        },
      };
    }

    if (res.status === 404) {
      return {
        ok: false,
        status: 404,
        code: 'TERMS_NOT_APPROVED',
        message: data?.message || formatTermsErrorMessage(404, 'TERMS_NOT_APPROVED'),
      };
    }

    return {
      ok: false,
      status: res.status,
      code: data?.code,
      message: formatTermsErrorMessage(res.status, data?.code),
    };
  } catch {
    return {
      ok: false,
      status: 0,
      message: 'Falha de conexão com o servidor. Verifique sua rede e tente novamente.',
    };
  }
}

/**
 * Envia o aceite afirmativo para obter o token assinado HMAC.
 * POST /public/vale-pass/terms-acceptances
 * Corpo JSON estrito: { termsVersion, termsSha256, accepted: true, variantId } (sem campos extras).
 */
export async function postTermsAcceptance(
  payload: TermsAcceptanceRequest,
  base = getTermsApiBase(),
  fetchFn: typeof fetch = typeof fetch !== 'undefined' ? fetch : globalThis.fetch,
): Promise<TermsAcceptanceResult> {
  const url = base ? `${base}/public/vale-pass/terms-acceptances` : '/api/valle-pass/terms-acceptances';

  // O backend estritamente recusa qualquer campo extra (whitelist validation).
  const body = JSON.stringify({
    termsVersion: payload.termsVersion,
    termsSha256: payload.termsSha256,
    accepted: payload.accepted,
    variantId: payload.variantId,
  });

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      cache: 'no-store',
      body,
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json().catch(() => null);

    if (res.status === 201 && data?.token) {
      return {
        ok: true,
        status: 201,
        grant: {
          token: String(data.token),
          termsVersion: String(data.termsVersion),
          termsSha256: String(data.termsSha256),
          issuedAt: String(data.issuedAt),
          expiresAt: String(data.expiresAt),
        },
      };
    }

    const code = data?.code;
    return {
      ok: false,
      status: res.status,
      code,
      message: formatTermsErrorMessage(res.status, code),
    };
  } catch {
    return {
      ok: false,
      status: 0,
      message: 'Falha de conexão com o servidor ao registrar aceite. Tente novamente.',
    };
  }
}
