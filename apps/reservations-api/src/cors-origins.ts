/**
 * Origens que podem chamar esta API a partir do navegador do cliente.
 *
 * Não usa `*`: essa API cria HOLD e mexe em reserva — um
 * `Access-Control-Allow-Origin: *` deixaria QUALQUER site do mundo
 * fazer essas chamadas usando a sessão do navegador de um cliente
 * (o header CORS não é autenticação, mas é a primeira camada; não faz
 * sentido abrir mão dela sem necessidade).
 *
 * Vem de variável de ambiente — nunca hardcoded — porque muda por
 * ambiente (localhost em dev, o domínio da Vercel em produção) e porque
 * trocar de domínio não pode exigir rebuild do código.
 */
export function allowedOrigins(): string[] {
  const raw = process.env.CORS_ALLOWED_ORIGINS ?? '';
  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    // Falha alto em produção — API sem CORS configurado bloquearia o
    // site de verdade silenciosamente, e o sintoma (erro de CORS no
    // navegador do cliente) é péssimo de diagnosticar à distância. Em
    // dev, sem a variável setada, cai pro localhost padrão do Next.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'CORS_ALLOWED_ORIGINS não configurada. Defina os domínios permitidos (separados por vírgula) antes de subir em produção.',
      );
    }
    return ['http://localhost:3000'];
  }

  return origins;
}

/**
 * Cada deploy de preview da Vercel ganha uma URL única e imprevisível
 * (`vsbycloset-<hash>-ducklab.vercel.app`, ou `vsbycloset-git-<branch>
 * -ducklab.vercel.app` por branch) — impossível listar uma por uma em
 * CORS_ALLOWED_ORIGINS sem reconfigurar a variável a cada PR. Sem isso,
 * TODO preview quebra com "não foi possível consultar a disponibilidade"
 * (a API responde 200 normalmente — só falta o header CORS, e é o
 * navegador de quem testa que bloqueia a leitura da resposta).
 *
 * Em vez de abrir pra `*.vercel.app` (qualquer site hospedado na
 * Vercel, de qualquer pessoa), o padrão exige o prefixo do projeto
 * ("vsbycloset-") e o time exato ("-ducklab.vercel.app") — só cobre
 * deploys deste projeto específico, nunca um domínio de terceiro.
 */
export const VERCEL_PREVIEW_ORIGIN = /^https:\/\/vsbycloset-[a-z0-9-]+-ducklab\.vercel\.app$/;

export function isOriginAllowed(origin: string, staticOrigins: string[]): boolean {
  return staticOrigins.includes(origin) || VERCEL_PREVIEW_ORIGIN.test(origin);
}
