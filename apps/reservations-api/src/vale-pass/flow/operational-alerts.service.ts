import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PASS_UNIT_KEY, REFUND_ABSORBED_UNITS } from '../vale-pass-capacity';
import { alertText, buildSnapshot, decideNotification, INITIAL_NOTIFY_STATE, type NotifyState, type OperationalSnapshot, type PendingOrderRow } from './operational-alerts';
import { alertsConfigFromEnv, buildNotifiers, type AlertNotifier, type AlertsConfig } from './alerts-notifier';

/**
 * Contador/alerta ATIVO dos pagamentos confirmados sem benefício (Valle Pass 2027). Só leitura: nunca emite, cancela nem envia e-mail ao cliente.
 * `snapshot()` alimenta o contador do menu do ClosetAdmin e o painel; o agendador abaixo avisa por canal configurado (desligado por padrão).
 */
@Injectable()
export class ValePassOperationalAlertsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async snapshot(now: Date = new Date()): Promise<OperationalSnapshot> {
    // Pedidos pagos (ativos, não cancelados/excluídos) com menos unidades emitidas do que o registro diz — retidos OU sem tratamento nenhum.
    const rows = await this.prisma.$queryRaw<{ orderName: string | null; missing: number; ageHours: number; held: boolean; paidAtUnknown: boolean }[]>`
      SELECT o.shopify_order_name AS "orderName",
             (o.quantity - (count(DISTINCT ${PASS_UNIT_KEY}) + ${REFUND_ABSORBED_UNITS}))::int AS missing,
             (extract(epoch FROM (${now}::timestamptz - coalesce(o.payment_confirmed_at,
                (SELECT min(h.created_at) FROM vale_pass_issuance_holds h WHERE h.shopify_order_id = o.shopify_order_id AND h.status = 'OPEN'),
                o.status_changed_at))) / 3600.0)::float8 AS "ageHours",
             EXISTS (SELECT 1 FROM vale_pass_issuance_holds h WHERE h.shopify_order_id = o.shopify_order_id AND h.status = 'OPEN') AS held,
             (o.payment_confirmed_at IS NULL) AS "paidAtUnknown"
      FROM vale_pass_orders o
      LEFT JOIN vale_passes v ON v.shopify_order_id = o.shopify_order_id
      WHERE o.status = 'CONFIRMED' AND o.deleted_in_shopify_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM vale_pass_order_cancellations c WHERE c.shopify_order_id = o.shopify_order_id)
      GROUP BY o.id
      HAVING count(DISTINCT ${PASS_UNIT_KEY}) + ${REFUND_ABSORBED_UNITS} < o.quantity
      ORDER BY 3 DESC
      LIMIT 500`;
    const overdueEmails = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM vale_pass_email_outbox
      WHERE kind = 'INITIAL' AND status NOT IN ('ACCEPTED', 'DELIVERED', 'CANCELLED') AND deadline_at < ${now}`;
    const pending: PendingOrderRow[] = rows.map((row) => ({ orderName: row.orderName, missing: row.missing, ageHours: Math.max(0, row.ageHours), held: row.held, paymentTimeUnknown: row.paidAtUnknown && row.held }));
    return buildSnapshot(pending, overdueEmails[0]?.n ?? 0, now);
  }
}

/**
 * Agendador do aviso ativo (padrão DESLIGADO: `VALE_PASS_ALERTS_MODE` ausente = nada roda). Reaproveita a regra pura de `operational-alerts.ts`
 * (aviso na primeira vez, quando muda, quando piora e como lembrete) e envia pelos canais configurados. Falha de envio nunca derruba o processo.
 */
@Injectable()
export class ValePassAlertsScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ValePassAlertsScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private state: NotifyState = INITIAL_NOTIFY_STATE;
  private running = false;

  private overrideConfig: AlertsConfig | null = null;
  private overrideNotifiers: readonly AlertNotifier[] | null = null;

  constructor(@Inject(ValePassOperationalAlertsService) private readonly alerts: ValePassOperationalAlertsService) {}

  /** Só para testes: configuração e canais falsos (nenhuma rede). */
  configureForTest(config: AlertsConfig, notifiers: readonly AlertNotifier[]): void {
    this.overrideConfig = config;
    this.overrideNotifiers = notifiers;
  }

  onModuleInit(): void {
    const config = this.overrideConfig ?? alertsConfigFromEnv(process.env);
    if (config.mode === 'off') {
      this.logger.log('Aviso ativo dos pagamentos do Valle Pass desligado (VALE_PASS_ALERTS_MODE).');
      return;
    }
    this.logger.log(`Aviso ativo dos pagamentos do Valle Pass (${config.mode}) a cada ${config.intervalMinutes} min.`);
    this.timer = setInterval(() => void this.runOnce(), config.intervalMinutes * 60_000);
    this.timer.unref?.();
    const first = setTimeout(() => void this.runOnce(), 90_000);
    first.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Uma rodada: coleta, decide e (se for o caso) avisa. Devolve se enviou. Nunca lança. */
  async runOnce(now: Date = new Date()): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const snapshot = await this.alerts.snapshot(now);
      const decision = decideNotification(this.state, snapshot, now.getTime());
      this.state = decision.next;
      if (!decision.notify) return false;
      const text = alertText(snapshot, decision.kind);
      const notifiers = this.overrideNotifiers ?? buildNotifiers(this.overrideConfig ?? alertsConfigFromEnv(process.env), this.logger);
      await Promise.allSettled(notifiers.map((notifier) => notifier.send(text)));
      return true;
    } catch (err) {
      this.logger.warn(`Rodada do aviso ativo não concluída: ${err instanceof Error ? err.name : 'unknown'}`);
      return false;
    } finally {
      this.running = false;
    }
  }
}
