import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EMAIL_CONFIG_TOKEN } from './email-tokens';
import { IDEMPOTENCY_WINDOW_MS, liveBlockers, recipientAllowed, recipientsUnrestricted, type EmailConfig } from './email-config';
import { EMAIL_PROVIDER, type EmailProvider, type SendEmailResult } from './email-provider';
import { renderVoucherEmail } from './email-template';
import { IN_FLIGHT_STATUSES, ValePassEmailOutboxService, evaluateGroup, isValidRecipient } from './email-outbox.service';

/** Espera entre tentativas (minutos): 1, 5, 15, 60, 3 h, 6 h, 12 h, 24 h. Com 8 tentativas a mensagem tenta por cerca de 2 dias. */
/** Motivos gravados pelo webhook da Resend que tornam o ENDEREÇO inelegível para novos envios. */
export const SUPPRESSING_REASONS: string[] = ['bounced', 'complained', 'suppressed'];

export const BACKOFF_MINUTES: readonly number[] = [1, 5, 15, 60, 180, 360, 720, 1440];
/** Reserva (lease) enquanto o lote é preparado e enquanto a chamada à Resend está em andamento. Vencida = o processo caiu. */
const CLAIM_LEASE_MS = 2 * 60_000;
const SEND_LEASE_MS = 90_000;
const GROUP_WAIT_MS = 15 * 60_000;
const GROUP_WAIT_LIMIT_MS = 24 * 60 * 60_000;
const AUTH_PAUSE_MS = 15 * 60_000;
const QUOTA_PAUSE_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

/** `attempts` = tentativas já feitas (≥ 1). Jitter de ±10% para não sincronizar reenvios depois de uma queda do provedor. */
export function backoffMs(attempts: number, rng: () => number = Math.random): number {
  const minutes = BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1];
  return Math.round(minutes * 60_000 * (0.9 + rng() * 0.2));
}

export interface TickReport {
  readonly mode: EmailConfig['mode'];
  readonly blocked: readonly string[];
  readonly paused: boolean;
  readonly limitReached: boolean;
  readonly enqueued: number;
  readonly claimed: number;
  readonly accepted: number;
  readonly retrying: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly needsAttention: number;
  readonly unknown: number;
  readonly dryRunReady: number;
  readonly recoveredLeases: number;
  /** Mensagens prontas para sair que NÃO foram reservadas porque o destinatário não está em VALE_PASS_EMAIL_ALLOWED_RECIPIENTS (continuam na fila, intactas). */
  readonly heldByAllowlist: number;
}

const emptyReport = (mode: EmailConfig['mode']): TickReport => ({
  mode, blocked: [], paused: false, limitReached: false, enqueued: 0, claimed: 0, accepted: 0, retrying: 0, failed: 0, cancelled: 0, needsAttention: 0, unknown: 0, dryRunReady: 0, recoveredLeases: 0, heldByAllowlist: 0,
});

type Counters = { -readonly [K in keyof TickReport]: TickReport[K] };

/**
 * Worker da caixa de saída. Segurança por camadas:
 *  - modo "off" (padrão): não faz NADA (nem enfileira);
 *  - modo "dry-run": enfileira e valida/renderiza, mas NUNCA chama o provedor;
 *  - modo "live": só com chave + domínio verificado + remetente válido (ver email-config).
 * Antes de cada envio reavalia o pedido (pago, não cancelado/reembolsado, unidade completa e ativa).
 * Resultado ambíguo (timeout/5xx/rede) nunca é tratado como falha: a próxima tentativa usa a MESMA chave de idempotência (a Resend
 * devolve o envio original em vez de enviar de novo); passadas ~22 h, só uma pessoa decide.
 */
@Injectable()
export class ValePassEmailWorkerService {
  private readonly logger = new Logger(ValePassEmailWorkerService.name);
  private circuitOpenUntil = 0;
  /** Trocável nos testes (jitter determinístico). */
  rng: () => number = Math.random;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: ValePassEmailOutboxService,
    @Inject(EMAIL_CONFIG_TOKEN) private readonly config: EmailConfig,
    @Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider,
  ) {}

  async tick(now: Date = new Date()): Promise<TickReport> {
    const report: Counters = { ...emptyReport(this.config.mode) };
    if (this.config.mode === 'off') return report;

    report.recoveredLeases = await this.recoverLeases(now);
    report.enqueued = (await this.outbox.enqueueMissing(now)).enqueued;

    if (this.config.mode === 'dry-run') {
      report.dryRunReady = await this.dryRun(now);
      return report;
    }
    const blockers = liveBlockers(this.config);
    if (blockers.length > 0) {
      report.blocked = blockers;
      return report;
    }
    if (now.getTime() < this.circuitOpenUntil) {
      report.paused = true;
      return report;
    }
    report.heldByAllowlist = await this.countHeldByAllowlist(now);
    const { ids, limitReached } = await this.claimWithinLimit(now);
    report.limitReached = limitReached;
    report.claimed = ids.length;
    for (const id of ids) {
      try {
        const result = await this.processOne(id, now);
        report[result] += 1;
      } catch (err) {
        // Falha inesperada (ex.: banco): a reserva vence sozinha e a mensagem volta à fila; nada é enviado "pela metade".
        this.logger.error(`Falha ao processar mensagem ${id}: ${err instanceof Error ? err.name : 'unknown'}`);
      }
      if (now.getTime() < this.circuitOpenUntil) break;
    }
    return report;
  }

  /** Mensagens que ficaram SENDING com a reserva vencida (o processo caiu no meio): o resultado é desconhecido, nunca "não enviada". */
  async recoverLeases(now: Date): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE vale_pass_email_outbox SET status = 'UNKNOWN', locked_until = NULL, last_error = 'lease_expired', next_attempt_at = ${now}
      WHERE status = 'SENDING' AND locked_until < ${now}
      RETURNING id::text AS id`;
    for (const { id } of rows) await this.outbox.recordEvent(this.prisma, id, 'LEASE_EXPIRED');
    return rows.length;
  }

  /**
   * Envios que já contam no limite do plano nas últimas 24 h: aceitos + tentativas em andamento/desconhecidas + mensagens JÁ RESERVADAS por
   * algum worker (lease vigente). Contar as reservadas é o que impede dois workers de, juntos, passarem do limite.
   */
  async dailyRemaining(client: Pick<PrismaService, '$queryRaw'>, now: Date): Promise<number> {
    const since = new Date(now.getTime() - DAY_MS);
    // UMA consulta só (um único retrato do banco) e cada linha conta no máximo uma vez. Com consultas separadas, uma mensagem que muda de
    // "reservada" para "enviando" e "aceita" entre elas pode escapar de todas as contagens — e o limite seria ultrapassado.
    const [row] = await client.$queryRaw<{ used: number }[]>`
      SELECT count(*)::int AS used FROM vale_pass_email_outbox
      WHERE accepted_at >= ${since}
         OR (status IN ('SENDING', 'UNKNOWN') AND first_attempt_at >= ${since})
         OR (status IN ('QUEUED', 'UNKNOWN') AND locked_until > ${now})`;
    return this.config.dailyLimit - (row?.used ?? 0);
  }

  /**
   * Conta o que resta do limite e reserva o lote na MESMA transação, sob um lock consultivo: workers concorrentes (dois processos durante um
   * deploy, por exemplo) se enfileiram aqui e cada um enxerga a reserva do outro. A reserva de cada mensagem é atômica (SKIP LOCKED).
   */
  async claimWithinLimit(now: Date): Promise<{ ids: string[]; limitReached: boolean }> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('vale_pass_email_claim'))`;
        const remaining = await this.dailyRemaining(tx, now);
        if (remaining <= 0) return { ids: [], limitReached: true };
        return { ids: await this.claim(tx, Math.min(this.config.batchSize, remaining), now), limitReached: false };
      },
      { timeout: 20_000, maxWait: 20_000 },
    );
  }

  /** Reserva atômica de um lote: dois workers nunca pegam a mesma mensagem (FOR UPDATE SKIP LOCKED). */
  async claim(client: Pick<PrismaService, '$queryRaw'>, limit: number, now: Date): Promise<string[]> {
    // Fail closed: quem não está na lista de destinatários autorizados NUNCA é reservado (a mensagem fica QUEUED, intacta). Sem lista e sem liberação comercial,
    // ninguém é reservado; lista inválida = vazia = nada é reservado.
    const unrestricted = recipientsUnrestricted(this.config);
    const allowed = this.config.allowedRecipients ?? [];
    // CTE MATERIALIZED: com `UPDATE ... WHERE id IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)` o PostgreSQL pode reavaliar a subconsulta e
    // reservar MAIS que o LIMIT (observado: lote de 3 reservou 4). Materializar a escolha garante exatamente até `limit` linhas.
    const rows = await client.$queryRaw<{ id: string; next: Date; created: Date }[]>`
      WITH picked AS MATERIALIZED (
        SELECT id FROM vale_pass_email_outbox
        WHERE status IN ('QUEUED', 'UNKNOWN') AND next_attempt_at <= ${now} AND (locked_until IS NULL OR locked_until < ${now})
          AND (${unrestricted} OR lower(to_email) = ANY(${allowed}::text[]))
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
      UPDATE vale_pass_email_outbox AS o SET locked_until = ${new Date(now.getTime() + CLAIM_LEASE_MS)}
      FROM picked WHERE o.id = picked.id
      RETURNING o.id::text AS id, o.next_attempt_at AS next, o.created_at AS created`;
    // O RETURNING não garante ordem: processa sempre a mensagem mais antiga primeiro.
    return rows.sort((x, y) => x.next.getTime() - y.next.getTime() || x.created.getTime() - y.created.getTime()).map((row) => row.id);
  }

  /** Quantas mensagens prontas para sair ficam retidas pela lista de destinatários autorizados (ou pela falta dela). 0 só com a liberação comercial e sem lista. */
  async countHeldByAllowlist(now: Date): Promise<number> {
    if (recipientsUnrestricted(this.config)) return 0;
    const [row] = await this.prisma.$queryRaw<{ held: number }[]>`
      SELECT count(*)::int AS held FROM vale_pass_email_outbox
      WHERE status IN ('QUEUED', 'UNKNOWN') AND next_attempt_at <= ${now} AND (locked_until IS NULL OR locked_until < ${now})
        AND NOT (lower(to_email) = ANY(${this.config.allowedRecipients ?? []}::text[]))`;
    return row?.held ?? 0;
  }

  private async dryRun(now: Date): Promise<number> {
    const rows = await this.prisma.valePassEmailOutbox.findMany({ where: { status: 'QUEUED', nextAttemptAt: { lte: now } }, take: this.config.batchSize, orderBy: { createdAt: 'asc' } });
    let ready = 0;
    for (const row of rows) {
      const verdict = await evaluateGroup(this.prisma, row.shopifyOrderId, row.groupId);
      if (verdict.ok && isValidRecipient(row.toEmail)) {
        this.renderFor(row.toEmail, verdict); // só valida que o modelo renderiza; nada é enviado nem gravado
        ready++;
      }
    }
    return ready;
  }

  private renderFor(_to: string, verdict: Extract<Awaited<ReturnType<typeof evaluateGroup>>, { ok: true }>) {
    return renderVoucherEmail({
      customerName: verdict.order.customerName,
      orderName: verdict.order.orderName,
      unit: verdict.unit,
      replyTo: this.config.replyTo,
      testCampaign: verdict.testCampaign,
      vouchers: verdict.vouchers.map((voucher) => ({
        company: voucher.company as 'VALLE_SHOWROOM' | 'VS_BY_CLOSET',
        amountCents: voucher.amountCents,
        code: voucher.code,
        validFrom: voucher.validFrom,
        expiresAt: voucher.expiresAt,
      })),
    });
  }

  private async finish(id: string, from: readonly string[], data: Record<string, unknown>, event: string, detail?: Record<string, unknown>): Promise<boolean> {
    const changed = await this.prisma.valePassEmailOutbox.updateMany({ where: { id, status: { in: from as never } }, data: { lockedUntil: null, ...data } });
    if (changed.count === 1) await this.outbox.recordEvent(this.prisma, id, event, detail);
    return changed.count === 1;
  }

  async processOne(id: string, now: Date): Promise<'accepted' | 'retrying' | 'failed' | 'cancelled' | 'needsAttention' | 'unknown'> {
    const row = await this.prisma.valePassEmailOutbox.findUnique({ where: { id } });
    if (!row || !IN_FLIGHT_STATUSES.includes(row.status) || row.status === 'SENDING') return 'retrying';
    const waiting: readonly string[] = ['QUEUED', 'UNKNOWN'];

    // 1) O pedido continua pago e a unidade continua completa e ativa?
    const verdict = await evaluateGroup(this.prisma, row.shopifyOrderId, row.groupId);
    if (!verdict.ok) {
      if (verdict.outcome === 'WAIT') {
        if (now.getTime() - row.createdAt.getTime() > GROUP_WAIT_LIMIT_MS) {
          await this.finish(id, waiting, { status: 'NEEDS_ATTENTION', lastError: 'group_incomplete_too_long' }, 'NEEDS_ATTENTION', { reason: 'group_incomplete_too_long' });
          return 'needsAttention';
        }
        await this.finish(id, waiting, { nextAttemptAt: new Date(now.getTime() + GROUP_WAIT_MS), lastError: 'group_incomplete' }, 'WAITING_GROUP_COMPLETE');
        return 'retrying';
      }
      const status = verdict.outcome === 'CANCELLED' ? 'CANCELLED' : 'NEEDS_ATTENTION';
      await this.finish(id, waiting, { status, lastError: verdict.reason }, status, { reason: verdict.reason });
      return status === 'CANCELLED' ? 'cancelled' : 'needsAttention';
    }

    // 2) Destinatário e limites de tentativa.
    if (!isValidRecipient(row.toEmail)) {
      await this.finish(id, waiting, { status: 'NEEDS_ATTENTION', lastError: 'no_recipient' }, 'NEEDS_ATTENTION', { reason: 'no_recipient' });
      return 'needsAttention';
    }
    // Envio sem lista (liberação comercial): mensagem de campanha de TESTE nunca vai para endereço de comprador; só com lista autorizada.
    if (verdict.testCampaign && recipientsUnrestricted(this.config)) {
      await this.finish(id, waiting, { status: 'NEEDS_ATTENTION', lastError: 'test_campaign_needs_allowlist' }, 'NEEDS_ATTENTION', { reason: 'test_campaign_needs_allowlist' });
      return 'needsAttention';
    }
    // Endereço que já devolveu (bounce), reclamou (spam) ou foi suprimido pelo provedor: não se insiste (reputação do domínio); uma pessoa decide.
    const suppressed = await this.prisma.valePassEmailOutbox.count({ where: { id: { not: id }, toEmail: { equals: row.toEmail, mode: 'insensitive' }, status: 'FAILED', lastError: { in: SUPPRESSING_REASONS } } });
    if (suppressed > 0) {
      await this.finish(id, waiting, { status: 'NEEDS_ATTENTION', lastError: 'recipient_suppressed' }, 'NEEDS_ATTENTION', { reason: 'recipient_suppressed' });
      return 'needsAttention';
    }
    // Defesa em profundidade (a reserva já filtra): fora da lista autorizada nada chega ao provedor; a reserva é devolvida e a mensagem continua na fila.
    if (!recipientAllowed(this.config, row.toEmail)) {
      await this.prisma.valePassEmailOutbox.updateMany({ where: { id, status: { in: ['QUEUED', 'UNKNOWN'] } }, data: { lockedUntil: null } });
      return 'retrying';
    }
    if (row.attempts >= this.config.maxAttempts) {
      await this.finish(id, waiting, { status: 'NEEDS_ATTENTION', lastError: row.status === 'UNKNOWN' ? 'attempts_exhausted_unknown_result' : 'attempts_exhausted' }, 'NEEDS_ATTENTION', { reason: 'attempts_exhausted', attempts: row.attempts });
      return 'needsAttention';
    }
    const sinceFirst = row.firstAttemptAt ? now.getTime() - row.firstAttemptAt.getTime() : 0;
    let idempotencyKey = row.idempotencyKey;
    if (sinceFirst > IDEMPOTENCY_WINDOW_MS) {
      if (row.status === 'UNKNOWN') {
        // A Resend já esqueceu a chave: reenviar poderia duplicar. Só uma pessoa decide (confere no painel da Resend).
        await this.finish(id, waiting, { status: 'NEEDS_ATTENTION', lastError: 'unknown_result_expired' }, 'NEEDS_ATTENTION', { reason: 'unknown_result_expired' });
        return 'needsAttention';
      }
      idempotencyKey = `vpe-${row.id}-r${row.attempts + 1}`; // a tentativa anterior foi RECUSADA (não enviada): uma chave nova é segura
    }

    // 3) Marca "enviando" ANTES de chamar a API (se o processo cair aqui, a reserva vence e o resultado fica "desconhecido").
    const marked = await this.prisma.valePassEmailOutbox.updateMany({
      where: { id, status: { in: ['QUEUED', 'UNKNOWN'] }, lockedUntil: { gte: now } },
      data: { status: 'SENDING', attempts: { increment: 1 }, firstAttemptAt: row.firstAttemptAt ?? now, lastAttemptAt: now, lockedUntil: new Date(now.getTime() + SEND_LEASE_MS), idempotencyKey },
    });
    if (marked.count !== 1) return 'retrying';
    const attempt = row.attempts + 1;
    await this.outbox.recordEvent(this.prisma, id, 'SEND_ATTEMPT', { attempt, keyRotated: idempotencyKey !== row.idempotencyKey });

    // 4) Chamada ao provedor.
    const rendered = this.renderFor(row.toEmail, verdict);
    let result: SendEmailResult;
    try {
      result = await this.provider.send({
        to: row.toEmail,
        from: this.config.from,
        replyTo: this.config.replyTo,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        idempotencyKey,
      });
    } catch {
      result = { kind: 'unknown', reason: 'provider_exception' };
    }

    // 5) Resultado.
    const sending: readonly string[] = ['SENDING', 'UNKNOWN', 'QUEUED'];
    if (result.kind === 'accepted') {
      await this.finish(id, sending, { status: 'ACCEPTED', providerMessageId: result.messageId, acceptedAt: new Date(), lastError: null }, 'ACCEPTED', { attempt });
      return 'accepted';
    }
    if (result.kind === 'rejected') {
      if (result.intervention) {
        // Mesma chave com outro conteúdo (ou chave inválida): não repete e NÃO vira "falha" — uma tentativa anterior pode ter enviado a
        // mensagem original. Uma pessoa confere na Resend e decide (reenvio autorizado, se for o caso).
        await this.finish(id, sending, { status: 'NEEDS_ATTENTION', lastError: result.reason }, 'NEEDS_ATTENTION', { reason: result.reason, httpStatus: result.status, attempt, mayHaveBeenSent: row.attempts > 0 });
        return 'needsAttention';
      }
      if (result.authProblem) {
        this.circuitOpenUntil = now.getTime() + AUTH_PAUSE_MS;
        await this.finish(id, sending, { status: 'NEEDS_ATTENTION', lastError: result.reason }, 'NEEDS_ATTENTION', { reason: result.reason, httpStatus: result.status, attempt });
        this.logger.error('Resend recusou a credencial: envio de vouchers pausado por 15 min. Confira RESEND_API_KEY e o domínio verificado.');
        return 'needsAttention';
      }
      if (result.permanent) {
        await this.finish(id, sending, { status: 'FAILED', failedAt: new Date(), lastError: result.reason }, 'FAILED', { reason: result.reason, httpStatus: result.status, attempt });
        return 'failed';
      }
      if (result.reason === 'quota_exceeded') this.circuitOpenUntil = now.getTime() + QUOTA_PAUSE_MS;
      const wait = Math.max((result.retryAfterSeconds ?? 0) * 1000, backoffMs(attempt, this.rng));
      await this.finish(id, sending, { status: 'QUEUED', nextAttemptAt: new Date(now.getTime() + wait), lastError: result.reason }, 'RETRY_SCHEDULED', { reason: result.reason, attempt, waitSeconds: Math.round(wait / 1000) });
      return 'retrying';
    }
    // Resposta ambígua: pode ter sido aceita. Nunca vira "falha"; a próxima tentativa reaproveita a chave de idempotência.
    if (attempt >= this.config.maxAttempts) {
      await this.finish(id, sending, { status: 'NEEDS_ATTENTION', lastError: 'attempts_exhausted_unknown_result' }, 'NEEDS_ATTENTION', { reason: 'attempts_exhausted_unknown_result', attempt });
      return 'needsAttention';
    }
    const wait = backoffMs(attempt, this.rng);
    await this.finish(id, sending, { status: 'UNKNOWN', nextAttemptAt: new Date(now.getTime() + wait), lastError: result.reason }, 'RESULT_UNKNOWN', { reason: result.reason, attempt, waitSeconds: Math.round(wait / 1000) });
    return 'unknown';
  }
}

/** Liga o worker ao relógio do processo. Nunca derruba o processo e nunca roda duas rodadas ao mesmo tempo. */
@Injectable()
export class ValePassEmailScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ValePassEmailScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly worker: ValePassEmailWorkerService,
    @Inject(EMAIL_CONFIG_TOKEN) private readonly config: EmailConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.mode === 'off' || this.config.workerIntervalSeconds === null) {
      this.logger.log('Envio de vouchers por e-mail DESLIGADO (VALE_PASS_EMAIL_MODE=off).');
      return;
    }
    const blockers = liveBlockers(this.config);
    this.logger.log(
      this.config.mode === 'dry-run'
        ? 'Envio de vouchers por e-mail em DRY-RUN: enfileira e valida, não envia.'
        : blockers.length > 0
          ? `Envio de vouchers por e-mail BLOQUEADO: ${blockers.join('; ')}.`
          : 'Envio de vouchers por e-mail ATIVO.',
    );
    this.timer = setInterval(() => void this.runOnce(), this.config.workerIntervalSeconds * 1000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const report = await this.worker.tick();
      if (report.accepted + report.failed + report.needsAttention + report.unknown + report.retrying + report.enqueued > 0) {
        this.logger.log(`E-mails de vouchers: ${report.enqueued} enfileirado(s), ${report.accepted} aceito(s), ${report.retrying} para repetir, ${report.unknown} com resultado desconhecido, ${report.failed} falha(s), ${report.needsAttention} para intervenção.`);
      }
    } catch (err) {
      this.logger.warn(`Rodada de e-mails de vouchers não concluída: ${err instanceof Error ? err.name : 'unknown'}`);
    } finally {
      this.running = false;
    }
  }
}
