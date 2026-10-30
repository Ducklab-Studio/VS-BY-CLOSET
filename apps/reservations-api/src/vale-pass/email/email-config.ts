/**
 * Configuração do envio dos vouchers por e-mail (Valle Pass 2027) — tudo por variável de ambiente do BACKEND (Railway).
 *
 * Fail closed: o padrão é NÃO enviar nada. Enviar de verdade exige, ao mesmo tempo:
 *   1) VALE_PASS_EMAIL_MODE=live                      (decisão explícita; padrão "off")
 *   2) RESEND_API_KEY presente                        (a chave nunca vai para o código, logs ou banco)
 *   3) VALE_PASS_EMAIL_DOMAIN_VERIFIED=true           (a pessoa confirma no painel da Resend que o DNS foi verificado)
 *   4) remetente válido (VALE_PASS_EMAIL_FROM)
 * Opcional e restritiva: VALE_PASS_EMAIL_ALLOWED_RECIPIENTS (lista de endereços). Ausente = sem restrição (comportamento anterior). Presente = o envio real
 * vai SOMENTE a esses endereços; vazia ou com qualquer item inválido = FALHA FECHADA (nenhum envio real). Vale para o worker e para reenvios.
 * Cadastrar o domínio na Resend, ou já existir RESEND_API_KEY para os lembretes de retirada, NÃO liga o envio de vouchers.
 */
export type EmailMode = 'off' | 'dry-run' | 'live';

export const DEFAULT_FROM = 'Valle Pass <vallepass@vallebycloset.com>';
/** Plano gratuito da Resend: 100 e-mails/dia. A margem deixa espaço para os lembretes de retirada, que usam a mesma conta. */
export const DEFAULT_DAILY_LIMIT = 80;
export const DEFAULT_MAX_ATTEMPTS = 8;
/** Prazo prometido ao cliente: códigos por e-mail em até 3 dias após o pagamento confirmado. */
export const DELIVERY_DEADLINE_DAYS = 3;
/** A Resend deduplica por Idempotency-Key durante 24 h; antes disso a MESMA chave é reaproveitada, depois disso um resultado desconhecido exige uma pessoa. */
export const IDEMPOTENCY_WINDOW_MS = 22 * 60 * 60 * 1000;

export interface EmailConfig {
  readonly mode: EmailMode;
  readonly apiKey: string | null;
  readonly from: string;
  readonly replyTo: string | null;
  readonly domainVerified: boolean;
  readonly dailyLimit: number;
  readonly maxAttempts: number;
  readonly batchSize: number;
  readonly requestTimeoutMs: number;
  /** Intervalo do worker em segundos; `null` = worker desligado (testes ou configurado com 0). */
  readonly workerIntervalSeconds: number | null;
  readonly webhookSecret: string | null;
  /** `null` = lista não configurada (sem restrição). Array (mesmo vazio) = só estes endereços (minúsculos, sem repetição) podem receber envio real. */
  readonly allowedRecipients: readonly string[] | null;
  /** Descrição (nunca os endereços) dos problemas da lista; qualquer um bloqueia todo envio real. */
  readonly allowlistProblems: readonly string[];
}

export const MAX_ALLOWED_RECIPIENTS = 20;

const ADDRESS = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

function intIn(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Lê VALE_PASS_EMAIL_ALLOWED_RECIPIENTS: separadores vírgula, ponto e vírgula ou espaço; sem nomes, curingas ou domínios inteiros. */
export function parseAllowedRecipients(raw: string | undefined): Pick<EmailConfig, 'allowedRecipients' | 'allowlistProblems'> {
  if (raw === undefined) return { allowedRecipients: null, allowlistProblems: [] };
  const tokens = raw.split(/[,;\s]+/).filter((token) => token !== '');
  const problems: string[] = [];
  const valid = new Set<string>();
  let invalid = 0;
  for (const token of tokens) {
    const address = token.toLowerCase();
    if (address.length > 320 || address.includes('*') || !ADDRESS.test(address)) invalid++;
    else valid.add(address);
  }
  if (tokens.length === 0) problems.push('lista vazia (para não restringir, remova a variável)');
  if (invalid > 0) problems.push(`${invalid} item(ns) inválido(s) (use só endereços completos, sem nome, curinga ou domínio inteiro)`);
  if (valid.size > MAX_ALLOWED_RECIPIENTS) problems.push(`mais de ${MAX_ALLOWED_RECIPIENTS} endereços`);
  // Falha fechada: com qualquer problema a lista vira vazia, então nenhum destinatário passa mesmo que o bloqueio de `liveBlockers` fosse ignorado.
  return { allowedRecipients: problems.length > 0 ? [] : [...valid], allowlistProblems: problems };
}

/** Este endereço pode receber envio real? Sem lista configurada, sim; com lista, só se estiver nela (comparação sem diferenciar maiúsculas). */
export function recipientAllowed(config: Pick<EmailConfig, 'allowedRecipients'>, address: string | null | undefined): boolean {
  if (config.allowedRecipients === null) return true;
  const normalized = (address ?? '').trim().toLowerCase();
  return normalized !== '' && config.allowedRecipients.includes(normalized);
}

export function loadEmailConfig(env: Record<string, string | undefined> = process.env): EmailConfig {
  const rawMode = env.VALE_PASS_EMAIL_MODE?.trim().toLowerCase();
  const mode: EmailMode = rawMode === 'live' ? 'live' : rawMode === 'dry-run' ? 'dry-run' : 'off';
  const workerRaw = env.VALE_PASS_EMAIL_WORKER_INTERVAL_SECONDS?.trim();
  let workerIntervalSeconds: number | null = 60;
  if (env.VITEST || env.NODE_ENV === 'test') workerIntervalSeconds = null;
  else if (workerRaw !== undefined && workerRaw !== '') {
    const seconds = Number(workerRaw);
    workerIntervalSeconds = !Number.isFinite(seconds) || seconds <= 0 ? null : Math.max(10, Math.floor(seconds));
  }
  return {
    mode,
    apiKey: env.RESEND_API_KEY?.trim() || null,
    from: env.VALE_PASS_EMAIL_FROM?.trim() || DEFAULT_FROM,
    replyTo: env.VALE_PASS_EMAIL_REPLY_TO?.trim() || null,
    domainVerified: env.VALE_PASS_EMAIL_DOMAIN_VERIFIED?.trim().toLowerCase() === 'true',
    dailyLimit: intIn(env.VALE_PASS_EMAIL_DAILY_LIMIT, DEFAULT_DAILY_LIMIT, 1, 100_000),
    maxAttempts: intIn(env.VALE_PASS_EMAIL_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 1, 20),
    batchSize: intIn(env.VALE_PASS_EMAIL_BATCH_SIZE, 10, 1, 100),
    requestTimeoutMs: intIn(env.VALE_PASS_EMAIL_TIMEOUT_MS, 10_000, 1_000, 60_000),
    workerIntervalSeconds,
    webhookSecret: env.RESEND_WEBHOOK_SECRET?.trim() || null,
    ...parseAllowedRecipients(env.VALE_PASS_EMAIL_ALLOWED_RECIPIENTS),
  };
}

/** Endereço de e-mail puro de um remetente "Nome <email>" ou "email". */
export function senderAddress(from: string): string | null {
  const inBrackets = /<([^<>]+)>\s*$/.exec(from);
  const address = (inBrackets ? inBrackets[1] : from).trim();
  return ADDRESS.test(address) ? address : null;
}

/** Motivos pelos quais o envio REAL está bloqueado (lista vazia = pode enviar). Só descrições, nunca valores de segredo. */
export function liveBlockers(config: EmailConfig): string[] {
  const reasons: string[] = [];
  if (config.mode !== 'live') reasons.push(`modo "${config.mode}" (o envio real exige VALE_PASS_EMAIL_MODE=live)`);
  if (!config.apiKey) reasons.push('RESEND_API_KEY ausente');
  if (!config.domainVerified) reasons.push('domínio ainda não marcado como verificado (VALE_PASS_EMAIL_DOMAIN_VERIFIED)');
  if (!senderAddress(config.from)) reasons.push('remetente inválido (VALE_PASS_EMAIL_FROM)');
  for (const problem of config.allowlistProblems) reasons.push(`lista de destinatários autorizados inválida (VALE_PASS_EMAIL_ALLOWED_RECIPIENTS): ${problem}`);
  return reasons;
}

export function canSendLive(config: EmailConfig): boolean {
  return liveBlockers(config).length === 0;
}

/** O que o painel pode mostrar da configuração: só booleanos e o modo — nunca a chave nem o segredo. */
export function publicEmailStatus(config: EmailConfig): {
  mode: EmailMode;
  canSend: boolean;
  blockers: string[];
  providerConfigured: boolean;
  domainVerified: boolean;
  webhookConfigured: boolean;
  dailyLimit: number;
  sender: string | null;
  /** Só o estado e a quantidade — nunca os endereços. */
  recipientAllowlist: { active: boolean; size: number; valid: boolean };
} {
  const blockers = liveBlockers(config);
  return {
    mode: config.mode,
    canSend: blockers.length === 0,
    blockers,
    providerConfigured: Boolean(config.apiKey),
    domainVerified: config.domainVerified,
    webhookConfigured: Boolean(config.webhookSecret),
    dailyLimit: config.dailyLimit,
    sender: senderAddress(config.from),
    recipientAllowlist: { active: config.allowedRecipients !== null, size: config.allowedRecipients?.length ?? 0, valid: config.allowlistProblems.length === 0 },
  };
}
