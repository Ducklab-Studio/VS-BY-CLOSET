'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, AlertTriangle, Tag, CheckCircle2, Loader2, PackageOpen, XCircle } from 'lucide-react';
import { fetchCatalogSyncReportAction, syncCatalogAction } from './actions';
import type { CatalogSyncReport, ShopifyCatalogItem } from '@/lib/shopify-admin-data';
import { isValePassProduct } from '@/lib/vale-pass-product';
import {
  UNCERTAIN_MESSAGE,
  awaitingLabel,
  awaitingPhysicalInventory,
  classifySyncFailure,
  describeLastSyncOrigin,
  looksCompletedAfterUncertain,
  summarizeSync,
} from '@/lib/catalog-sync-view';

/**
 * Item 12 do pedido: divergências (peça × variante Shopify), última
 * sincronização e o botão "Sincronizar catálogo". STAFF com módulo PIECES
 * vê tudo isto (mesmo padrão de leitura do catálogo Shopify acima na
 * página); só ADMIN vê e usa o botão — a ação em si já é recusada pelo
 * servidor pra STAFF de qualquer forma (item "não confiar só no frontend").
 *
 * Esta tela só APRESENTA: a reconciliação, a autenticação, o SKU e o inventário
 * físico seguem exatamente as regras do servidor. O painel nunca desaparece:
 * se o relatório inicial falha, mostra o erro com "Tentar novamente".
 */

type Ui =
  | { phase: 'idle' }
  | { phase: 'syncing' }
  | { phase: 'success'; text: string }
  | { phase: 'error'; message: string }
  /** Sem resposta a tempo / falha de rede: a rodada PODE ter concluído no servidor. */
  | { phase: 'uncertain'; message: string; checking: boolean };

const AWAITING_PREVIEW = 4;

export function CatalogSyncPanel({
  initialReport,
  initialError = null,
  catalog = null,
  isAdmin,
}: {
  initialReport: CatalogSyncReport | null;
  initialError?: string | null;
  catalog?: readonly ShopifyCatalogItem[] | null;
  isAdmin: boolean;
}) {
  const [report, setReport] = useState<CatalogSyncReport | null>(initialReport);
  const [loadError, setLoadError] = useState<string | null>(initialReport ? null : (initialError ?? 'Não foi possível carregar o relatório de sincronização.'));
  const [reloading, setReloading] = useState(false);
  const [ui, setUi] = useState<Ui>({ phase: 'idle' });
  const [elapsed, setElapsed] = useState(0);

  const syncing = ui.phase === 'syncing';
  const busy = syncing || reloading || (ui.phase === 'uncertain' && ui.checking);

  useEffect(() => {
    if (!syncing) return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [syncing]);

  /** Relê o estado (somente leitura). */
  async function reread(): Promise<{ report: CatalogSyncReport | null; error: string | null }> {
    try {
      return await fetchCatalogSyncReportAction();
    } catch {
      return { report: null, error: 'Sem resposta do servidor agora.' };
    }
  }

  async function reload() {
    setReloading(true);
    const result = await reread();
    setReloading(false);
    if (result.report) {
      setReport(result.report);
      setLoadError(null);
    } else {
      setLoadError(result.error ?? 'Não foi possível carregar o relatório de sincronização.');
    }
  }

  async function sync() {
    const previous = report;
    const startedAt = Date.now();
    setUi({ phase: 'syncing' });

    let result: Awaited<ReturnType<typeof syncCatalogAction>>;
    try {
      result = await syncCatalogAction();
    } catch {
      // A plataforma pode encerrar a função (prazo) ou a rede cair no meio: não é prova de que falhou.
      result = { error: UNCERTAIN_MESSAGE, report: null, timedOut: true };
    }

    if (result.report) {
      setReport(result.report);
      setLoadError(null);
      setUi({ phase: 'success', text: summarizeSync(result.report, formatTime(result.report.lastSyncedAt ?? result.report.generatedAt)).text });
      return;
    }

    if (classifySyncFailure(result) === 'error') {
      setUi({ phase: 'error', message: result.error });
      return;
    }

    // Incerto: confere o estado em vez de declarar falha definitiva.
    setUi({ phase: 'uncertain', message: UNCERTAIN_MESSAGE, checking: true });
    const check = await reread();
    if (check.report) {
      setReport(check.report);
      setLoadError(null);
      if (looksCompletedAfterUncertain(previous, check.report, startedAt)) {
        setUi({
          phase: 'success',
          text: `A sincronização parece ter sido concluída às ${formatTime(check.report.lastSyncedAt as string)} (confirmado ao reler o estado): ${check.report.totalShopifyVariants} variante(s) verificada(s).`,
        });
        return;
      }
    }
    setUi({
      phase: 'uncertain',
      message: 'Não foi possível confirmar se a sincronização terminou. Confira a data abaixo, tente conferir de novo ou sincronize outra vez (é seguro repetir).',
      checking: false,
    });
  }

  const missing = (report?.divergences ?? []).filter(
    (d) => d.kind === 'variant_missing' || d.kind === 'product_inactive' || d.kind === 'variant_deleted_inactive',
  );
  const restored = (report?.divergences ?? []).filter((d) => d.kind === 'variant_restored');
  const skuChanged = (report?.divergences ?? []).filter((d) => d.kind === 'sku_changed');

  const awaiting = awaitingPhysicalInventory(catalog, (item) => isValePassProduct({ productId: item.product.id, variantId: item.id }));
  const origin = report ? describeLastSyncOrigin(report) : null;

  return (
    <div
      data-testid="sync-panel"
      className="mb-8 rounded-xl border border-ink/10 bg-white p-4 shadow-sm transition-colors dark:border-white/10 dark:bg-dark-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink dark:text-dark-text">Sincronização com a Shopify</h2>
          {report && origin ? (
            <p data-testid="sync-last" data-origin={origin.origin} className="mt-0.5 text-sm text-ink/55 dark:text-dark-muted">
              Última sincronização:{' '}
              {report.lastSyncedAt ? `${formatDateTimePt(report.lastSyncedAt)} (horário de Santiago) — ${origin.label}` : 'nunca sincronizado'}
            </p>
          ) : (
            <p className="mt-0.5 text-sm text-ink/55 dark:text-dark-muted">Última sincronização: indisponível agora.</p>
          )}
        </div>
        {isAdmin ? (
          <button
            type="button"
            data-testid="sync-button"
            onClick={() => void sync()}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg bg-marsala px-3.5 py-2 text-sm font-medium text-white shadow-sm transition hover:opacity-90 disabled:opacity-50 dark:bg-gold dark:text-ink"
          >
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Sincronizando…' : 'Sincronizar catálogo'}
          </button>
        ) : null}
      </div>

      {syncing ? (
        <div
          data-testid="sync-loading"
          role="status"
          aria-live="polite"
          className="mt-3 rounded-lg border border-marsala/25 bg-marsala/[0.06] p-3 text-sm text-marsala dark:border-gold/30 dark:bg-gold/10 dark:text-gold"
        >
          <p className="flex items-center gap-2 font-medium">
            <Loader2 size={16} className="animate-spin" />
            Sincronizando com a Shopify… {elapsed > 0 ? `${elapsed} s` : ''}
          </p>
          <p className="mt-1 text-xs opacity-80">Isso pode levar alguns segundos. Não feche nem recarregue a página.</p>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-marsala/15 dark:bg-gold/20">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-marsala dark:bg-gold" />
          </div>
        </div>
      ) : null}

      {ui.phase === 'success' ? (
        <p
          data-testid="sync-success"
          role="status"
          className="mt-3 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-900 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-200"
        >
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          <span>{ui.text}</span>
        </p>
      ) : null}

      {ui.phase === 'error' ? (
        <div
          data-testid="sync-error"
          role="alert"
          className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-200"
        >
          <span className="flex items-start gap-2">
            <XCircle size={16} className="mt-0.5 shrink-0" />
            {ui.message}
          </span>
          {isAdmin ? (
            <button
              type="button"
              data-testid="sync-retry"
              onClick={() => void sync()}
              disabled={busy}
              className="rounded-md border border-red-300 px-3 py-1 text-xs font-semibold hover:bg-red-100 disabled:opacity-50 dark:border-red-700 dark:hover:bg-red-900/40"
            >
              Tentar novamente
            </button>
          ) : null}
        </div>
      ) : null}

      {ui.phase === 'uncertain' ? (
        <div
          data-testid="sync-uncertain"
          role="status"
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <p className="flex items-start gap-2">
            {ui.checking ? <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
            <span>{ui.checking ? `${ui.message} Conferindo…` : ui.message}</span>
          </p>
          {!ui.checking ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="sync-check-again"
                onClick={() => void reload()}
                disabled={busy}
                className="rounded-md border border-amber-300 px-3 py-1 text-xs font-semibold hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:hover:bg-amber-900/40"
              >
                Conferir de novo
              </button>
              {isAdmin ? (
                <button
                  type="button"
                  data-testid="sync-retry"
                  onClick={() => void sync()}
                  disabled={busy}
                  className="rounded-md border border-amber-300 px-3 py-1 text-xs font-semibold hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:hover:bg-amber-900/40"
                >
                  Sincronizar de novo
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {loadError && !report ? (
        <div
          data-testid="sync-load-error"
          role="alert"
          className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <span className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>
              Não foi possível carregar o relatório de divergências agora ({loadError.replace(/[.\s]+$/, '')}). A Shopify ou o servidor podem estar indisponíveis.
            </span>
          </span>
          <button
            type="button"
            data-testid="sync-load-retry"
            onClick={() => void reload()}
            disabled={busy}
            className="rounded-md border border-amber-300 px-3 py-1 text-xs font-semibold hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:hover:bg-amber-900/40"
          >
            {reloading ? 'Tentando…' : 'Tentar novamente'}
          </button>
        </div>
      ) : null}

      {catalog ? (
        awaiting.length > 0 ? (
          <div
            data-testid="sync-awaiting"
            className="mt-3 flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-800/50 dark:bg-sky-950/30 dark:text-sky-200"
          >
            <PackageOpen size={16} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="font-medium">
                {awaiting.length} variante{awaiting.length === 1 ? '' : 's'} da Shopify ainda sem inventário físico
                <span className="font-normal opacity-80"> — não é divergência.</span>
              </p>
              <p className="mt-0.5 opacity-80">
                Aparecem na vitrine como indisponíveis para aluguel até você cadastrar as peças físicas abaixo (o estoque da Shopify não conta).
              </p>
              <p className="mt-0.5 text-xs opacity-80">
                {awaiting.slice(0, AWAITING_PREVIEW).map(awaitingLabel).join(' · ')}
                {awaiting.length > AWAITING_PREVIEW ? ` · e mais ${awaiting.length - AWAITING_PREVIEW}` : ''}
              </p>
            </div>
          </div>
        ) : (
          <p data-testid="sync-awaiting-none" className="mt-3 text-sm text-ink/55 dark:text-dark-muted">
            Todas as variantes ativas da Shopify têm inventário físico cadastrado.
          </p>
        )
      ) : null}

      {report ? (
        report.divergences.length === 0 ? (
          <p data-testid="sync-no-divergence" className="mt-3 text-sm text-ink/55 dark:text-dark-muted">
            Nenhuma divergência nas peças físicas já cadastradas.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {missing.map((d) => (
              <li
                key={d.rentalUnitId}
                className="flex flex-wrap items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-800/50 dark:bg-amber-950/30"
              >
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-300" />
                <div className="min-w-0">
                  <p className="font-medium text-amber-900 dark:text-amber-200">
                    {d.code} — {d.name}{' '}
                    {d.kind === 'variant_deleted_inactive'
                      ? d.applied
                        ? '(arquivada)'
                        : '(será arquivada)'
                      : d.applied
                        ? '(desativada)'
                        : '(será desativada)'}
                  </p>
                  <p className="mt-0.5 text-amber-800/80 dark:text-amber-300/80">{d.note}</p>
                  {d.upcomingReservations > 0 ? (
                    <p className="mt-0.5 font-medium text-amber-900 dark:text-amber-200">
                      ⚠ {d.upcomingReservations} reserva(s) futura(s) com esta peça — não foram alteradas, revise manualmente.
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
            {restored.map((d) => (
              <li
                key={d.rentalUnitId}
                className="flex flex-wrap items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-800/50 dark:bg-emerald-950/30"
              >
                <RefreshCw size={16} className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-300" />
                <div className="min-w-0">
                  <p className="font-medium text-emerald-900 dark:text-emerald-200">
                    {d.code} — {d.name} {d.applied ? '(reativada)' : '(pode ser reativada)'}
                  </p>
                  <p className="mt-0.5 text-emerald-800/80 dark:text-emerald-300/80">{d.note}</p>
                </div>
              </li>
            ))}
            {skuChanged.map((d) => (
              <li
                key={d.rentalUnitId}
                className="flex flex-wrap items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm dark:border-sky-800/50 dark:bg-sky-950/30"
              >
                <Tag size={16} className="mt-0.5 shrink-0 text-sky-700 dark:text-sky-300" />
                <div className="min-w-0">
                  <p className="font-medium text-sky-900 dark:text-sky-200">
                    {d.code} — {d.name} {d.applied ? '(SKU atualizado)' : '(SKU será atualizado)'}
                  </p>
                  <p className="mt-0.5 text-sky-800/80 dark:text-sky-300/80">{d.note}</p>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

function formatDateTimePt(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Santiago' });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { timeZone: 'America/Santiago' });
}
