import type { Logger } from '@nestjs/common';

/**
 * Canais do aviso ativo do Valle Pass. TUDO DESLIGADO por padrão: `VALE_PASS_ALERTS_MODE` ausente = nenhum agendador, nenhuma mensagem.
 *  - `off`     (padrão) nada roda;
 *  - `log`     escreve uma linha de ERRO estruturada nos logs do Railway (interno; permite alerta por log no próprio Railway). Nenhum serviço externo;
 *  - `webhook` além do log, faz POST `{ text }` (compatível com Slack/Discord/Teams "incoming webhook") em `VALE_PASS_ALERTS_WEBHOOK_URL` (HTTPS obrigatório).
 *              Só deve ser configurado com autorização expressa: é um serviço externo. O texto leva só nomes de pedido e números (sem dados pessoais).
 * Canais de e-mail/WhatsApp ficam como proposta (exigem decisão e credenciais) — ver docs.
 */
export type AlertsMode = 'off' | 'log' | 'webhook';

export interface AlertsConfig {
  readonly mode: AlertsMode;
  readonly intervalMinutes: number;
  readonly webhookUrl: string | null;
}

export const DEFAULT_ALERTS_INTERVAL_MINUTES = 15;

export function alertsConfigFromEnv(env: Record<string, string | undefined> = process.env): AlertsConfig {
  const rawMode = env.VALE_PASS_ALERTS_MODE?.trim().toLowerCase();
  const url = env.VALE_PASS_ALERTS_WEBHOOK_URL?.trim() ?? '';
  const httpsUrl = /^https:\/\/[^\s]+$/i.test(url) ? url : null;
  // `webhook` sem URL https válida cai para `log` (nunca tenta enviar para um destino inválido ou inseguro).
  const mode: AlertsMode = rawMode === 'webhook' ? (httpsUrl ? 'webhook' : 'log') : rawMode === 'log' ? 'log' : 'off';
  const raw = Number(env.VALE_PASS_ALERTS_INTERVAL_MINUTES);
  const intervalMinutes = Number.isInteger(raw) && raw >= 5 && raw <= 240 ? raw : DEFAULT_ALERTS_INTERVAL_MINUTES;
  return { mode, intervalMinutes, webhookUrl: mode === 'webhook' ? httpsUrl : null };
}

export interface AlertNotifier {
  readonly channel: string;
  send(text: string): Promise<boolean>;
}

export class LogNotifier implements AlertNotifier {
  readonly channel = 'log';
  constructor(private readonly logger: Pick<Logger, 'error'>) {}
  async send(text: string): Promise<boolean> {
    this.logger.error(`[ALERTA VALE PASS] ${text}`);
    return true;
  }
}

export class WebhookNotifier implements AlertNotifier {
  readonly channel = 'webhook';
  constructor(
    private readonly url: string,
    private readonly logger: Pick<Logger, 'warn'>,
    private readonly doFetch: typeof fetch = fetch,
  ) {}
  async send(text: string): Promise<boolean> {
    if (!/^https:\/\//i.test(this.url)) return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await this.doFetch(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: controller.signal });
      if (!response.ok) this.logger.warn(`Aviso ativo do Valle Pass: o destino respondeu HTTP ${response.status}.`);
      return response.ok;
    } catch (err) {
      this.logger.warn(`Aviso ativo do Valle Pass não enviado: ${err instanceof Error ? err.name : 'unknown'}`);
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function buildNotifiers(config: AlertsConfig, logger: Pick<Logger, 'error' | 'warn'>): AlertNotifier[] {
  if (config.mode === 'off') return [];
  const list: AlertNotifier[] = [new LogNotifier(logger)];
  if (config.mode === 'webhook' && config.webhookUrl) list.push(new WebhookNotifier(config.webhookUrl, logger));
  return list;
}
