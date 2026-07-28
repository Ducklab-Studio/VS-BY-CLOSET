'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { adminApi } from '@/lib/admin-api';
import { USER_ROLE, USER_STATUS, formatDate, formatDateTime } from '@/lib/admin-format';
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
import type { AdminUserListItem, Paginated } from '@/lib/admin-types';

export default function AdminCustomersPage() {
  const [data, setData] = useState<Paginated<AdminUserListItem> | null>(null);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    adminApi
      .get<Paginated<AdminUserListItem>>('/admin/users', { search, role, status, page, limit: 20 })
      .then(setData)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [search, role, status, page]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl text-white">Clientes</h1>
        <p className="mt-1 text-sm text-white/50">
          {data ? `${data.pagination.total} usuário(s)` : 'Carregando...'}
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/40"
          />
          <Input
            placeholder="Buscar por nome ou e-mail..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-9"
          />
        </div>
        <Select
          value={role}
          onChange={(e) => {
            setRole(e.target.value);
            setPage(1);
          }}
          className="w-48"
        >
          <option value="">Todos os papéis</option>
          <option value="CUSTOMER">Cliente</option>
          <option value="SUPPORT">Atendente</option>
          <option value="MANAGER">Gerente</option>
          <option value="ADMIN">Administrador</option>
        </Select>
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
          <option value="BLOCKED">Bloqueado</option>
          <option value="PENDING_VERIFICATION">Pendente</option>
        </Select>
      </div>

      {error ? (
        <ErrorState message={error} />
      ) : loading ? (
        <LoadingState />
      ) : !data || data.items.length === 0 ? (
        <EmptyState message="Nenhum cliente encontrado." />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Cliente</Th>
                <Th>Papel</Th>
                <Th>Status</Th>
                <Th className="text-right">Pedidos</Th>
                <Th>Cadastro</Th>
                <Th>Último acesso</Th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((u) => (
                <tr key={u.id}>
                  <Td>
                    <Link href={`/admin/clientes/${u.id}`} className="text-white hover:underline">
                      {u.name}
                    </Link>
                    <p className="text-xs text-white/40">{u.email}</p>
                  </Td>
                  <Td>
                    <Badge tone={USER_ROLE[u.role]?.tone}>{USER_ROLE[u.role]?.label ?? u.role}</Badge>
                  </Td>
                  <Td>
                    <Badge tone={USER_STATUS[u.status]?.tone}>
                      {USER_STATUS[u.status]?.label ?? u.status}
                    </Badge>
                  </Td>
                  <Td className="text-right text-white/70">{u._count.orders}</Td>
                  <Td className="text-white/50">{formatDate(u.createdAt)}</Td>
                  <Td className="text-white/50">{formatDateTime(u.lastLoginAt)}</Td>
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
