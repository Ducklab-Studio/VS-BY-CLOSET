'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { adminApi } from '@/lib/admin-api';
import { formatPrice } from '@/lib/utils';
import { ORDER_STATUS, ORDER_STATUS_OPTIONS, formatDateTime } from '@/lib/admin-format';
import {
  Badge,
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
import type { AdminOrderListItem, Paginated } from '@/lib/admin-types';

export default function AdminOrdersPage() {
  const [data, setData] = useState<Paginated<AdminOrderListItem> | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    adminApi
      .get<Paginated<AdminOrderListItem>>('/admin/orders', { search, status, page, limit: 20 })
      .then(setData)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [search, status, page]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl text-white">Pedidos</h1>
        <p className="mt-1 text-sm text-white/50">
          {data ? `${data.pagination.total} pedido(s)` : 'Carregando...'}
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/40"
          />
          <Input
            placeholder="Buscar por número, cliente ou e-mail..."
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
          className="w-56"
        >
          <option value="">Todos os status</option>
          {ORDER_STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>

      {error ? (
        <ErrorState message={error} />
      ) : loading ? (
        <LoadingState />
      ) : !data || data.items.length === 0 ? (
        <EmptyState message="Nenhum pedido encontrado." />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Pedido</Th>
                <Th>Cliente</Th>
                <Th>Status</Th>
                <Th className="text-right">Itens</Th>
                <Th>Data</Th>
                <Th className="text-right">Total</Th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((o) => (
                <tr key={o.id}>
                  <Td>
                    <Link href={`/admin/pedidos/${o.id}`} className="text-white hover:underline">
                      #{o.number}
                    </Link>
                  </Td>
                  <Td>
                    <p className="text-white">{o.user.name}</p>
                    <p className="text-xs text-white/40">{o.user.email}</p>
                  </Td>
                  <Td>
                    <Badge tone={ORDER_STATUS[o.status]?.tone}>
                      {ORDER_STATUS[o.status]?.label ?? o.status}
                    </Badge>
                  </Td>
                  <Td className="text-right text-white/70">{o._count.items}</Td>
                  <Td className="text-white/50">{formatDateTime(o.createdAt)}</Td>
                  <Td className="text-right text-white">{formatPrice(o.total)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <Pagination page={page} totalPages={data.pagination.totalPages} onChange={setPage} />
        </>
      )}
    </div>
  );
}
