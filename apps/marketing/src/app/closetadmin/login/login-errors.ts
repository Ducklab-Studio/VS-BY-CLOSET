/**
 * Classifica a falha do POST /admin/auth/login. Arquivo puro (sem imports)
 * pra ser testado direto por scripts/closetadmin-login.test.mjs.
 *
 * Só o 401 do PRÓPRIO login ("Credenciais inválidas.", AdminAuthService)
 * é erro de nome/telefone/PIN. Um 401 com outra mensagem vem do
 * AdminAuthGuard — o ADMIN_API_TOKEN do site não confere com o da API —
 * e antes aparecia pra pessoa como "Credenciais inválidas", escondendo
 * um problema de configuração atrás de uma senha supostamente errada.
 * Nenhuma das mensagens revela se o usuário existe: a de configuração
 * aparece igual pra qualquer nome/telefone/PIN.
 */
export const CREDENTIALS_REJECTED_MESSAGE = 'Credenciais inválidas.';

export type LoginFailureKind = 'credentials' | 'rate_limited' | 'misconfigured' | 'unavailable' | 'internal';

/** Respostas de borda/gateway e queda de conexão: o servidor do painel não está respondendo
 *  (inclui o 404 "Application not found" que a hospedagem devolve com o serviço fora do ar). */
const UNREACHABLE_STATUSES = new Set([404, 408, 502, 503, 504]);

export function classifyLoginFailure(status: number, apiMessage: string): LoginFailureKind {
  if (status === 401) return apiMessage === CREDENTIALS_REJECTED_MESSAGE ? 'credentials' : 'misconfigured';
  // 400 = formato recusado pelo DTO (ex.: PIN fora de 4–8 dígitos): pra
  // quem está entrando, é o mesmo que credencial errada.
  if (status === 400) return 'credentials';
  if (status === 429) return 'rate_limited';
  if (status === 403 || (status === 503 && /não (está )?configurado/i.test(apiMessage))) return 'misconfigured';
  return UNREACHABLE_STATUSES.has(status) ? 'unavailable' : 'internal';
}

export const LOGIN_FAILURE_MESSAGES: Record<LoginFailureKind, string> = {
  credentials: 'Nome, telefone ou PIN incorretos.',
  rate_limited: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
  misconfigured: 'O painel está indisponível por um problema de configuração do servidor. Avise o responsável técnico.',
  unavailable: 'O servidor do painel não está respondendo agora. Tente novamente em instantes.',
  internal: 'Ocorreu um erro interno ao entrar. Tente novamente e, se continuar, avise o responsável técnico.',
};

/**
 * Resposta de sucesso do login: só vale com token e validade legíveis e no
 * futuro. Qualquer outra coisa (corpo vazio, HTML de um proxy, JSON sem os
 * campos) é falha — nunca um cookie criado com lixo, nunca uma exceção.
 */
export function isValidLoginResponse(value: unknown, now: number): value is { token: string; expiresAt: string } {
  if (!value || typeof value !== 'object') return false;
  const { token, expiresAt } = value as { token?: unknown; expiresAt?: unknown };
  if (typeof token !== 'string' || token.length < 16 || token.length > 512) return false;
  if (typeof expiresAt !== 'string') return false;
  const at = new Date(expiresAt).getTime();
  return Number.isFinite(at) && at > now;
}

/**
 * Por que a pessoa voltou ao login com um cookie de sessão. Só o 401 do
 * PRÓPRIO `/admin/auth/session` ("Sessão inválida ou expirada.") é sessão
 * expirada/revogada; qualquer outra falha (API fora, 5xx, 404 de borda, 401 do
 * token do site) é o painel que não pôde confirmar a sessão — o cookie
 * continua válido e volta a funcionar quando a API voltar.
 */
export const SESSION_REJECTED_MESSAGE = 'Sessão inválida ou expirada.';
export type SessionNoticeKind = 'expired' | 'unavailable';

export function classifySessionLoss(status: number, apiMessage: string): SessionNoticeKind {
  return status === 401 && apiMessage === SESSION_REJECTED_MESSAGE ? 'expired' : 'unavailable';
}

/** Parâmetro da URL do login: lista fechada, nunca texto livre da URL na tela. */
export const SESSION_NOTICE_PARAM: Record<SessionNoticeKind, string> = { expired: 'expirada', unavailable: 'indisponivel' };

export function parseSessionNotice(value: string | string[] | undefined): SessionNoticeKind | null {
  const text = Array.isArray(value) ? value[0] : value;
  return text === SESSION_NOTICE_PARAM.expired ? 'expired' : text === SESSION_NOTICE_PARAM.unavailable ? 'unavailable' : null;
}

export const SESSION_NOTICE_MESSAGES: Record<SessionNoticeKind, string> = {
  expired: 'Sua sessão expirou. Entre novamente para continuar.',
  unavailable: 'Não foi possível confirmar sua sessão: o servidor do painel não está respondendo. Tente novamente em instantes.',
};
