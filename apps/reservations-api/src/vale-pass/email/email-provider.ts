import { safeReason } from './email-mask';

export interface SendEmailInput {
  readonly to: string;
  /** "Nome <email>" ou "email". */
  readonly from: string;
  readonly replyTo?: string | null;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** Mesma chave = mesma mensagem: a Resend devolve o resultado original em vez de enviar de novo (por 24 h). */
  readonly idempotencyKey: string;
}

/**
 * Resultado de uma tentativa, já classificado para a fila decidir sem olhar detalhes do provedor:
 *  - accepted: a Resend aceitou e devolveu um id;
 *  - rejected: a Resend respondeu que NÃO enviou (definitivo ou "tente depois");
 *  - unknown: não dá para saber se foi aceita (timeout, erro de rede, 5xx, resposta ilegível) — nunca assumir que falhou.
 */
export type SendEmailResult =
  | { readonly kind: 'accepted'; readonly messageId: string }
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly reason: string;
      /** `true` = não adianta repetir igual (destinatário inválido, chave recusada...). */
      readonly permanent: boolean;
      /** Credencial/permissão: pausa o envio todo e chama uma pessoa. */
      readonly authProblem?: boolean;
      readonly retryAfterSeconds?: number;
    }
  | { readonly kind: 'unknown'; readonly reason: string };

export interface EmailProvider {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

export const EMAIL_PROVIDER = Symbol('VALE_PASS_EMAIL_PROVIDER');

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

const RESEND_URL = 'https://api.resend.com/emails';

/**
 * Adaptador da API da Resend (HTTP puro, sem SDK). Não loga nada e nunca devolve texto livre do provedor — a mensagem de erro da Resend
 * pode conter o e-mail do cliente; só o NOME do erro (normalizado) sai daqui.
 */
export class ResendEmailProvider implements EmailProvider {
  constructor(
    private readonly options: { apiKey: string; timeoutMs: number; fetchImpl?: FetchLike; url?: string },
  ) {}

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const fetchImpl = this.options.fetchImpl ?? (fetch as unknown as FetchLike);
      const response = await fetchImpl(this.options.url ?? RESEND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify({
          from: input.from,
          to: [input.to],
          subject: input.subject,
          html: input.html,
          text: input.text,
          ...(input.replyTo ? { reply_to: input.replyTo } : {}),
        }),
        signal: controller.signal,
      });
      return await this.classify(response);
    } catch (err) {
      const name = err instanceof Error ? err.name : 'unknown';
      if (name === 'AbortError' || name === 'TimeoutError') return { kind: 'unknown', reason: 'timeout' };
      return { kind: 'unknown', reason: 'network_error' };
    } finally {
      clearTimeout(timer);
    }
  }

  private async classify(response: Awaited<ReturnType<FetchLike>>): Promise<SendEmailResult> {
    const status = response.status;
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null; // corpo ilegível: o status continua decidindo
    }
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};

    if (status >= 200 && status < 300) {
      const id = record.id;
      if (typeof id === 'string' && id.length > 0 && id.length <= 200) return { kind: 'accepted', messageId: id };
      return { kind: 'unknown', reason: 'invalid_response' }; // 2xx sem id: pode ter sido enviado
    }

    const reason = safeReason(record.name, `http_${status}`);
    if (status === 429) {
      const header = Number(response.headers.get('retry-after'));
      const quota = /quota/.test(reason);
      const retryAfterSeconds = Number.isFinite(header) && header > 0 ? Math.min(header, 86_400) : quota ? 3_600 : undefined;
      return { kind: 'rejected', status, reason: quota ? 'quota_exceeded' : 'rate_limited', permanent: false, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) };
    }
    if (status === 401 || status === 403) return { kind: 'rejected', status, reason: reason === `http_${status}` ? 'auth_error' : reason, permanent: true, authProblem: true };
    if (status === 409) return { kind: 'unknown', reason: 'idempotency_conflict' }; // a mesma chave está em andamento: resultado ainda desconhecido
    if (status >= 500) return { kind: 'unknown', reason: 'http_5xx' };
    return { kind: 'rejected', status, reason, permanent: true };
  }
}
