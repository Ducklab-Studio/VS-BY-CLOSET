import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ShopifyCatalogSyncService } from './shopify-catalog-sync.service';

const DEFAULT_INTERVAL_MINUTES = 30;
const MIN_INTERVAL_MINUTES = 5;

/**
 * Reconciliação automática do catálogo Shopify ↔ peças físicas. É a rede de
 * segurança do webhook `products/update`/`products/delete`: se um webhook se
 * perder, a peça ainda é arquivada (ou reativada) na próxima rodada.
 *
 * Mesma lógica e mesmas travas da reconciliação manual do painel (lock por
 * peça, UPDATE condicional, idempotente, aborta se a Shopify responder vazio).
 * Não roda no boot — a primeira rodada acontece após um intervalo completo.
 */
@Injectable()
export class CatalogSyncSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CatalogSyncSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly catalogSync: ShopifyCatalogSyncService) {}

  onModuleInit(): void {
    const minutes = catalogSyncIntervalMinutes(process.env);
    if (minutes === null) {
      this.logger.log('Reconciliação automática do catálogo Shopify desativada.');
      return;
    }
    this.logger.log(`Reconciliação automática do catálogo Shopify a cada ${minutes} min.`);
    this.timer = setInterval(() => void this.runOnce(), minutes * 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Uma rodada; nunca duas ao mesmo tempo e nunca derruba o processo. */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const report = await this.catalogSync.reconcile({ apply: true });
      const applied = report.divergences.filter((d) => d.applied).length;
      if (applied > 0) this.logger.log(`Reconciliação automática do catálogo: ${applied} peça(s) atualizada(s).`);
    } catch (err) {
      this.logger.warn(`Reconciliação automática do catálogo não concluída: ${err instanceof Error ? err.name : 'unknown'}`);
    } finally {
      this.running = false;
    }
  }
}

/** `null` = desligada: em testes, sem credenciais da Shopify Admin, ou com
 *  `CATALOG_SYNC_INTERVAL_MINUTES=0`. Padrão de 30 min; nunca menos de 5. */
export function catalogSyncIntervalMinutes(env: Record<string, string | undefined>): number | null {
  if (env.VITEST || env.NODE_ENV === 'test') return null;
  if (!env.SHOPIFY_STORE_DOMAIN?.trim() || !env.SHOPIFY_CLIENT_ID?.trim() || !env.SHOPIFY_CLIENT_SECRET?.trim()) return null;
  const raw = env.CATALOG_SYNC_INTERVAL_MINUTES?.trim();
  if (!raw) return DEFAULT_INTERVAL_MINUTES;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.max(MIN_INTERVAL_MINUTES, Math.floor(minutes));
}
