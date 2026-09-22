'use client';

import { useState, useTransition } from 'react';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import { syncCatalogAction } from './actions';
import type { CatalogSyncReport } from '@/lib/shopify-admin-data';

/**
 * Item 12 do pedido: divergências (peça × variante Shopify), última
 * sincronização e o botão "Sincronizar catálogo". STAFF com módulo PIECES
 * vê tudo isto (mesmo padrão de leitura do catálogo Shopify acima na
 * página); só ADMIN vê e usa o botão — a ação em si já é recusada pelo
 * servidor pra STAFF de qualquer forma (item "não confiar só no frontend").
 */
export function CatalogSyncPanel({ initialReport, isAdmin }: { initialReport: CatalogSyncReport; isAdmin: boolean }) {
  const [report, setReport] = useState(initialReport);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function sync() {
    setError(null);
    startTransition(async () => {
      const result = await syncCatalogAction();
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.report) setReport(result.report);
    });
  }

  const missing = report.divergences.filter((d) => d.kind === 'variant_missing');
  const restored = report.divergences.filter((d) => d.kind === 'variant_restored');

  return (
    <div className="mb-8 rounded-xl border border-ink/10 bg-white p-4 shadow-sm transition-colors dark:border-white/10 dark:bg-dark-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink dark:text-dark-text">Sincronização com a Shopify</h2>
          <p className="mt-0.5 text-sm text-ink/55 dark:text-dark-muted">
            Última sincronização: {report.lastSyncedAt ? `${formatDateTimePt(report.lastSyncedAt)}${report.lastSyncedByName ? ` — ${report.lastSyncedByName}` : ''}` : 'nunca sincronizado'}
          </p>
        </div>
        {isAdmin ? (
          <button
            type="button"
            onClick={sync}
            disabled={pending}
            className="flex items-center gap-1.5 rounded-lg bg-marsala px-3.5 py-2 text-sm font-medium text-white shadow-sm transition hover:opacity-90 disabled:opacity-50 dark:bg-gold dark:text-ink"
          >
            <RefreshCw size={14} className={pending ? 'animate-spin' : ''} />
            {pending ? 'Sincronizando…' : 'Sincronizar catálogo'}
          </button>
        ) : null}
      </div>

      {error ? <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p> : null}

      {report.divergences.length === 0 ? (
        <p className="mt-3 text-sm text-ink/55 dark:text-dark-muted">Nenhuma divergência — peças físicas e catálogo Shopify batem.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {missing.map((d) => (
            <li key={d.rentalUnitId} className="flex flex-wrap items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-800/50 dark:bg-amber-950/30">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-300" />
              <div className="min-w-0">
                <p className="font-medium text-amber-900 dark:text-amber-200">
                  {d.code} — {d.name} {d.applied ? '(desativada)' : '(será desativada)'}
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
            <li key={d.rentalUnitId} className="flex flex-wrap items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-800/50 dark:bg-emerald-950/30">
              <RefreshCw size={16} className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-300" />
              <div className="min-w-0">
                <p className="font-medium text-emerald-900 dark:text-emerald-200">
                  {d.code} — {d.name} {d.applied ? '(reativada)' : '(pode ser reativada)'}
                </p>
                <p className="mt-0.5 text-emerald-800/80 dark:text-emerald-300/80">{d.note}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatDateTimePt(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Santiago' });
}
