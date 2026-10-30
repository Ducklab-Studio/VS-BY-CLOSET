import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { validateMigrateUrl } from './migrate-deploy-lib.mjs';

/**
 * `migrate-deploy`: migrations pela conexão DIRETA do Neon. A parte pura e o comportamento do CLI sem banco rodam sempre; a parte ponta a ponta usa um banco
 * DESCARTÁVEL criado só para este arquivo no PostgreSQL LOCAL de teste (sem `DATABASE_URL` local de teste ela é pulada). Nunca toca no Neon nem em banco compartilhado.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '..');
const cli = path.join(here, 'migrate-deploy.mjs');

const base = process.env.DATABASE_URL ?? '';
const local = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(base);
const localDescribe = local ? describe : describe.skip;

/** Ambiente do CLI: o do processo SEM DATABASE_URL/MIGRATE_DATABASE_URL/PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK herdadas, mais o que o teste informar. */
const cleanEnv = (env) => {
  const clean = { ...process.env, CHECKPOINT_DISABLE: '1' };
  for (const key of ['DATABASE_URL', 'MIGRATE_DATABASE_URL', 'PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK']) delete clean[key];
  return Object.assign(clean, env);
};

const run = (env) => {
  const clean = cleanEnv(env);
  const r = spawnSync(process.execPath, [cli], { cwd: apiDir, encoding: 'utf8', env: clean, timeout: 60_000 });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
};

describe('migrate-deploy — validação fail closed da URL', () => {
  test('URL direta válida é aceita (credenciais preservadas, sem aparecer em mensagens)', () => {
    const result = validateMigrateUrl('postgresql://papel:senha@ep-exemplo-abc123.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require');
    expect(result.ok).toBe(true);
    expect(result.url).toContain('ep-exemplo-abc123.us-east-2.aws.neon.tech');
    expect(validateMigrateUrl('postgres://u:p@localhost:5432/db').ok).toBe(true);
  });

  test.each([
    ['ausente', undefined],
    ['vazia', ''],
    ['só espaços', '   '],
    ['não é URL', 'isto nao e uma url'],
    ['protocolo errado', 'mysql://u:p@host/db'],
    ['host do pooler do Neon', 'postgresql://papel:senha@ep-exemplo-abc123-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require'],
    ['host do pooler (maiúsculas)', 'postgresql://papel:senha@EP-EXEMPLO-POOLER.us-east-2.aws.neon.tech/neondb'],
    ['pgbouncer=true', 'postgresql://papel:senha@host-direto.exemplo.com/neondb?pgbouncer=true'],
    ['porta 6543', 'postgresql://papel:senha@host-direto.exemplo.com:6543/neondb'],
  ])('rejeita: %s', (_name, raw) => {
    const result = validateMigrateUrl(raw);
    expect(result.ok).toBe(false);
    // a mensagem nunca carrega a credencial nem a URL
    expect(result.reason).not.toMatch(/senha|papel:|postgres(ql)?:\/\//i);
  });

  test('"-pooler" no meio de outro rótulo não é confundido (só o sufixo do rótulo do host conta)', () => {
    expect(validateMigrateUrl('postgresql://u:p@pooler-ep-1.exemplo.com/db').ok).toBe(true);
  });
});

describe('migrate-deploy — CLI aborta antes de abrir qualquer conexão', () => {
  test('MIGRATE_DATABASE_URL ausente: código 2, mensagem clara e o Prisma não chega a rodar', () => {
    const r = run({});
    expect(r.code).toBe(2);
    expect(r.out).toContain('ABORTADO');
    expect(r.out).toContain('MIGRATE_DATABASE_URL ausente');
    expect(r.out).not.toContain('Prisma schema loaded');
  });

  test('URL de pooler é REJEITADA (código 2) mesmo com DATABASE_URL de runtime presente; nada é executado', () => {
    const t0 = Date.now();
    const r = run({ MIGRATE_DATABASE_URL: 'postgresql://papel:senha@ep-exemplo-pooler.us-east-2.aws.neon.tech/neondb', DATABASE_URL: 'postgresql://papel:senha@ep-exemplo-pooler.us-east-2.aws.neon.tech/neondb' });
    expect(r.code).toBe(2);
    expect(r.out).toContain('POOLER');
    expect(r.out).not.toContain('Prisma schema loaded');
    expect(r.out).not.toMatch(/senha/);
    expect(Date.now() - t0).toBeLessThan(15_000); // falhou na validação, não numa tentativa de conexão
  });

  test('DATABASE_URL de runtime NÃO substitui a MIGRATE_DATABASE_URL ausente (nunca há fallback para o pooler)', () => {
    const r = run({ DATABASE_URL: 'postgresql://papel:senha@host-qualquer.exemplo.com/db' });
    expect(r.code).toBe(2);
    expect(r.out).toContain('MIGRATE_DATABASE_URL ausente');
  });
});

const require = createRequire(import.meta.url);
const { PrismaClient } = local ? require('@prisma/client') : { PrismaClient: null };
const dbName = `migrate_deploy_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const withDb = (name) => { const u = new URL(base); u.pathname = `/${name}`; return u.toString(); };
const url = local ? withDb(dbName) : '';
const migrationCount = readdirSync(path.join(apiDir, 'prisma', 'migrations')).filter((name) => /^\d/.test(name)).length;
const LOCK = 72707369;
let admin;
let db;

/** Executa o CLI de forma assíncrona (o teste precisa continuar segurando um lock enquanto ele roda). */
const runAsync = (env) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [cli], { cwd: apiDir, env: cleanEnv(env) });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });

localDescribe('migrate-deploy — ponta a ponta em banco descartável', () => {
  beforeAll(async () => {
    admin = new PrismaClient({ datasourceUrl: withDb('postgres'), log: [] });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
    db = new PrismaClient({ datasourceUrl: url, log: [] });
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.$disconnect();
    }
  }, 60_000);

  test('sucesso: aplica todas as migrations pela URL direta e o advisory lock fica LIVRE depois', async () => {
    const r = await runAsync({ MIGRATE_DATABASE_URL: url, DATABASE_URL: 'postgresql://x:y@host-de-runtime-pooler.invalido/db' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('conexão direta');
    const applied = await db.$queryRaw`SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    expect(applied[0].n).toBe(migrationCount);
    const locks = await db.$queryRaw`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = ${LOCK}`;
    expect(locks[0].n).toBe(0);
  }, 180_000);

  test('idempotente: repetir sem migrations pendentes passa e continua sem lock preso', async () => {
    const r = await runAsync({ MIGRATE_DATABASE_URL: url });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/No pending migrations|already in sync/i);
    const locks = await db.$queryRaw`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = ${LOCK}`;
    expect(locks[0].n).toBe(0);
  }, 120_000);

  test('o advisory lock do Prisma continua HABILITADO: com o lock tomado por outra sessão a migração espera e falha (P1002), inclusive se alguém tentar desativá-lo', async () => {
    let result;
    await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(${LOCK})) AS t`; // mesma chave do Prisma Migrate, mantida por esta transação
        result = await runAsync({ MIGRATE_DATABASE_URL: url, PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: '1' }); // a variável é removida pelo script
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    expect(result.code, result.out).not.toBe(0);
    expect(result.out).toMatch(/P1002|advisory lock/i);
    // liberado o lock, a mesma execução passa
    const after = await runAsync({ MIGRATE_DATABASE_URL: url });
    expect(after.code, after.out).toBe(0);
  }, 180_000);
});
