'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Plus, Search, Trash2, Pencil } from 'lucide-react';
import { adminApi } from '@/lib/admin-api';
import { formatPrice } from '@/lib/utils';
import { PRODUCT_STATUS, formatDate } from '@/lib/admin-format';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Pagination,
  Select,
  Table,
  Td,
  Th,
} from '@/components/admin/ui';
import type { AdminProduct, Paginated } from '@/lib/admin-types';

export default function AdminProductsPage() {
  const [data, setData] = useState<Paginated<AdminProduct> | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    adminApi
      .get<Paginated<AdminProduct>>('/admin/products', { search, status, page, limit: 20 })
      .then(setData)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [search, status, page]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  async function handleDelete(product: AdminProduct) {
    if (!confirm(`Excluir o produto "${product.name}"? Esta ação não pode ser desfeita.`)) return;
    try {
      await adminApi.delete(`/admin/products/${product.id}`);
      load();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  function totalStock(product: AdminProduct) {
    return product.variants.reduce((sum, v) => sum + (v.inventory?.quantity ?? 0), 0);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl text-white">Produtos</h1>
          <p className="mt-1 text-sm text-white/50">
            {data ? `${data.pagination.total} produto(s) cadastrado(s)` : 'Carregando...'}
          </p>
        </div>
        <Link href="/admin/produtos/novo">
          <Button variant="solid">
            <Plus size={14} /> Novo produto
          </Button>
        </Link>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/40"
          />
          <Input
            placeholder="Buscar por nome ou SKU..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-9"
          />
        </div>
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          className="w-48"
        >
          <option value="">Todos os status</option>
          <option value="ACTIVE">Ativo</option>
          <option value="DRAFT">Rascunho</option>
          <option value="ARCHIVED">Arquivado</option>
        </Select>
      </div>

      {error ? (
        <ErrorState message={error} />
      ) : loading ? (
        <LoadingState />
      ) : !data || data.items.length === 0 ? (
        <EmptyState message="Nenhum produto encontrado. Cadastre o primeiro produto." />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Produto</Th>
                <Th>SKU</Th>
                <Th>Status</Th>
                <Th className="text-right">Preço</Th>
                <Th className="text-right">Estoque</Th>
                <Th>Criado</Th>
                <Th className="text-right">Ações</Th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => {
                const stock = totalStock(p);
                const meta = PRODUCT_STATUS[p.status];
                return (
                  <tr key={p.id}>
                    <Td>
                      <div className="flex items-center gap-3">
                        {p.media[0] ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={p.media[0].url}
                            alt={p.name}
                            className="h-10 w-10 rounded-lg object-cover"
                          />
                        ) : (
                          <div className="h-10 w-10 rounded-lg bg-white/5" />
                        )}
                        <div className="min-w-0">
                          <p className="truncate text-white">{p.name}</p>
                          <p className="text-xs text-white/40">
                            {p.variants.length} variação(ões)
                          </p>
                        </div>
                      </div>
                    </Td>
                    <Td className="text-white/50">{p.sku}</Td>
                    <Td>
                      <Badge tone={meta?.tone}>{meta?.label ?? p.status}</Badge>
                    </Td>
                    <Td className="text-right">
                      {p.promoPrice ? (
                        <div>
                          <p className="text-white">{formatPrice(p.promoPrice)}</p>
                          <p className="text-xs text-white/40 line-through">{formatPrice(p.price)}</p>
                        </div>
                      ) : (
                        <span className="text-white">{formatPrice(p.price)}</span>
                      )}
                    </Td>
                    <Td className="text-right">
                      <Badge tone={stock === 0 ? 'danger' : stock < 5 ? 'warning' : 'neutral'}>
                        {stock}
                      </Badge>
                    </Td>
                    <Td className="text-white/50">{formatDate(p.createdAt)}</Td>
                    <Td>
                      <div className="flex justify-end gap-2">
                        <Link href={`/admin/produtos/${p.id}`}>
                          <Button variant="ghost" className="px-3 py-1.5">
                            <Pencil size={14} />
                          </Button>
                        </Link>
                        <Button
                          variant="ghost"
                          className="px-3 py-1.5 text-red-300"
                          onClick={() => handleDelete(p)}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>

          <Pagination page={page} totalPages={data.pagination.totalPages} onChange={setPage} />
        </>
      )}
    </div>
  );
}
