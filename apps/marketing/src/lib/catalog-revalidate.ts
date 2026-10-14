/**
 * Autorização do aviso "o catálogo mudou" que o reservations-api manda à vitrine
 * depois de um webhook de produto da Shopify. Arquivo puro (sem imports) para
 * test/catalog-revalidate.test.mjs.
 *
 * Sem segredo configurado a rota fica DESLIGADA (nunca aberta): a vitrine continua
 * se atualizando sozinha pelo cache de 60 s, só sem o atalho de poucos segundos.
 */

/** Comparação em tempo constante (não vaza onde o segredo diverge). Vazio nunca autoriza. */
export function isAuthorizedRevalidate(provided: string | null | undefined, expected: string | null | undefined): boolean {
  const want = (expected ?? '').trim();
  const got = (provided ?? '').trim();
  if (want.length < 16 || got.length === 0) return false;
  const length = Math.max(want.length, got.length);
  let diff = want.length ^ got.length;
  for (let i = 0; i < length; i += 1) diff |= (want.charCodeAt(i) || 0) ^ (got.charCodeAt(i) || 0);
  return diff === 0;
}

/** Handle da Shopify: minúsculas, dígitos e hífen. Qualquer outra coisa é ignorada (nunca vira caminho). */
export function safeProductHandle(handle: unknown): string | null {
  if (typeof handle !== 'string') return null;
  const value = handle.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,254}$/.test(value) ? value : null;
}
