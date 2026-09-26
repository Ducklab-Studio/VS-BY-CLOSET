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

export type LoginFailureKind = 'credentials' | 'rate_limited' | 'misconfigured' | 'unavailable';

export function classifyLoginFailure(status: number, apiMessage: string): LoginFailureKind {
  if (status === 401) return apiMessage === CREDENTIALS_REJECTED_MESSAGE ? 'credentials' : 'misconfigured';
  // 400 = formato recusado pelo DTO (ex.: PIN fora de 4–8 dígitos): pra
  // quem está entrando, é o mesmo que credencial errada.
  if (status === 400) return 'credentials';
  if (status === 429) return 'rate_limited';
  if (status === 403 || (status === 503 && /não (está )?configurado/i.test(apiMessage))) return 'misconfigured';
  return 'unavailable';
}

export const LOGIN_FAILURE_MESSAGES: Record<LoginFailureKind, string> = {
  credentials: 'Nome, telefone ou PIN incorretos.',
  rate_limited: 'Muitas tentativas. Aguarde um minuto e tente novamente.',
  misconfigured: 'O painel está indisponível por um problema de configuração do servidor. Avise o responsável técnico.',
  unavailable: 'Não foi possível entrar agora. Tente novamente em instantes.',
};
