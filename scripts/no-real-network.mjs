/**
 * Rede real bloqueada em testes e builds locais/CI.
 *
 * Nenhuma validação pode falar com a Shopify real, a Vercel, o Railway ou o
 * Neon principal. Este módulo troca `fetch` e `http(s).request/get` por versões
 * que só deixam passar hosts locais (localhost, 127.0.0.1, ::1); qualquer outro
 * host é recusado ANTES de abrir conexão, e a tentativa fica registrada.
 *
 * Três formas de uso:
 *  - `--import` (via `runWithoutRealNetwork`, abaixo, ou NODE_OPTIONS): com
 *    `NO_REAL_NETWORK=1`, instala ao carregar — em todo processo filho também
 *    (workers do `next build`, `next start`, API, vitest), porque NODE_OPTIONS
 *    é herdado. As tentativas vão para `REAL_NETWORK_LOG`, lido no fim.
 *  - `installNoRealNetworkGuard()` direto (setup do vitest da API).
 *  - `runWithoutRealNetwork(cmd, args)` / `node scripts/no-real-network.mjs <cmd>`:
 *    roda o comando com o bloqueio e FALHA se houve qualquer tentativa, mesmo
 *    que o código tenha engolido o erro.
 *
 * O Postgres do Prisma não passa por aqui (engine nativa, TCP próprio): o banco
 * de teste continua acessível; quem garante que é o de teste são os wrappers.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STATE = Symbol.for('vs-by-closet.no-real-network');

export function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(h);
}

function hostOf(target) {
  try {
    if (target instanceof URL) return target.hostname;
    if (typeof target === 'string') return new URL(target).hostname;
    if (target && typeof target.url === 'string') return new URL(target.url).hostname; // Request
    if (target && typeof target === 'object') return target.hostname ?? target.host?.split(':')[0] ?? 'localhost';
  } catch {
    /* URL inválida: o próprio fetch recusa */
  }
  return '';
}

function record(state, host) {
  state.blocked.push(host);
  const log = process.env.REAL_NETWORK_LOG;
  if (log) {
    try {
      appendFileSync(log, `${host}\t${process.pid}\n`);
    } catch {
      /* o registro em memória continua valendo */
    }
  }
  console.error(`[rede real bloqueada] tentativa de acessar ${host} durante teste/build — use a Shopify simulada.`);
}

function blockedError(host) {
  const err = new Error(`Rede real bloqueada em teste/build: ${host}`);
  err.code = 'REAL_NETWORK_BLOCKED';
  return err;
}

/** Idempotente: instalar duas vezes não empilha wrappers. */
export function installNoRealNetworkGuard() {
  if (globalThis[STATE]) return globalThis[STATE];
  const state = { blocked: [] };
  globalThis[STATE] = state;

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === 'function') {
    globalThis.fetch = function guardedFetch(input, init) {
      const host = hostOf(input);
      if (!isLoopbackHost(host)) {
        record(state, host || '(desconhecido)');
        return Promise.reject(blockedError(host));
      }
      return originalFetch.call(this, input, init);
    };
  }

  for (const mod of [http, https]) {
    for (const method of ['request', 'get']) {
      const original = mod[method];
      mod[method] = function guardedRequest(target, ...rest) {
        const host = hostOf(target) || (rest[0] && typeof rest[0] === 'object' ? hostOf(rest[0]) : '');
        if (host && !isLoopbackHost(host)) {
          record(state, host);
          throw blockedError(host);
        }
        return original.call(this, target, ...rest);
      };
    }
  }
  return state;
}

/** Tentativas registradas neste processo desde a última leitura. */
export function takeBlockedRequests() {
  const state = globalThis[STATE];
  if (!state) return [];
  return state.blocked.splice(0);
}

/**
 * Roda `cmd args` com o bloqueio em todos os processos (NODE_OPTIONS) e devolve
 * o código de saída — diferente de zero se o comando falhou OU se houve qualquer
 * tentativa de rede real.
 */
export function runWithoutRealNetwork(cmd, args, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'no-real-network-'));
  const log = path.join(dir, 'attempts.log');
  const hook = pathToFileURL(fileURLToPath(import.meta.url)).href;
  const env = {
    ...process.env,
    ...options.env,
    NO_REAL_NETWORK: '1',
    REAL_NETWORK_LOG: log,
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: `${options.env?.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? ''} --import=${hook}`.trim(),
  };
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: options.cwd, env, shell: process.platform === 'win32' && !path.isAbsolute(cmd) });
  const attempts = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  rmSync(dir, { recursive: true, force: true });
  const hosts = [...new Set(attempts.map((line) => line.split('\t')[0]))];
  if (hosts.length > 0) {
    console.error(`\n✖ Rede real: ${attempts.length} tentativa(s) bloqueada(s) (${hosts.join(', ')}). Teste/build reprovado.`);
    return 1;
  }
  console.log('\nRede real: 0 chamadas (bloqueio ativo em todos os processos).');
  return result.status ?? 1;
}

if (process.env.NO_REAL_NETWORK === '1') installNoRealNetworkGuard();

// CLI: node scripts/no-real-network.mjs <comando> [args...]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    console.error('Uso: node scripts/no-real-network.mjs <comando> [args...]');
    process.exit(2);
  }
  process.exit(runWithoutRealNetwork(cmd, args));
}
