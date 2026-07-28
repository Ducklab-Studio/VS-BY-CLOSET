import { validateEnv, type ValidatedEnv } from './env.validation';

/**
 * Configuração da aplicação, derivada de variáveis de ambiente validadas.
 *
 * A validação roda uma única vez, no carregamento do módulo — se o ambiente
 * estiver inconsistente o processo morre aqui, antes de aceitar tráfego.
 */
let cached: ValidatedEnv | undefined;

export function env(): ValidatedEnv {
  if (!cached) cached = validateEnv();
  return cached;
}

export default () => {
  const e = env();
  return {
    env: e.nodeEnv,
    isProduction: e.isProduction,
    port: e.port,
    cors: { origins: e.corsOrigins },
    cookie: {
      domain: e.cookieDomain,
      sameSite: e.cookieSameSite,
      secure: e.cookieSecure,
    },
    trustProxy: e.trustProxy,
    redisUrl: e.redisUrl,
    jwt: {
      accessSecret: e.jwt.accessSecret,
      accessTtl: e.jwt.accessTtl,
      refreshSecret: e.jwt.refreshSecret,
      refreshTtl: e.jwt.refreshTtl,
    },
    rateLimit: e.rateLimit,
    storage: e.storage,
  };
};
