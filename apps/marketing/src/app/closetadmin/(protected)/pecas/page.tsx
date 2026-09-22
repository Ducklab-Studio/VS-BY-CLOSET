import type { Metadata } from 'next';
import { ExternalLink } from 'lucide-react';
import { hasAdminRole, requireAdminModule, requireAdminSession } from '@/lib/admin-session';
import { listPieces } from '@/lib/admin-data';
import { listShopifyCatalog, getCatalogReconciliation } from '@/lib/shopify-admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { shopifyProductAdminUrl } from '@/lib/closetadmin-shopify';
import { EmptyState, ErrorState, PageHeader } from '@/components/closetadmin/ui';
import { PieceToggle } from './PieceToggle';
import { PieceActiveToggle } from './PieceActiveToggle';
import { ShopifyCatalog } from './ShopifyCatalog';
import { CatalogSyncPanel } from './CatalogSyncPanel';
import type { PieceListItem } from '@/lib/admin-data';

export const metadata: Metadata = { title: 'Peças' };

/**
 * Shopify é fonte comercial; Postgres é fonte operacional das peças físicas.
 * A seção de catálogo lê a Admin API e permite ao ADMIN criar RentalUnits
 * explícitas. Nunca converte inventoryQuantity automaticamente em peças.
 */
export default async function ClosetAdminPiecesPage() {
  const session = await requireAdminSession();
  requireAdminModule(session, 'PIECES');
  const isAdmin = hasAdminRole(session, 'ADMIN');

  let pieces: Awaited<ReturnType<typeof listPieces>> | null = null;
  let piecesError: string | null = null;
  try {
    pieces = await listPieces(session.id);
  } catch (err) {
    piecesError = err instanceof AdminApiError ? err.message : 'Erro inesperado.';
  }

  if (!pieces) {
    return <ErrorState message={piecesError ?? 'Erro inesperado.'} />;
  }

  let catalog: Awaited<ReturnType<typeof listShopifyCatalog>> | null = null;
  let catalogError: string | null = null;
  try {
    catalog = await listShopifyCatalog(session.id);
  } catch (err) {
    catalogError = err instanceof AdminApiError ? err.message : 'Não foi possível consultar a Shopify.';
  }

  // Item 11/12 — relatório somente-leitura de divergências peça × variante
  // Shopify, e "última sincronização". Indisponível não impede o resto da
  // página (mesmo tratamento de erro do catálogo acima).
  let syncReport: Awaited<ReturnType<typeof getCatalogReconciliation>> | null = null;
  try {
    syncReport = await getCatalogReconciliation(session.id);
  } catch {
    syncReport = null;
  }

  return (
    <div>
      <PageHeader title="Peças" description={`${pieces.length} peça(s) física(s) cadastrada(s)`} />

      {syncReport ? <CatalogSyncPanel initialReport={syncReport} isAdmin={isAdmin} /> : null}

      <section className="mb-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-ink dark:text-dark-text">Catálogo Shopify</h2>
            <p className="mt-0.5 text-sm text-ink/55 dark:text-dark-muted">
              Produtos e variantes vêm da Shopify; aqui você só vincula as peças físicas do aluguel.
            </p>
          </div>
          {catalog ? (
            <span className="text-xs text-ink/45 dark:text-dark-subtle">{catalog.length} variante(s)</span>
          ) : null}
        </div>

        {catalog ? (
          <ShopifyCatalog items={catalog} isAdmin={isAdmin} />
        ) : (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-200">
            {catalogError ?? 'Integração Shopify indisponível.'}
          </div>
        )}
      </section>

      <section>
        <div className="mb-3">
          <h2 className="text-base font-semibold text-ink dark:text-dark-text">Peças físicas</h2>
          <p className="mt-0.5 text-sm text-ink/55 dark:text-dark-muted">
            Unidades individuais que entram na disponibilidade, calendário e reservas.
          </p>
        </div>

        {pieces.length === 0 ? (
          <EmptyState title="Nenhuma peça física cadastrada" description="Cadastre as unidades pelo catálogo Shopify acima." />
        ) : (
          <>
            <div className="space-y-3 md:hidden">
              {pieces.map((piece) => {
                const productUrl = shopifyProductAdminUrl(piece.shopifyProductId);
                return (
                  <div key={piece.id} className="rounded-xl border border-ink/10 bg-white p-4 shadow-sm transition-colors dark:border-white/10 dark:bg-dark-card">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-mono text-xs text-ink/60 dark:text-dark-muted">{piece.code}</p>
                        <p className="mt-0.5 font-medium text-ink dark:text-dark-text">{piece.name}</p>
                        <p className="mt-0.5 font-mono text-xs text-ink/60 dark:text-dark-muted">
                          {isSkuUnlinked(piece) ? <SkuUnlinkedLabel /> : <>SKU {piece.shopifySku ?? '—'}</>}
                        </p>
                      </div>
                      <StatusBadge piece={piece} />
                    </div>
                    {piece.shopifyVariantMissingAt ? <MissingVariantBadge /> : null}

                    <dl className="mt-3.5 grid grid-cols-3 gap-2 border-t border-ink/5 pt-3.5 text-center dark:border-white/5">
                      <div>
                        <dt className="text-[10px] uppercase tracking-wide text-ink/65 dark:text-dark-subtle">Ativa</dt>
                        <dd className="mt-1.5 flex justify-center">
                          {isAdmin ? (
                            <PieceActiveToggle pieceId={piece.id} pieceName={piece.name} initialValue={piece.active} missingVariantReason={!!piece.shopifyVariantMissingAt} />
                          ) : (
                            <ReadOnlyDot value={piece.active} />
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[10px] uppercase tracking-wide text-ink/65 dark:text-dark-subtle">Online</dt>
                        <dd className="mt-1.5 flex justify-center">
                          {isAdmin ? (
                            <PieceToggle pieceId={piece.id} field="reservableOnline" initialValue={piece.reservableOnline} disabled={!piece.active} disabledTitle="Peça desativada — reative para editar." />
                          ) : (
                            <ReadOnlyDot value={piece.reservableOnline} />
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[10px] uppercase tracking-wide text-ink/65 dark:text-dark-subtle">Na duração</dt>
                        <dd className="mt-1.5 flex justify-center">
                          {isAdmin ? (
                            <PieceToggle
                              pieceId={piece.id}
                              field="countsTowardRentalDuration"
                              initialValue={piece.countsTowardRentalDuration}
                              disabled={!piece.active}
                              disabledTitle="Peça desativada — reative para editar."
                            />
                          ) : (
                            <ReadOnlyDot value={piece.countsTowardRentalDuration} />
                          )}
                        </dd>
                      </div>
                    </dl>

                    <div className="mt-3.5 flex items-center justify-between border-t border-ink/5 pt-3 text-xs text-ink/70 dark:border-white/5 dark:text-dark-muted">
                      <span>{piece.upcomingReservations} próxima(s) reserva(s)</span>
                      {productUrl ? (
                        <a href={productUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-medium text-marsala hover:underline dark:text-gold">
                          Shopify <ExternalLink size={12} />
                        </a>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="hidden overflow-x-auto rounded-xl border border-ink/10 bg-white shadow-sm transition-colors dark:border-white/10 dark:bg-dark-card md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink/10 bg-neutral-50/50 text-left text-xs uppercase tracking-wide text-ink/65 dark:border-white/10 dark:bg-white/[0.02] dark:text-dark-subtle">
                    <th className="px-4 py-3 font-medium">Código</th>
                    <th className="px-4 py-3 font-medium">Nome</th>
                    <th className="px-4 py-3 font-medium">SKU</th>
                    <th className="px-4 py-3 font-medium">Situação</th>
                    <th className="px-4 py-3 text-center font-medium">Ativa</th>
                    <th className="px-4 py-3 text-center font-medium">Reservável online</th>
                    <th className="px-4 py-3 text-center font-medium">Conta na duração</th>
                    <th className="px-4 py-3 font-medium">Próximas reservas</th>
                    <th className="px-4 py-3 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink/5 dark:divide-white/5">
                  {pieces.map((piece) => {
                    const productUrl = shopifyProductAdminUrl(piece.shopifyProductId);
                    return (
                      <tr key={piece.id} className="transition hover:bg-ink/5 dark:hover:bg-white/5">
                        <td className="px-4 py-3 font-mono text-xs font-medium text-ink dark:text-dark-text">{piece.code}</td>
                        <td className="px-4 py-3 text-ink/80 dark:text-dark-text">
                          {piece.name}
                          {piece.shopifyVariantMissingAt ? <MissingVariantBadge /> : null}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-ink/50 dark:text-dark-muted">
                          {isSkuUnlinked(piece) ? <SkuUnlinkedLabel /> : (piece.shopifySku ?? '—')}
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge piece={piece} />
                        </td>
                        <td className="px-4 py-3 text-center">
                          {isAdmin ? (
                            <PieceActiveToggle pieceId={piece.id} pieceName={piece.name} initialValue={piece.active} missingVariantReason={!!piece.shopifyVariantMissingAt} />
                          ) : (
                            <ReadOnlyDot value={piece.active} />
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {isAdmin ? (
                            <PieceToggle pieceId={piece.id} field="reservableOnline" initialValue={piece.reservableOnline} disabled={!piece.active} disabledTitle="Peça desativada — reative para editar." />
                          ) : (
                            <ReadOnlyDot value={piece.reservableOnline} />
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {isAdmin ? (
                            <PieceToggle
                              pieceId={piece.id}
                              field="countsTowardRentalDuration"
                              initialValue={piece.countsTowardRentalDuration}
                              disabled={!piece.active}
                              disabledTitle="Peça desativada — reative para editar."
                            />
                          ) : (
                            <ReadOnlyDot value={piece.countsTowardRentalDuration} />
                          )}
                        </td>
                        <td className="px-4 py-3 text-ink/60 dark:text-dark-muted">{piece.upcomingReservations}</td>
                        <td className="px-4 py-3">
                          {productUrl ? (
                            <a href={productUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs font-medium text-marsala hover:underline dark:text-gold">
                              Shopify <ExternalLink size={12} />
                            </a>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function ReadOnlyDot({ value }: { value: boolean }) {
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${value ? 'bg-marsala dark:bg-gold' : 'bg-ink/15 dark:bg-white/15'}`} />;
}

/**
 * SKU "desvinculado": active=false + variante Shopify ausente
 * (shopifyVariantMissingAt) — o mesmo par de condições do badge "Desativada".
 * O SKU antigo continua gravado em rental_units.shopify_sku (histórico,
 * reativação), só não é mostrado como se ainda fosse válido. Peça
 * desativada por outro motivo, com o vínculo Shopify intacto, continua
 * mostrando o SKU real normalmente.
 */
function isSkuUnlinked(piece: PieceListItem): boolean {
  return !piece.active && !!piece.shopifyVariantMissingAt;
}

function SkuUnlinkedLabel() {
  return <span className="italic text-ink/40 dark:text-dark-subtle">SKU desvinculado</span>;
}

/**
 * Situação da peça — "Livre" só existe quando ATIVA e sem reserva agora.
 * Peça desativada (por sincronização ou decisão manual) nunca mostra
 * "Livre"/"Ocupada": esses dois estados descrevem disponibilidade
 * OPERACIONAL de uma peça que ainda está no catálogo, não uma peça fora
 * dele. Corrige o bug relatado: peça 02 com active=false aparecia como
 * "Livre" porque o badge só olhava `currentlyOccupied`, nunca `active`.
 */
function StatusBadge({ piece }: { piece: PieceListItem }) {
  if (!piece.active) {
    return (
      <span className="inline-flex shrink-0 rounded-full bg-red-100 px-2.5 py-1 text-xs font-medium text-red-800 dark:border dark:border-red-700/40 dark:bg-red-950/60 dark:text-red-300">
        Desativada
      </span>
    );
  }
  return (
    <span
      className={`inline-flex shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
        piece.currentlyOccupied
          ? 'bg-amber-100 text-amber-800 dark:border dark:border-amber-700/40 dark:bg-amber-950/60 dark:text-amber-300'
          : 'bg-emerald-100 text-emerald-800 dark:border dark:border-emerald-700/40 dark:bg-emerald-950/60 dark:text-emerald-300'
      }`}
    >
      {piece.currentlyOccupied ? 'Ocupada' : 'Livre'}
    </span>
  );
}

/** Motivo da inativação (item 12) — só aparece quando foi a SINCRONIZAÇÃO
 *  que desativou a peça, nunca uma decisão manual (ver shopifyVariantMissingAt). */
function MissingVariantBadge() {
  return (
    <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:border dark:border-amber-700/40 dark:bg-amber-950/60 dark:text-amber-300">
      Inativa — variante removida da Shopify
    </span>
  );
}
