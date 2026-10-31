#!/usr/bin/env node
/**
 * Backup lógico + verificação de integridade + restauração em ambiente ISOLADO (nunca no banco de origem).
 *
 *   BACKUP_SOURCE_URL=<conexão DIRETA do banco de origem>   (lida do ambiente; nunca impressa nem gravada)
 *   RESTORE_ADMIN_URL=<postgres LOCAL em loopback com permissão de criar banco>
 *   PG_BIN=<pasta com pg_dump, pg_restore, psql>            (cliente da MESMA versão major ou mais nova que o servidor)
 *   node scripts/backup-verify.mjs --out <pasta FORA do repositório>
 *
 * O que faz, nesta ordem (qualquer falha para tudo e devolve código ≠ 0):
 *  1. valida que o destino da restauração é LOCAL (loopback) e que a origem NÃO é o destino;
 *  2. `pg_dump -Fc --no-owner --no-privileges` (somente leitura; a origem é aberta com `default_transaction_read_only=on`);
 *  3. grava o SHA-256 do arquivo e confere que `pg_restore --list` lê o índice inteiro;
 *  4. cria um banco DESCARTÁVEL no postgres local, restaura o dump nele com `--exit-on-error`;
 *  5. compara, tabela a tabela, contagem de linhas e um hash (md5) do conteúdo entre a ORIGEM e a CÓPIA restaurada;
 *  6. apaga o banco descartável e escreve `<dump>.verify.json` (só nomes de tabela, contagens e hashes: sem dados pessoais).
 * Nada é restaurado em produção, nada é alterado na origem. O dump contém DADOS REAIS: guarde fora do repositório e do OneDrive/nuvem não criptografada.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const fail = (message) => {
  console.error(`ERRO: ${message}`);
  process.exit(1);
};
const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

const sourceUrl = process.env.BACKUP_SOURCE_URL ?? '';
const adminUrl = process.env.RESTORE_ADMIN_URL ?? '';
const pgBin = process.env.PG_BIN ?? '';
const outDir = arg('--out');
if (!sourceUrl || !adminUrl || !pgBin || !outDir) fail('defina BACKUP_SOURCE_URL, RESTORE_ADMIN_URL, PG_BIN e --out <pasta>.');
if (!/^postgres(ql)?:\/\//.test(sourceUrl) || !/^postgres(ql)?:\/\//.test(adminUrl)) fail('as conexões precisam ser URLs postgresql://.');
const resolvedOut = path.resolve(outDir);
if (/[\\/](VS-BY-CLOSET[^\\/]*|\.git)([\\/]|$)/i.test(resolvedOut) && !/[\\/]Temp[\\/]/i.test(resolvedOut)) fail('a pasta de saída precisa ficar FORA do repositório (o dump tem dados reais).');

const parse = (raw) => {
  const url = new URL(raw);
  return { host: url.hostname, port: url.port || '5432', user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.replace(/^\//, ''), sslmode: url.searchParams.get('sslmode') ?? undefined };
};
const source = parse(sourceUrl);
const admin = parse(adminUrl);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
if (!LOOPBACK.has(admin.host)) fail('a restauração só pode acontecer em um postgres LOCAL (loopback).');
if (source.host === admin.host && source.port === admin.port && source.database === admin.database) fail('origem e destino são o mesmo banco.');

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
  ...(conn.sslmode ? { PGSSLMODE: conn.sslmode } : {}),
  ...(readOnly ? { PGOPTIONS: '-c default_transaction_read_only=on' } : {}),
});
const run = (command, args, env, label) => {
  const result = spawnSync(command, args, { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) fail(`${label} falhou (código ${result.status}): ${(result.stderr || '').split('\n').slice(0, 3).join(' | ').replace(/postgres(ql)?:\/\/\S+/gi, '<url>')}`);
  return result.stdout;
};
const sql = (conn, database, query, readOnly = true) => run(bin('psql'), ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', query], envFor(conn, database, readOnly), 'consulta').trim();

const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });

mkdirSync(resolvedOut, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const dumpFile = path.join(resolvedOut, `production-${stamp}.dump`);
const report = { geradoEm: new Date().toISOString(), arquivo: path.basename(dumpFile), etapas: {}, tabelas: [] };

// 2) dump (somente leitura)
run(bin('pg_dump'), ['-Fc', '--no-owner', '--no-privileges', '-f', dumpFile], envFor(source, source.database, true), 'pg_dump');
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
try {
  run(bin('pg_restore'), ['--no-owner', '--no-privileges', '--exit-on-error', '-d', scratch, dumpFile], envFor(admin, scratch), 'pg_restore');
  report.etapas.restauracao = { banco: 'descartável local', ok: true };

  // 5) comparação tabela a tabela (contagem + md5 do conteúdo)
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
  report.etapas.comparacao = { tabelas: tables.length, divergentes: mismatches };
  const migrations = sql(admin, scratch, 'SELECT count(*) FROM _prisma_migrations');
  report.etapas.migracoesNaCopia = Number(migrations);
  report.aprovado = mismatches === 0 && tables.length > 0;
} finally {
  sql(admin, 'postgres', `DROP DATABASE IF EXISTS ${scratch}`, false);
}
writeFileSync(`${dumpFile}.verify.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ aprovado: report.aprovado, arquivo: report.arquivo, sha256: report.etapas.sha256, bytes: report.etapas.dump.bytes, tabelas: report.etapas.comparacao.tabelas, divergentes: report.etapas.comparacao.divergentes, migracoes: report.etapas.migracoesNaCopia }, null, 2));
process.exit(report.aprovado ? 0 : 2);
