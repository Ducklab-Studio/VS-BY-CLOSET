import type { Metadata } from 'next';
import { ExternalLink } from 'lucide-react';
import { requireAdminSession } from '@/lib/admin-session';
import { listPieces } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { shopifyProductAdminUrl } from '@/lib/closetadmin-shopify';
import { EmptyState, ErrorState, PageHeader } from '@/components/closetadmin/ui';
import { PieceToggle } from './PieceToggle';

export const metadata: Metadata = { title: 'Peças' };

/**
 * Fase 9, item 11 — /closetadmin/pecas. Nome/preço/foto/descrição
 * continuam do Shopify (link "Abrir produto no Shopify" em vez de um
 * editor duplicado). Só campos operacionais são editáveis, e só por
 * ADMIN — STAFF vê tudo em modo leitura (o backend já recusaria a
 * escrita de qualquer forma).
 */
export default async function ClosetAdminPiecesPage() {
  const session = await requireAdminSession();
  const isAdmin = session.role === 'ADMIN';

  let pieces: Awaited<ReturnType<typeof listPieces>> | null = null;
  let errorMessage: string | null = null;
  try {
    pieces = await listPieces(session.id);
  } catch (err) {
    errorMessage = err instanceof AdminApiError ? err.message : 'Erro inesperado.';
  }

  if (!pieces) {
    return <ErrorState message={errorMessage ?? 'Erro inesperado.'} />;
  }

  {
    return (
      <div>
        <PageHeader title="Peças físicas" description={`${pieces.length} cadastradas`} />

        {pieces.length === 0 ? (
          <EmptyState title="Nenhuma peça cadastrada" />
        ) : (
          <>
            {/* Fase 10, item 9 — abaixo de md, a tabela de 9 colunas vira
                cartão empilhado: mesma informação, sem scroll horizontal
                apertado. PieceToggle duplicado (uma instância por
                layout) é seguro: só a visível por vez recebe clique,
                mesmo padrão de dual-render já usado em CategorySelect
                (mobile) vs. os pills de categoria (desktop). */}
            <div className="space-y-3 md:hidden">
              {pieces.map((piece) => {
                const productUrl = shopifyProductAdminUrl(piece.shopifyProductId);
                return (
                  <div key={piece.id} className="rounded-xl border border-ink/10 dark:border-white/10 bg-white dark:bg-dark-card p-4 shadow-sm transition-colors">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-mono text-xs text-ink/60 dark:text-dark-muted">{piece.code}</p>
                        <p className="mt-0.5 font-medium text-ink dark:text-dark-text">{piece.name}</p>
                        <p className="mt-0.5 font-mono text-xs text-ink/60 dark:text-dark-muted">SKU {piece.shopifySku ?? '—'}</p>
                      </div>
                      <span className={`shrink-0 inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${piece.currentlyOccupied ? 'bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 dark:border dark:border-amber-700/40' : 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 dark:border dark:border-emerald-700/40'}`}>
                        {piece.currentlyOccupied ? 'Ocupada' : 'Livre'}
                      </span>
                    </div>

                    <dl className="mt-3.5 grid grid-cols-3 gap-2 border-t border-ink/5 dark:border-white/5 pt-3.5 text-center">
                      <div>
                        <dt className="text-[10px] uppercase tracking-wide text-ink/65 dark:text-dark-subtle">Ativa</dt>
                        <dd className="mt-1.5 flex justify-center">{isAdmin ? <PieceToggle pieceId={piece.id} field="active" initialValue={piece.active} /> : <ReadOnlyDot value={piece.active} />}</dd>
                      </div>
                      <div>
                        <dt className="text-[10px] uppercase tracking-wide text-ink/65 dark:text-dark-subtle">Online</dt>
                        <dd className="mt-1.5 flex justify-center">{isAdmin ? <PieceToggle pieceId={piece.id} field="reservableOnline" initialValue={piece.reservableOnline} /> : <ReadOnlyDot value={piece.reservableOnline} />}</dd>
                      </div>
                      <div>
                        <dt className="text-[10px] uppercase tracking-wide text-ink/65 dark:text-dark-subtle">Na duração</dt>
                        <dd className="mt-1.5 flex justify-center">{isAdmin ? <PieceToggle pieceId={piece.id} field="countsTowardRentalDuration" initialValue={piece.countsTowardRentalDuration} /> : <ReadOnlyDot value={piece.countsTowardRentalDuration} />}</dd>
                      </div>
                    </dl>

                    <div className="mt-3.5 flex items-center justify-between border-t border-ink/5 dark:border-white/5 pt-3 text-xs text-ink/70 dark:text-dark-muted">
                      <span>{piece.upcomingReservations} próxima(s) reserva(s)</span>
                      {productUrl ? (
                        <a href={productUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-medium text-marsala dark:text-gold hover:underline">
                          Shopify <ExternalLink size={12} />
                        </a>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="hidden overflow-x-auto rounded-xl border border-ink/10 dark:border-white/10 bg-white dark:bg-dark-card shadow-sm transition-colors md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink/10 dark:border-white/10 text-left text-xs uppercase tracking-wide text-ink/65 dark:text-dark-subtle bg-neutral-50/50 dark:bg-white/[0.02]">
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
                    <tr key={piece.id} className="hover:bg-ink/5 dark:hover:bg-white/5 transition">
                      <td className="px-4 py-3 font-medium text-ink dark:text-dark-text font-mono text-xs">{piece.code}</td>
                      <td className="px-4 py-3 text-ink/80 dark:text-dark-text">{piece.name}</td>
                      <td className="px-4 py-3 text-ink/50 dark:text-dark-muted font-mono text-xs">{piece.shopifySku ?? '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${piece.currentlyOccupied ? 'bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 dark:border dark:border-amber-700/40' : 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 dark:border dark:border-emerald-700/40'}`}>
                          {piece.currentlyOccupied ? 'Ocupada' : 'Livre'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {isAdmin ? <PieceToggle pieceId={piece.id} field="active" initialValue={piece.active} /> : <ReadOnlyDot value={piece.active} />}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {isAdmin ? (
                          <PieceToggle pieceId={piece.id} field="reservableOnline" initialValue={piece.reservableOnline} />
                        ) : (
                          <ReadOnlyDot value={piece.reservableOnline} />
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {isAdmin ? (
                          <PieceToggle pieceId={piece.id} field="countsTowardRentalDuration" initialValue={piece.countsTowardRentalDuration} />
                        ) : (
                          <ReadOnlyDot value={piece.countsTowardRentalDuration} />
                        )}
                      </td>
                      <td className="px-4 py-3 text-ink/60 dark:text-dark-muted">{piece.upcomingReservations}</td>
                      <td className="px-4 py-3">
                        {productUrl ? (
                          <a href={productUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs font-medium text-marsala dark:text-gold hover:underline">
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
      </div>
    );
  }
}

function ReadOnlyDot({ value }: { value: boolean }) {
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${value ? 'bg-marsala dark:bg-gold' : 'bg-ink/15 dark:bg-white/15'}`} />;
}
