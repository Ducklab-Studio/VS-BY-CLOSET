/**
 * Configuração do aceite eletrônico dos termos do Valle Pass. TUDO DESLIGADO POR PADRÃO: sem as variáveis abaixo, as rotas públicas respondem 404 e nenhum
 * pedido é retido por falta de aceite. Lida a cada uso (não no boot), como as demais chaves do Valle Pass.
 *
 *  - VALE_PASS_TERMS_ACCEPTANCE=on     → liga as rotas públicas e a verificação do token no webhook. Exige TAMBÉM as três variáveis seguintes.
 *  - VALE_PASS_TERMS_VERSION           → identificador da versão APROVADA do texto (ex.: 2027-1). Só se define depois da aprovação do Anderson e do jurídico.
 *  - VALE_PASS_TERMS_SHA256            → SHA-256 (hex, 64) do texto exato aprovado. O frontend precisa exibir esse mesmo texto.
 *  - VALE_PASS_TERMS_TOKEN_SECRET      → segredo da assinatura (mínimo de 32 caracteres), exclusivo desta função. Nunca é devolvido por nenhuma rota.
 *  - VALE_PASS_TERMS_TOKEN_TTL_MIN     → validade do token em minutos (padrão 360; limitada a 5–2880).
 *  - VALE_PASS_TERMS_REQUIRED=on       → (exige a configuração completa) pedido pago SEM aceite verificado fica RETIDO antes da emissão. Se estiver ligada com
 *                                        a configuração incompleta, TODO pedido pago fica retido: falha para o lado seguro (retenção visível e reversível).
 */
export const DEFAULT_TERMS_TOKEN_TTL_MINUTES = 360;
const MIN_TTL_MINUTES = 5;
const MAX_TTL_MINUTES = 48 * 60;
const MIN_SECRET_LENGTH = 32;

export const TERMS_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const TERMS_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface TermsAcceptanceConfig {
  /** `VALE_PASS_TERMS_ACCEPTANCE=on`. */
  readonly enabled: boolean;
  /** `VALE_PASS_TERMS_REQUIRED=on`. */
  readonly required: boolean;
  readonly version: string | null;
  readonly sha256: string | null;
  readonly secret: string | null;
  readonly ttlMs: number;
}

export interface ApprovedTermsConfig extends TermsAcceptanceConfig {
  readonly enabled: true;
  readonly version: string;
  readonly sha256: string;
  readonly secret: string;
}

const isOn = (value: string | undefined): boolean => value?.trim().toLowerCase() === 'on';

export function loadTermsAcceptanceConfig(env: Record<string, string | undefined> = process.env): TermsAcceptanceConfig {
  const version = env.VALE_PASS_TERMS_VERSION?.trim() ?? '';
  const sha256 = env.VALE_PASS_TERMS_SHA256?.trim().toLowerCase() ?? '';
  const secret = env.VALE_PASS_TERMS_TOKEN_SECRET ?? '';
  const ttlRaw = Number(env.VALE_PASS_TERMS_TOKEN_TTL_MIN);
  const ttlMinutes = Number.isInteger(ttlRaw) && ttlRaw >= MIN_TTL_MINUTES && ttlRaw <= MAX_TTL_MINUTES ? ttlRaw : DEFAULT_TERMS_TOKEN_TTL_MINUTES;
  return {
    enabled: isOn(env.VALE_PASS_TERMS_ACCEPTANCE),
    required: isOn(env.VALE_PASS_TERMS_REQUIRED),
    version: TERMS_VERSION_PATTERN.test(version) ? version : null,
    sha256: TERMS_SHA256_PATTERN.test(sha256) ? sha256 : null,
    secret: secret.length >= MIN_SECRET_LENGTH ? secret : null,
    ttlMs: ttlMinutes * 60_000,
  };
}

/** Só uma configuração COMPLETA e ligada conta como "termos aprovados": versão, hash e segredo válidos. Qualquer ausência desliga tudo. */
export function approvedTerms(config: TermsAcceptanceConfig): ApprovedTermsConfig | null {
  if (!config.enabled || config.version === null || config.sha256 === null || config.secret === null) return null;
  return config as ApprovedTermsConfig;
}

export const TERMS_ACCEPTANCE_CONFIG = 'VALE_PASS_TERMS_ACCEPTANCE_CONFIG';
