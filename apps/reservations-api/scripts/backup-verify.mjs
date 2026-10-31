#!/usr/bin/env node
/**
 * Backup lógico + verificação de integridade + restauração em ambiente ISOLADO (nunca no banco de origem).
 *
 *   BACKUP_SOURCE_URL=<conexão DIRETA do banco de origem>   (lida do ambiente; nunca impressa nem gravada; `--source-env NOME` lê de outra variável)
 *   RESTORE_ADMIN_URL=<postgres LOCAL em loopback com permissão de criar banco>
 *   PG_BIN=<pasta com pg_dump, pg_restore, psql>            (cliente da MESMA versão major ou mais nova que o servidor)
 *   node scripts/backup-verify.mjs --preflight --out <pasta FORA do repositório e de pastas sincronizadas>   (só confere; NÃO gera dump)
 *   node scripts/backup-verify.mjs --out <pasta>                                                              (backup + verificação)
 *
 * `--preflight` (somente leitura, não grava dump): confere ferramentas e versões, a conexão com a origem (direta, NÃO pooler), o papel e as PERMISSÕES de leitura (tabelas e
 * sequências), o tamanho do banco, o espaço em disco, a pasta de saída e o postgres local de restauração. Nada é escrito em lugar nenhum.
 *
 * O backup, nesta ordem (qualquer falha para tudo e devolve código ≠ 0):
 *  1. valida que o destino da restauração é LOCAL (loopback), que a origem NÃO é o destino e que a pasta de saída é protegida (fora do repositório e de OneDrive/Dropbox/etc.);
 *  2. `pg_dump -Fc --no-owner --no-privileges` (somente leitura; a origem é aberta com `default_transaction_read_only=on`);
 *  3. grava o SHA-256 do arquivo e confere que `pg_restore --list` lê o índice inteiro;
 *  4. cria um banco DESCARTÁVEL no postgres local, restaura o dump nele com `--exit-on-error`;
 *  5. compara, tabela a tabela, contagem de linhas e um hash (md5) do conteúdo entre a ORIGEM e a CÓPIA restaurada, e as migrações aplicadas (origem × cópia);
 *  6. apaga o banco descartável e escreve `<dump>.verify.json` (só nomes de tabela, contagens e hashes: sem dados pessoais).
 * Nada é restaurado em produção, nada é alterado na origem (o script só emite `SELECT`/`pg_dump` nela). O dump contém DADOS REAIS: guarde fora do repositório e de nuvem não criptografada.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, createReadStream, existsSync, mkdirSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Limpezas a rodar em QUALQUER saída (inclusive `fail`, que usa process.exit e pularia um `finally`): hoje, apagar o banco descartável LOCAL. */
const cleanups = [];
const runCleanups = () => {
  while (cleanups.length > 0) {
    try {
      cleanups.pop()();
    } catch {
      /* a limpeza nunca esconde o erro original */
    }
  }
};
const fail = (message) => {
  console.error(`ERRO: ${message}`);
  runCleanups();
  process.exit(1);
};
process.on('SIGINT', () => {
  runCleanups();
  process.exit(130);
});
const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const flag = (name) => process.argv.includes(name);
const preflight = flag('--preflight');

const sourceEnvName = arg('--source-env') ?? 'BACKUP_SOURCE_URL';
if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(sourceEnvName)) fail('o nome da variável de origem é inválido.');
const sourceUrl = process.env[sourceEnvName] ?? '';
const adminUrl = process.env.RESTORE_ADMIN_URL ?? '';
const pgBin = process.env.PG_BIN ?? '';
const outDir = arg('--out');
if (!sourceUrl || !adminUrl || !pgBin || !outDir) fail(`defina ${sourceEnvName}, RESTORE_ADMIN_URL, PG_BIN e --out <pasta>.`);
if (!/^postgres(ql)?:\/\//.test(sourceUrl) || !/^postgres(ql)?:\/\//.test(adminUrl)) fail('as conexões precisam ser URLs postgresql://.');

const parse = (raw) => {
  const url = new URL(raw);
  return { host: url.hostname, port: url.port || '5432', user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.replace(/^\//, ''), sslmode: url.searchParams.get('sslmode') ?? undefined };
};
const source = parse(sourceUrl);
const admin = parse(adminUrl);

/** Remove da mensagem tudo o que identifica a origem ou carrega credencial (host, usuário, senha, URLs). */
const scrub = (text) => {
  let out = String(text ?? '').replace(/postgres(ql)?:\/\/\S+/gi, '<url>');
  for (const secret of [source.password, admin.password]) if (secret && secret.length >= 4) out = out.split(secret).join('<senha>');
  for (const identity of [source.host, source.user]) if (identity && identity.length >= 3) out = out.split(identity).join('<origem>');
  return out;
};
const failScrubbed = (message) => fail(scrub(message));

// --- pasta de saída protegida
const resolvedOut = path.resolve(outDir);
const SYNCED = /[\\/](OneDrive[^\\/]*|Dropbox|Google ?Drive|iCloud[^\\/]*|Box|pCloud[^\\/]*|Mega[^\\/]*)([\\/]|$)/i;
if (SYNCED.test(resolvedOut)) fail('a pasta de saída está em uma pasta sincronizada com a nuvem (OneDrive/Dropbox/etc.): use uma pasta local protegida.');
if (/[\\/](VS-BY-CLOSET[^\\/]*|\.git)([\\/]|$)/i.test(resolvedOut) && !/[\\/]Temp[\\/]/i.test(resolvedOut)) fail('a pasta de saída precisa ficar FORA do repositório (o dump tem dados reais).');

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
if (!LOOPBACK.has(admin.host)) fail('a restauração só pode acontecer em um postgres LOCAL (loopback).');
if (source.host === admin.host && source.port === admin.port && source.database === admin.database) fail('origem e destino são o mesmo banco.');
if (/-pooler\./i.test(source.host)) fail('a origem é uma conexão do POOLER (pgbouncer): o pg_dump exige a conexão DIRETA (host sem "-pooler").');

const bin = (name) => {
  const exe = path.join(pgBin, process.platform === 'win32' ? `${name}.exe` : name);
  if (!existsSync(exe)) fail(`${name} não encontrado em PG_BIN.`);
  return exe;
};
// A senha vai por variável de ambiente do processo filho (nunca na linha de comando).
const envFor = (conn, database = conn.database, readOnly = false) => ({
  ...process.env,
  PGHOST: conn.host,
  PGPORT: conn.port,
  PGUSER: conn.user,
  PGPASSWORD: conn.password,
  PGDATABASE: database,
  PGCONNECT_TIMEOUT: '20',
  PGCLIENTENCODING: 'UTF8',
  ...(conn.sslmode ? { PGSSLMODE: conn.sslmode } : {}),
  ...(readOnly ? { PGOPTIONS: '-c default_transaction_read_only=on' } : {}),
});
const run = (command, args, env, label) => {
  const result = spawnSync(command, args, { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) failScrubbed(`${label} falhou (código ${result.status}): ${(result.stderr || '').split('\n').slice(0, 3).join(' | ')}`);
  return result.stdout;
};
const sql = (conn, database, query, readOnly = true) => run(bin('psql'), ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', query], envFor(conn, database, readOnly), 'consulta').trim();
const major = (text) => Number((String(text).match(/(\d+)(?:\.\d+)?/) ?? [])[1] ?? NaN);

const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });

// ---------------------------------------------------------------- PREFLIGHT (somente leitura)
if (preflight) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });
  const pgDumpVersion = run(bin('pg_dump'), ['--version'], process.env, 'pg_dump --version').trim();
  add('ferramentas', true, pgDumpVersion);
  const serverVersion = sql(source, source.database, 'SHOW server_version');
  add('origem-versao', major(pgDumpVersion) >= major(serverVersion), `cliente ${major(pgDumpVersion)} ≥ servidor ${major(serverVersion)}`);
  add('origem-direta', true, 'host sem "-pooler"');
  add('origem-papel', true, `papel: ${sql(source, source.database, 'SELECT current_user')} | somente leitura: ${sql(source, source.database, 'SHOW transaction_read_only')}`);
  const noSelectTables = sql(source, source.database, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT has_table_privilege(current_user, c.oid, 'SELECT')");
  const noSeq = sql(source, source.database, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S' AND NOT has_sequence_privilege(current_user, c.oid, 'SELECT')");
  const noSchema = sql(source, source.database, "SELECT NOT has_schema_privilege(current_user, 'public', 'USAGE')");
  add('origem-permissoes', noSelectTables === '0' && noSeq === '0' && noSchema === 'f', `tabelas sem SELECT: ${noSelectTables} | sequências sem SELECT: ${noSeq} | sem USAGE no schema public: ${noSchema === 't'}`);
  const tables = Number(sql(source, source.database, "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"));
  const bytes = Number(sql(source, source.database, 'SELECT pg_database_size(current_database())'));
  const migrations = Number(sql(source, source.database, 'SELECT count(*) FROM _prisma_migrations'));
  add('origem-tamanho', tables > 0, `${tables} tabela(s), ${migrations} migração(ões), banco com ${(bytes / 1048576).toFixed(1)} MiB`);
  // espaço: dump (≤ tamanho do banco) + banco restaurado local (~tamanho do banco) com folga 3×, mínimo 256 MiB
  const needed = Math.max(3 * bytes, 256 * 1048576);
  let free = NaN;
  try {
    let probe = resolvedOut;
    while (!existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    const fs = statfsSync(probe);
    free = Number(fs.bavail) * Number(fs.bsize);
  } catch {
    free = NaN;
  }
  add('espaco-em-disco', Number.isFinite(free) && free >= needed, Number.isFinite(free) ? `livre ${(free / 1048576).toFixed(0)} MiB ≥ necessário ${(needed / 1048576).toFixed(0)} MiB` : 'não foi possível medir o espaço livre');
  add('pasta-de-saida', true, `${resolvedOut} ${existsSync(resolvedOut) ? '(existe)' : '(será criada)'}; fora do repositório e de pastas sincronizadas`);
  const canCreate = sql(admin, 'postgres', "SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname = current_user", false);
  add('restauracao-local', canCreate === 't', `postgres local ${sql(admin, 'postgres', 'SHOW server_version', false)}, loopback, pode criar banco: ${canCreate === 't'}`);
  const ok = checks.every((c) => c.ok);
  for (const c of checks) console.log(`${c.ok ? 'OK    ' : 'FALHA '} ${c.id}  ${scrub(c.detail)}`);
  console.log(ok ? '\nPREFLIGHT: APROVADO (nada foi gravado; nenhum dump foi gerado)' : '\nPREFLIGHT: REPROVADO');
  process.exit(ok ? 0 : 2);
}

// ---------------------------------------------------------------- BACKUP + VERIFICAÇÃO
mkdirSync(resolvedOut, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const dumpFile = path.join(resolvedOut, `production-${stamp}.dump`);
const report = { geradoEm: new Date().toISOString(), arquivo: path.basename(dumpFile), etapas: {}, tabelas: [] };

// 2) dump (somente leitura)
run(bin('pg_dump'), ['-Fc', '--no-owner', '--no-privileges', '-f', dumpFile], envFor(source, source.database, true), 'pg_dump');
try {
  chmodSync(dumpFile, 0o600); // no Windows o efeito é limitado: a proteção vem da pasta (ver o guia)
} catch {
  /* ignora */
}
report.etapas.dump = { bytes: statSync(dumpFile).size };

// 3) hash + índice legível
report.etapas.sha256 = await sha256(dumpFile);
writeFileSync(`${dumpFile}.sha256`, `${report.etapas.sha256}  ${path.basename(dumpFile)}\n`);
const toc = run(bin('pg_restore'), ['--list', dumpFile], process.env, 'pg_restore --list');
report.etapas.indice = { entradas: toc.split('\n').filter((line) => line && !line.startsWith(';')).length };
if (report.etapas.indice.entradas < 10) fail('índice do dump suspeitamente pequeno.');

// 4) restauração em banco descartável LOCAL
const scratch = `restore_check_${stamp.toLowerCase()}_${randomBytes(3).toString('hex')}`;
if (!/^restore_check_[a-z0-9_]+$/.test(scratch)) fail('nome do banco descartável inválido.');
sql(admin, 'postgres', `CREATE DATABASE ${scratch}`, false);
// Qualquer falha daqui para frente (inclusive `fail`, que sai com process.exit) apaga o banco descartável LOCAL.
cleanups.push(() => spawnSync(bin('psql'), ['-X', '-q', '-c', `DROP DATABASE IF EXISTS ${scratch}`], { env: envFor(admin, 'postgres'), encoding: 'utf8' }));
try {
  run(bin('pg_restore'), ['--no-owner', '--no-privileges', '--exit-on-error', '-d', scratch, dumpFile], envFor(admin, scratch), 'pg_restore');
  report.etapas.restauracao = { banco: 'descartável local', ok: true };

  // 5) comparação tabela a tabela (contagem + md5 do conteúdo) e migrações
  const tables = sql(source, source.database, "SELECT schemaname || '.' || quote_ident(tablename) FROM pg_tables WHERE schemaname = 'public' ORDER BY 1").split('\n').filter(Boolean);
  let mismatches = 0;
  for (const table of tables) {
    const query = `SELECT count(*) || '|' || coalesce(md5(string_agg(t::text, ',' ORDER BY t::text)), 'vazio') FROM ${table} t`;
    const [countA, hashA] = sql(source, source.database, query).split('|');
    const [countB, hashB] = sql(admin, scratch, query).split('|');
    const equal = countA === countB && hashA === hashB;
    if (!equal) mismatches++;
    report.tabelas.push({ tabela: table, linhasOrigem: Number(countA), linhasCopia: Number(countB), hashIgual: hashA === hashB });
  }
  const migrationsSource = Number(sql(source, source.database, 'SELECT count(*) FROM _prisma_migrations'));
  const migrationsCopy = Number(sql(admin, scratch, 'SELECT count(*) FROM _prisma_migrations'));
  report.etapas.comparacao = { tabelas: tables.length, divergentes: mismatches, migracoesOrigem: migrationsSource, migracoesCopia: migrationsCopy };
  report.etapas.migracoesNaCopia = migrationsCopy;
  report.aprovado = mismatches === 0 && tables.length > 0 && migrationsSource === migrationsCopy;
} finally {
  runCleanups();
}
writeFileSync(`${dumpFile}.verify.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ aprovado: report.aprovado, arquivo: report.arquivo, sha256: report.etapas.sha256, bytes: report.etapas.dump.bytes, tabelas: report.etapas.comparacao.tabelas, divergentes: report.etapas.comparacao.divergentes, migracoesOrigem: report.etapas.comparacao.migracoesOrigem, migracoesCopia: report.etapas.comparacao.migracoesCopia }, null, 2));
process.exit(report.aprovado ? 0 : 2);
