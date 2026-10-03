import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ShopifyReconciliationService } from './shopify-reconciliation.service';

const DEFAULT_INTERVAL_MINUTES = 30;
const MIN_INTERVAL_MINUTES = 5;
/** Primeira rodada alguns minutos depois do boot (não disputa com o deploy). */
const FIRST_RUN_DELAY_MS = 5 * 60_000;
const WINDOW_DAYS = 30;

/**
 * Rede de segurança do `orders/delete` para reservas: se o webhook de exclusão
 * se perdeu, o pedido some da Shopify e a reserva vinculada recebe o mesmo
 * tratamento do webhook (ShopifyOrderSyncService) — sem duplicar marcação e sem
 * apagar nada. Só exclusões (`deletionsOnly`); pedido ausente fora da janela de
 * leitura ou falha de acesso nunca é tratado como exclusão (ver
 * ShopifyReconciliationService). Nunca duas rodadas juntas no mesmo processo e
 * nunca derruba o processo.
 */
@Injectable()
export class ShopifyOrderDeletionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShopifyOrderDeletionScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private firstRun: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly reconciliation: ShopifyReconciliationService) {}

  onModuleInit(): void {
    const minutes = shopifyOrderDeletionSyncIntervalMinutes(process.env);
    if (minutes === null) {
      this.logger.log('Verificação automática de pedidos excluídos na Shopify desativada.');
      return;
    }
    this.logger.log(`Verificação automática de pedidos excluídos na Shopify a cada ${minutes} min.`);
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
    if (this.running) return;
    this.running = true;
    try {
      const report = await this.reconciliation.reconcile({ days: WINDOW_DAYS, apply: true, deletionsOnly: true });
      const applied = report.divergences.filter((d) => d.applied).length;
      if (applied > 0) this.logger.log(`Pedidos excluídos na Shopify: ${applied} reserva(s) atualizada(s).`);
    } catch (err) {
      this.logger.warn(`Verificação de pedidos excluídos na Shopify não concluída: ${err instanceof Error ? err.name : 'unknown'}`);
    } finally {
      this.running = false;
    }
  }
}

/** `null` = desligada: em testes, sem credenciais da Shopify Admin, ou com
 *  `SHOPIFY_ORDER_DELETION_SYNC_INTERVAL_MINUTES=0`. Padrão de 30 min; nunca menos de 5. */
export function shopifyOrderDeletionSyncIntervalMinutes(env: Record<string, string | undefined>): number | null {
  if (env.VITEST || env.NODE_ENV === 'test') return null;
  if (!env.SHOPIFY_STORE_DOMAIN?.trim() || !env.SHOPIFY_CLIENT_ID?.trim() || !env.SHOPIFY_CLIENT_SECRET?.trim()) return null;
  const raw = env.SHOPIFY_ORDER_DELETION_SYNC_INTERVAL_MINUTES?.trim();
  if (!raw) return DEFAULT_INTERVAL_MINUTES;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.max(MIN_INTERVAL_MINUTES, Math.floor(minutes));
}
