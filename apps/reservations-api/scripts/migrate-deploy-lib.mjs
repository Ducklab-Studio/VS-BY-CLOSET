/**
 * Validação (fail closed) da URL usada para aplicar as migrations em produção.
 *
 * As migrations NÃO podem passar pelo pooler do Neon (pgbouncer em modo de transação): o `prisma migrate deploy` toma um advisory lock de SESSÃO
 * (`pg_advisory_lock(72707369)`) e, pelo pooler, o desbloqueio pode cair em outra conexão de servidor, deixando o lock preso numa conexão que fica viva por
 * minutos. O deploy seguinte então falha com P1002 ("timed out trying to acquire a postgres advisory lock"). Numa conexão direta o lock é tomado e liberado
 * na MESMA sessão.
 *
 * Esta função nunca devolve nem registra a URL em mensagens de erro (ela contém credencial).
 */

/** @returns {{ ok: true, url: string } | { ok: false, reason: string }} */
export function validateMigrateUrl(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: false, reason: 'MIGRATE_DATABASE_URL ausente: defina a URL da conexão DIRETA do Neon (host sem "-pooler").' };
  }
  let parsed;
  try {
    parsed = new URL(String(raw).trim());
  } catch {
    return { ok: false, reason: 'MIGRATE_DATABASE_URL inválida (não é uma URL).' };
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    return { ok: false, reason: 'MIGRATE_DATABASE_URL inválida (o protocolo deve ser postgresql ou postgres).' };
  }
  if (!parsed.hostname) return { ok: false, reason: 'MIGRATE_DATABASE_URL inválida (sem host).' };
  if (/-pooler(\.|$)/i.test(parsed.hostname)) {
    return { ok: false, reason: 'MIGRATE_DATABASE_URL aponta para o POOLER do Neon (host com "-pooler"): use o host direto (sem "-pooler"). Pelo pooler o advisory lock das migrations vaza.' };
  }
  if (/^(true|1)$/i.test(parsed.searchParams.get('pgbouncer') ?? '')) {
    return { ok: false, reason: 'MIGRATE_DATABASE_URL tem pgbouncer=true: migrations exigem conexão direta.' };
  }
  if (parsed.port === '6543') {
    return { ok: false, reason: 'MIGRATE_DATABASE_URL usa a porta 6543 (típica de pooler): migrations exigem conexão direta.' };
  }
  return { ok: true, url: parsed.toString() };
}
