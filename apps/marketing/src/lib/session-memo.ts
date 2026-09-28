/**
 * Memória de validação de sessão para UMA requisição. `getAdminSession`
 * (admin-session.ts) cria um destes por requisição via `cache` do React — a
 * instância nunca sobrevive à requisição — e, dentro dela, a chave é o
 * PRÓPRIO token do cookie: mesmo que a instância fosse reaproveitada por
 * engano, um token nunca devolve a sessão validada para outro token.
 */
export function createSessionMemo<T>(validate: (token: string) => Promise<T>): (token: string) => Promise<T> {
  const byToken = new Map<string, Promise<T>>();
  return (token: string) => {
    let pending = byToken.get(token);
    if (!pending) {
      pending = validate(token);
      byToken.set(token, pending);
    }
    return pending;
  };
}
