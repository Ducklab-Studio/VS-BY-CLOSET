import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ValePassOrdersService } from './vale-pass-orders.service';

const DEFAULT_INTERVAL_MINUTES = 10;
const MIN_INTERVAL_MINUTES = 2;
/** Primeira rodada logo depois do boot: pedido perdido durante um deploy aparece em minutos. */
const FIRST_RUN_DELAY_MS = 60_000;

/**
 * Reconciliação automática dos pedidos de Valle Pass com a Shopify — rede de
 * segurança dos webhooks `orders/*`: pedido criado, pago, expirado ou
 * cancelado cujo webhook se perdeu aparece no ClosetAdmin na próxima rodada.
 * Mesmas regras e travas da reconciliação manual; nunca duas rodadas juntas
 * no mesmo processo e nunca derruba o processo.
 */
@Injectable()
export class ValePassOrdersScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ValePassOrdersScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private firstRun: NodeJS.Timeout | null = null;

  constructor(private readonly orders: ValePassOrdersService) {}

  onModuleInit(): void {
    const minutes = valePassOrderSyncIntervalMinutes(process.env);
    if (minutes === null) {
      this.logger.log('Reconciliação automática dos pedidos de Valle Pass desativada.');
      return;
    }
    this.logger.log(`Reconciliação automática dos pedidos de Valle Pass a cada ${minutes} min.`);
    this.firstRun = setTimeout(() => void this.runOnce(), FIRST_RUN_DELAY_MS);
    this.firstRun.unref?.();
    this.timer = setInterval(() => void this.runOnce(), minutes * 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.firstRun) clearTimeout(this.firstRun);
    if (this.timer) clearInterval(this.timer);
    this.firstRun = null;
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    try {
      const report = await this.orders.reconcile();
      const changed = report.created + report.statusChanged + report.vouchersRecovered;
      if (changed > 0 || report.failed > 0) {
        this.logger.log(
          `Pedidos de Valle Pass: ${report.created} novo(s), ${report.statusChanged} com status atualizado, ${report.vouchersRecovered} com vale recuperado, ${report.failed} falha(s).`,
        );
      }
    } catch (err) {
      this.logger.warn(`Reconciliação dos pedidos de Valle Pass não concluída: ${err instanceof Error ? err.name : 'unknown'}`);
    }
  }
}

/** `null` = desligada: em testes, sem credenciais da Shopify Admin, ou com
 *  `VALE_PASS_ORDER_SYNC_INTERVAL_MINUTES=0`. Padrão de 10 min; nunca menos de 2. */
export function valePassOrderSyncIntervalMinutes(env: Record<string, string | undefined>): number | null {
  if (env.VITEST || env.NODE_ENV === 'test') return null;
  if (!env.SHOPIFY_STORE_DOMAIN?.trim() || !env.SHOPIFY_CLIENT_ID?.trim() || !env.SHOPIFY_CLIENT_SECRET?.trim()) return null;
  const raw = env.VALE_PASS_ORDER_SYNC_INTERVAL_MINUTES?.trim();
  if (!raw) return DEFAULT_INTERVAL_MINUTES;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.max(MIN_INTERVAL_MINUTES, Math.floor(minutes));
}
