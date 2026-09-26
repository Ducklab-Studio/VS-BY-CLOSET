import { adminPost, AdminApiError } from '@/lib/admin-api';
import { isSameOriginRequest, parsePresenceRequest } from '@/lib/closetadmin-presence';

/**
 * Heartbeat e saída da presença online/offline (PresenceHeartbeat). O
 * navegador fala só com este domínio; daqui a chamada segue server-to-server
 * com o ADMIN_API_TOKEN e o token de sessão do cookie httpOnly (adminPost) —
 * a API identifica o funcionário SÓ pela sessão, nunca pelo corpo.
 *
 * O corpo é lido como texto porque `navigator.sendBeacon` (saída ao fechar a
 * aba) manda `text/plain`. Nenhum token, sessão ou id volta na resposta.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request.headers)) return new Response(null, { status: 403 });

  const parsed = parsePresenceRequest(await request.text());
  if (!parsed) return new Response(null, { status: 400 });

  try {
    await adminPost(`/admin/presence/${parsed.action}`, { clientId: parsed.clientId });
    return new Response(null, { status: 204 });
  } catch (err) {
    const status = err instanceof AdminApiError && (err.status === 401 || err.status === 429) ? err.status : 503;
    return new Response(null, { status });
  }
}
