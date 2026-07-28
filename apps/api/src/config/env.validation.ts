/**
 * Validação de variáveis de ambiente.
 *
 * Roda ANTES de qualquer módulo subir. A regra é falhar alto e cedo: um deploy
 * que sobe com segredo de desenvolvimento é pior do que um deploy que não sobe.
 */

const DEV_SECRETS = new Set(['dev-access-secret', 'dev-refresh-secret']);
const MIN_SECRET_LENGTH = 32;

class EnvError extends Error {
  constructor(problems: string[]) {
    super(
      [
        '',
        '╭─────────────────────────────────────────────────────────────╮',
        '│  Configuração de ambiente inválida — a API não vai subir.   │',
        '╰─────────────────────────────────────────────────────────────╯',
        '',
        ...problems.map((p) => `  ✗ ${p}`),
        '',
        '  Gere segredos fortes com:  openssl rand -base64 48',
        '',
      ].join('\n'),
    );
    this.name = 'EnvError';
  }
}

export interface ValidatedEnv {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  databaseUrl: string;
  corsOrigins: string[];
  cookieDomain?: string;
  cookieSameSite: 'lax' | 'strict' | 'none';
  cookieSecure: boolean;
  trustProxy: boolean;
  redisUrl?: string;
  jwt: {
    accessSecret: string;
    accessTtl: number;
    refreshSecret: string;
    refreshTtl: number;
  };
  rateLimit: { ttl: number; max: number };
  storage?: {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    publicUrl: string;
    forcePathStyle: boolean;
  };
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function validateEnv(env: NodeJS.ProcessEnv = process.env): ValidatedEnv {
  const problems: string[] = [];
  const nodeEnv = (env.NODE_ENV ?? 'development') as ValidatedEnv['nodeEnv'];
  const isProduction = nodeEnv === 'production';

  // ── Banco ────────────────────────────────────────────────────────────────
  const databaseUrl = env.DATABASE_URL ?? '';
  if (!databaseUrl) {
    problems.push('DATABASE_URL não definida.');
  } else if (isProduction && /localhost|127\.0\.0\.1/.test(databaseUrl)) {
    problems.push('DATABASE_URL aponta para localhost em produção.');
  }
  if (isProduction && databaseUrl && !/sslmode=/.test(databaseUrl)) {
    problems.push(
      'DATABASE_URL sem sslmode em produção. Use ?sslmode=require (ou no-verify para provedores com cert próprio).',
    );
  }

  // ── Segredos JWT ─────────────────────────────────────────────────────────
  const accessSecret = env.JWT_ACCESS_SECRET ?? '';
  const refreshSecret = env.JWT_REFRESH_SECRET ?? '';

  for (const [name, secret] of [
    ['JWT_ACCESS_SECRET', accessSecret],
    ['JWT_REFRESH_SECRET', refreshSecret],
  ] as const) {
    if (!secret) {
      problems.push(`${name} não definida.`);
    } else if (isProduction) {
      if (DEV_SECRETS.has(secret) || secret.startsWith('troque-')) {
        problems.push(`${name} ainda está com o valor de exemplo.`);
      } else if (secret.length < MIN_SECRET_LENGTH) {
        problems.push(`${name} tem menos de ${MIN_SECRET_LENGTH} caracteres.`);
      }
    }
  }

  if (accessSecret && accessSecret === refreshSecret) {
    problems.push('JWT_ACCESS_SECRET e JWT_REFRESH_SECRET precisam ser diferentes.');
  }

  // ── CORS / domínio ───────────────────────────────────────────────────────
  const corsRaw = env.CORS_ORIGIN ?? (isProduction ? '' : 'http://localhost:3000');
  const corsOrigins = corsRaw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // Com proxy de mesmo domínio o browser nunca faz requisição cross-origin,
  // então CORS vazio é válido — e é a configuração mais segura.
  const sameOriginProxy = bool(env.SAME_ORIGIN_PROXY, true);
  if (isProduction && corsOrigins.length === 0 && !sameOriginProxy) {
    problems.push('CORS_ORIGIN vazio em produção sem SAME_ORIGIN_PROXY habilitado.');
  }
  if (isProduction && corsOrigins.some((o) => o.startsWith('http://'))) {
    problems.push('CORS_ORIGIN contém origem http:// em produção. Use https://.');
  }
  if (corsOrigins.includes('*')) {
    problems.push('CORS_ORIGIN=* é incompatível com cookies de credencial.');
  }

  // ── Cookies ──────────────────────────────────────────────────────────────
  const cookieSameSite = (env.COOKIE_SAMESITE ??
    (sameOriginProxy ? 'lax' : 'none')) as ValidatedEnv['cookieSameSite'];
  if (!['lax', 'strict', 'none'].includes(cookieSameSite)) {
    problems.push(`COOKIE_SAMESITE inválido: "${cookieSameSite}". Use lax, strict ou none.`);
  }
  const cookieSecure = bool(env.COOKIE_SECURE, isProduction);
  if (cookieSameSite === 'none' && !cookieSecure) {
    problems.push('COOKIE_SAMESITE=none exige COOKIE_SECURE=true (regra do navegador).');
  }

  // ── Object storage (opcional, mas tudo-ou-nada) ──────────────────────────
  const storageVars = {
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  };
  const storageProvided = Object.values(storageVars).filter(Boolean).length;
  let storage: ValidatedEnv['storage'];

  if (storageProvided > 0) {
    const missing = Object.entries(storageVars)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      problems.push(
        `Configuração de storage incompleta. Faltando: ${missing
          .map((m) => m.replace(/([A-Z])/g, '_$1').toUpperCase())
          .join(', ')}`,
      );
    } else {
      storage = {
        endpoint: env.S3_ENDPOINT || undefined,
        region: env.S3_REGION ?? 'auto',
        bucket: storageVars.bucket!,
        accessKeyId: storageVars.accessKeyId!,
        secretAccessKey: storageVars.secretAccessKey!,
        publicUrl: (env.S3_PUBLIC_URL ?? '').replace(/\/$/, ''),
        forcePathStyle: bool(env.S3_FORCE_PATH_STYLE, !!env.S3_ENDPOINT),
      };
      if (!storage.publicUrl) {
        problems.push('S3_PUBLIC_URL é obrigatória quando o storage está configurado.');
      }
    }
  } else if (isProduction) {
    // Não bloqueia o boot: a loja funciona com URLs externas de imagem.
    // eslint-disable-next-line no-console
    console.warn(
      '[env] Object storage não configurado — upload de imagens ficará desabilitado.',
    );
  }

  // ── Redis (rate limit distribuído) ───────────────────────────────────────
  const redisUrl = env.REDIS_URL || undefined;
  const instances = int(env.WEB_CONCURRENCY, 1);
  if (isProduction && !redisUrl && instances > 1) {
    problems.push(
      'REDIS_URL é obrigatória com mais de uma instância — rate limit em memória não é compartilhado.',
    );
  }

  if (problems.length > 0) throw new EnvError(problems);

  return {
    nodeEnv,
    isProduction,
    port: int(env.PORT ?? env.API_PORT, 3333),
    databaseUrl,
    corsOrigins,
    cookieDomain: env.COOKIE_DOMAIN || undefined,
    cookieSameSite,
    cookieSecure,
    trustProxy: bool(env.TRUST_PROXY, isProduction),
    redisUrl,
    jwt: {
      accessSecret,
      accessTtl: int(env.JWT_ACCESS_TTL, 900),
      refreshSecret,
      refreshTtl: int(env.JWT_REFRESH_TTL, 604800),
    },
    rateLimit: {
      ttl: int(env.RATE_LIMIT_TTL, 60),
      max: int(env.RATE_LIMIT_MAX, 120),
    },
    storage,
  };
}
