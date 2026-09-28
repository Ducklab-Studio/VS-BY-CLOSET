/**
 * Caminhos da API do ClosetAdmin são montados com ids vindos do navegador
 * (argumentos de server action, parâmetros de rota). Um id como `../employees`
 * — ou `%2e%2e`, que o `fetch` também normaliza para `..` — desviaria a
 * chamada para OUTRA rota da API, com o token do servidor e a sessão de quem
 * pediu. A API continua exigindo o papel da própria sessão, mas nenhum
 * caminho com segmento `.`/`..`, barra invertida ou fragmento sai daqui.
 */
export function isSafeAdminPath(path: string): boolean {
  if (!path.startsWith('/') || path.includes('\\') || path.includes('#')) return false;
  const pathname = path.split('?')[0];
  return pathname.split('/').every((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    return decoded !== '.' && decoded !== '..' && !decoded.includes('\\');
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Valor vindo do navegador dentro de UM segmento do caminho da API: sempre
 * codificado (`/`, `?`, `#`, `%` viram texto), nunca concatenado cru. Junto com
 * `isSafeAdminPath` (que recusa `.`/`..`), nenhum id consegue mudar a rota.
 */
export function pathSegment(value: string | number): string {
  return encodeURIComponent(String(value));
}
