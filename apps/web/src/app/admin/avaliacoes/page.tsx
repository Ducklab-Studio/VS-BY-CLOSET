'use client';

import { useCallback, useEffect, useState } from 'react';
import { Star, Check, X } from 'lucide-react';
import { adminApi } from '@/lib/admin-api';
import { REVIEW_STATUS, formatDateTime } from '@/lib/admin-format';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Pagination,
  Select,
  Textarea,
} from '@/components/admin/ui';
import type { AdminReview, Paginated } from '@/lib/admin-types';

export default function AdminReviewsPage() {
  const [data, setData] = useState<Paginated<AdminReview> | null>(null);
  const [status, setStatus] = useState('PENDING');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [replying, setReplying] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    adminApi
      .get<Paginated<AdminReview>>('/admin/reviews', { status, page, limit: 20 })
      .then(setData)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [status, page]);

  useEffect(load, [load]);

  async function moderate(review: AdminReview, newStatus: string, storeReply?: string) {
    try {
      await adminApi.patch(`/admin/reviews/${review.id}`, {
        status: newStatus,
        ...(storeReply !== undefined && { storeReply }),
      });
      setReplying(null);
      setReplyText('');
      load();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl text-white">Avaliações</h1>
          <p className="mt-1 text-sm text-white/50">
            {data ? `${data.pagination.total} avaliação(ões)` : 'Carregando...'}
          </p>
        </div>
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          className="w-52"
        >
          <option value="">Todas</option>
          <option value="PENDING">Pendentes</option>
          <option value="APPROVED">Aprovadas</option>
          <option value="REJECTED">Rejeitadas</option>
        </Select>
      </div>

      {error ? (
        <ErrorState message={error} />
      ) : loading ? (
        <LoadingState />
      ) : !data || data.items.length === 0 ? (
        <EmptyState message="Nenhuma avaliação encontrada." />
      ) : (
        <>
          <div className="space-y-4">
            {data.items.map((r) => (
              <Card key={r.id}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex gap-0.5">
                        {Array.from({ length: 5 }, (_, i) => (
                          <Star
                            key={i}
                            size={14}
                            className={i < r.rating ? 'fill-white text-white' : 'text-white/20'}
                          />
                        ))}
                      </div>
                      <Badge tone={REVIEW_STATUS[r.status]?.tone}>
                        {REVIEW_STATUS[r.status]?.label ?? r.status}
                      </Badge>
                      <span className="text-xs text-white/40">{formatDateTime(r.createdAt)}</span>
                    </div>

                    <p className="mt-2 text-sm text-white/50">
                      {r.product.name} · por {r.user.name}
                    </p>

                    {r.title && <p className="mt-3 font-medium text-white">{r.title}</p>}
                    {r.comment && (
                      <p className="mt-1 whitespace-pre-line text-sm text-white/70">{r.comment}</p>
                    )}

                    {r.storeReply && (
                      <div className="mt-3 rounded-lg border-l-2 border-white/30 bg-white/5 p-3">
                        <p className="text-[11px] uppercase tracking-widest text-white/40">
                          Resposta da loja
                        </p>
                        <p className="mt-1 text-sm text-white/70">{r.storeReply}</p>
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-wrap gap-2">
                    {r.status !== 'APPROVED' && (
                      <Button onClick={() => moderate(r, 'APPROVED')}>
                        <Check size={14} /> Aprovar
                      </Button>
                    )}
                    {r.status !== 'REJECTED' && (
                      <Button variant="danger" onClick={() => moderate(r, 'REJECTED')}>
                        <X size={14} /> Rejeitar
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setReplying(replying === r.id ? null : r.id);
                        setReplyText(r.storeReply ?? '');
                      }}
                    >
                      Responder
                    </Button>
                  </div>
                </div>

                {replying === r.id && (
                  <div className="mt-4 space-y-3 border-t border-white/10 pt-4">
                    <Textarea
                      rows={3}
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      placeholder="Escreva a resposta pública da loja..."
                    />
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" onClick={() => setReplying(null)}>
                        Cancelar
                      </Button>
                      <Button variant="solid" onClick={() => moderate(r, r.status, replyText)}>
                        Salvar resposta
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            ))}
          </div>

          <Pagination page={page} totalPages={data.pagination.totalPages} onChange={setPage} />
        </>
      )}
    </div>
  );
}
