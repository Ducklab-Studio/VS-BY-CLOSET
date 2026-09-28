import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Trava de segurança da suíte: os testes de integração escrevem e apagam
 * dados de verdade, então NUNCA podem rodar contra o banco de produção.
 *
 * Regras (qualquer falha aborta a suíte antes de abrir conexão):
 *  1. `DATABASE_URL` precisa estar definida EXPLICITAMENTE no ambiente do
 *     processo. Sem isso o Prisma carregaria `apps/reservations-api/.env`
 *     (produção) em silêncio na primeira instância do client.
 *  2. Nunca pode apontar pro mesmo host+banco do `.env` da API (referência
 *     de produção, lida só pra comparar — o valor nunca é impresso).
 *  3. Precisa ser: host local (localhost/127.0.0.1/::1), OU um host listado
 *     em `TEST_DATABASE_ALLOWED_HOSTS` (separado por vírgula), OU um banco
 *     chamado `TESTE`.
 *
 * As mensagens de erro nunca incluem a URL, usuário ou senha.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface SafeDatabaseInput {
  readonly databaseUrl: string | undefined;
  /** Hosts extras aprovados de forma explícita (ex.: branch de teste do Neon). */
  readonly allowedHosts?: string;
  /** URLs que representam produção; nunca podem ser usadas pelos testes. */
  readonly productionUrls?: readonly string[];
}

interface Target {
  readonly host: string;
  readonly database: string;
}

function parseTarget(raw: string): Target | null {
  try {
    const url = new URL(raw);
    if (!/^postgres(ql)?:$/.test(url.protocol)) return null;
    return { host: url.hostname.toLowerCase(), database: decodeURIComponent(url.pathname.replace(/^\//, '')) };
  } catch {
    return null;
  }
}

export function assertSafeTestDatabase(input: SafeDatabaseInput): void {
  const raw = input.databaseUrl?.trim();
  if (!raw) {
    throw new Error(
      'Testes abortados: DATABASE_URL não está definida no ambiente do processo. ' +
        'Defina-a explicitamente para um banco local/de teste (o .env de produção nunca é usado).',
    );
  }
  const target = parseTarget(raw);
  if (!target) throw new Error('Testes abortados: DATABASE_URL não é uma URL PostgreSQL válida.');

  for (const prodRaw of input.productionUrls ?? []) {
    const prod = parseTarget(prodRaw);
    if (prod && prod.host === target.host && prod.database === target.database) {
      throw new Error('Testes abortados: DATABASE_URL aponta para o mesmo host/banco do .env de produção.');
    }
  }

  const allowed = (input.allowedHosts ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const approved = LOCAL_HOSTS.has(target.host) || allowed.includes(target.host) || target.database.toUpperCase() === 'TESTE';
  if (!approved) {
    throw new Error(
      'Testes abortados: o host do DATABASE_URL não é local, não está em TEST_DATABASE_ALLOWED_HOSTS ' +
        'e o banco não se chama TESTE.',
    );
  }
}

/** URL de produção de referência = a do `.env` da API (só pra comparar). */
export function readProductionUrlFromEnvFile(envPath = resolve(__dirname, '..', '.env')): string[] {
  try {
    const line = readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .find((l) => /^\s*DATABASE_URL\s*=/.test(l));
    const value = line?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
    return value ? [value] : [];
  } catch {
    return [];
  }
}
