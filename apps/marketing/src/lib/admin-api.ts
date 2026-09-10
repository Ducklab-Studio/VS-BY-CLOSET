import 'server-only';
import { cookies } from 'next/headers';
import { ADMIN_SESSION_COOKIE } from './admin-cookie';

/**
 * Fase 9 — ponte server-to-server com o reservations-api para o
 * ClosetAdmin. NUNCA importado por um Client Component (o pacote
 * `server-only` faz o build falhar se isso acontecer): o navegador só
 * fala com este mesmo domínio (apps/marketing), nunca direto com
 * reservations-api, e `ADMIN_API_TOKEN` nunca é lido fora daqui.
 *
 * `ADMIN_API_TOKEN` é o MESMO bearer da Fase 8 (`AdminAuthGuard` no
 * reservations-api) — continua existindo só pra necessidade
 * server-to-server, exatamente como o usuário definiu: "o navegador NÃO
 * deve receber ADMIN_API_TOKEN".
 */

export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

function baseUrl(): string {
  const url = process.env.RESERVATIONS_API_ADMIN_URL;
  if (!url) throw new AdminApiError(503, 'ClosetAdmin não está configurado (RESERVATIONS_API_ADMIN_URL ausente).');
  return url.replace(/\/$/, '');
}

function token(): string {
  const t = process.env.ADMIN_API_TOKEN;
  if (!t) throw new AdminApiError(503, 'ClosetAdmin não está configurado (ADMIN_API_TOKEN ausente).');
  return t;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const sessionToken = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...init.headers,
        Authorization: `Bearer ${token()}`,
        ...(sessionToken ? { 'X-Admin-Session': sessionToken } : {}),
      },
    });
  } catch {
    throw new AdminApiError(503, 'Não foi possível conectar ao servidor do ClosetAdmin.');
  }

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (json && typeof json === 'object' && 'message' in json ? String((json as { message?: unknown }).message) : null) ?? 'Erro inesperado.';
    throw new AdminApiError(res.status, message, json);
  }
  return json as T;
}

function withAdminUserId(path: string, adminUserId: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}adminUserId=${encodeURIComponent(adminUserId)}`;
}

export function adminGet<T>(path: string, adminUserId: string): Promise<T> {
  return request<T>(withAdminUserId(path, adminUserId), { method: 'GET' });
}

export function adminPost<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export function adminPatch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

/**
 * Fase 10 — PDF vem como bytes crus (`application/pdf`), não JSON. Não
 * reaproveita `request()` (que sempre faz `res.json()`) — mesmo padrão
 * de guards, nunca um "quase igual" genérico demais.
 */
export async function adminGetPdf(path: string, adminUserId: string): Promise<Buffer> {
  const sessionToken = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${withAdminUserId(path, adminUserId)}`, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
      headers: { Authorization: `Bearer ${token()}`, ...(sessionToken ? { 'X-Admin-Session': sessionToken } : {}) },
    });
  } catch {
    throw new AdminApiError(503, 'Não foi possível conectar ao servidor do ClosetAdmin.');
  }

  if (!res.ok) {
    const json = await res.json().catch(() => null);
    const message = (json && typeof json === 'object' && 'message' in json ? String((json as { message?: unknown }).message) : null) ?? 'Erro inesperado.';
    throw new AdminApiError(res.status, message, json);
  }

  return Buffer.from(await res.arrayBuffer());
}
