import { isIP } from 'node:net';

/**
 * IP de quem está do outro lado, sem confiar no que o cliente escreve.
 *
 * Na Railway (variável `RAILWAY_DEPLOYMENT_ID`, presente em todo deploy), a
 * borda remove o `X-Forwarded-For` do cliente e grava o `X-Real-IP` como
 * "fonte única" do IP que conectou — e pode haver mais de um salto interno,
 * então `req.ip` com `trust proxy` poderia devolver um proxy da própria
 * Railway. Fora da Railway (local, testes), nenhum cabeçalho de IP é confiável:
 * vale só o endereço da conexão TCP. `X-Forwarded-For` nunca é lido aqui.
 *
 * Fontes: docs.railway.com/networking/public-networking/specs-and-limits
 * ("X-Real-IP for identifying client's remote IP") e a resposta da equipe da
 * Railway em station.railway.com (edge remove X-Forwarded-For; X-Real-IP é a
 * fonte única).
 */
export interface ClientIpRequest {
  readonly headers?: Record<string, string | string[] | undefined>;
  readonly socket?: { readonly remoteAddress?: string | null };
}

export function normalizeClientIp(raw: string | string[] | null | undefined): string {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().replace(/^::ffff:/, '') ?? '';
  return value && value.length <= 45 && isIP(value) ? value : 'unknown';
}

export function trustedClientIp(req: ClientIpRequest, env: Record<string, string | undefined> = process.env): string {
  if (env.RAILWAY_DEPLOYMENT_ID) {
    const edge = normalizeClientIp(req.headers?.['x-real-ip']);
    if (edge !== 'unknown') return edge;
  }
  return normalizeClientIp(req.socket?.remoteAddress ?? undefined);
}
