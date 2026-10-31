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

/**
 * Endereço PÚBLICO roteável? Loopback, redes privadas, CGNAT (100.64/10, usado pela rede interna da Railway), link-local, multicast e "não especificado" nunca são o IP de
 * um visitante da internet: se aparecerem no `X-Real-IP` é um salto interno (ou lixo), e o valor não pode virar a chave de um limite por cliente.
 */
export function isPublicAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    return true;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return false;
    if (/^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower) || lower.startsWith('ff')) return false;
    return true;
  }
  return false;
}

/** Como o IP foi decidido (para o diagnóstico e para os testes): nunca devolve nada que o cliente não tenha mandado sobre si mesmo. */
export function describeClientIp(req: ClientIpRequest, env: Record<string, string | undefined> = process.env) {
  const onRailway = Boolean(env.RAILWAY_DEPLOYMENT_ID);
  const rawRealIp = req.headers?.['x-real-ip'];
  const realIp = normalizeClientIp(rawRealIp);
  const forwarded = req.headers?.['x-forwarded-for'];
  const forwardedText = Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '');
  const edgeUsable = onRailway && realIp !== 'unknown' && isPublicAddress(realIp);
  const socketIp = normalizeClientIp(req.socket?.remoteAddress ?? undefined);
  return {
    onRailway,
    derivedIp: edgeUsable ? realIp : socketIp,
    source: edgeUsable ? ('x-real-ip' as const) : socketIp === 'unknown' ? ('none' as const) : ('socket' as const),
    xRealIp: { present: rawRealIp !== undefined, validIp: realIp !== 'unknown', public: realIp !== 'unknown' && isPublicAddress(realIp), usedAsClient: edgeUsable },
    xForwardedFor: { present: forwardedText !== '', hops: forwardedText === '' ? 0 : forwardedText.split(',').length, usedAsClient: false },
    socketIsPublic: socketIp !== 'unknown' && isPublicAddress(socketIp),
  };
}

export function trustedClientIp(req: ClientIpRequest, env: Record<string, string | undefined> = process.env): string {
  return describeClientIp(req, env).derivedIp;
}
