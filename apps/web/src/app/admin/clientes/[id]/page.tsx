'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { adminApi } from '@/lib/admin-api';
import { formatPrice } from '@/lib/utils';
import { getUser } from '@/lib/auth';
import {
  ORDER_STATUS,
  USER_ROLE,
  USER_STATUS,
  formatDate,
  formatDateTime,
} from '@/lib/admin-format';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  ErrorState,
  Field,
  LoadingState,
  Select,
  Table,
  Td,
  Th,
} from '@/components/admin/ui';
import type { AdminUserDetail } from '@/lib/admin-types';

export default function AdminCustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [user, setUser] = useState<AdminUserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  const canManage = getUser()?.role === 'ADMIN';

  const load = useCallback(() => {
    adminApi
      .get<AdminUserDetail>(`/admin/users/${id}`)
      .then(setUser)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(load, [load]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setNotice('');
    const form = new FormData(e.currentTarget);
    try {
      await adminApi.patch(`/admin/users/${id}`, {
        role: form.get('role'),
        status: form.get('status'),
      });
      setNotice('Usuário atualizado.');
      load();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState />;
  if (!user) return <ErrorState message={error || 'Usuário não encontrado.'} />;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/admin/clientes" className="text-white/50 hover:text-white">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <h1 className="font-heading text-2xl text-white">{user.name}</h1>
          <p className="mt-1 text-sm text-white/50">{user.email}</p>
        </div>
      </div>

      {notice && (
        <div className="rounded-2xl border border-emerald-400/30 bg-emerald-400/10 p-4 text-sm text-emerald-300">
          {notice}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardTitle>Pedidos recentes</CardTitle>
            {user.orders.length === 0 ? (
              <p className="mt-4 text-sm text-white/40">Este cliente ainda não fez pedidos.</p>
            ) : (
              <div className="mt-4">
                <Table>
                  <thead>
                    <tr>
                      <Th>Pedido</Th>
                      <Th>Status</Th>
                      <Th>Data</Th>
                      <Th className="text-right">Total</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {user.orders.map((o) => (
                      <tr key={o.id}>
                        <Td>
                          <Link href={`/admin/pedidos/${o.id}`} className="text-white hover:underline">
                            #{o.number}
                          </Link>
                        </Td>
                        <Td>
                          <Badge tone={ORDER_STATUS[o.status]?.tone}>
                            {ORDER_STATUS[o.status]?.label ?? o.status}
                          </Badge>
                        </Td>
                        <Td className="text-white/50">{formatDate(o.createdAt)}</Td>
                        <Td className="text-right text-white">{formatPrice(o.total)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
          </Card>

          <Card>
            <CardTitle>Endereços</CardTitle>
            {user.addresses.length === 0 ? (
              <p className="mt-4 text-sm text-white/40">Nenhum endereço cadastrado.</p>
            ) : (
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                {user.addresses.map((a) => (
                  <div key={a.id} className="rounded-xl border border-white/10 p-4 text-sm text-white/70">
                    <p className="text-white">{a.recipient}</p>
                    <p>
                      {a.street}, {a.number}
                      {a.complement ? ` — ${a.complement}` : ''}
                    </p>
                    <p>
                      {a.district} · {a.city}/{a.state}
                    </p>
                    <p>CEP {a.zipCode}</p>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardTitle>Dados</CardTitle>
            <dl className="mt-4 space-y-3 text-sm">
              <Info label="Papel">
                <Badge tone={USER_ROLE[user.role]?.tone}>
                  {USER_ROLE[user.role]?.label ?? user.role}
                </Badge>
              </Info>
              <Info label="Status">
                <Badge tone={USER_STATUS[user.status]?.tone}>
                  {USER_STATUS[user.status]?.label ?? user.status}
                </Badge>
              </Info>
              <Info label="Telefone">
                <span className="text-white/70">{user.phone ?? '—'}</span>
              </Info>
              <Info label="CPF">
                <span className="text-white/70">{user.cpf ?? '—'}</span>
              </Info>
              <Info label="Cadastro">
                <span className="text-white/70">{formatDate(user.createdAt)}</span>
              </Info>
              <Info label="Último acesso">
                <span className="text-white/70">{formatDateTime(user.lastLoginAt)}</span>
              </Info>
            </dl>
          </Card>

          {canManage && (
            <Card>
              <CardTitle>Permissões</CardTitle>
              <form onSubmit={onSubmit} className="mt-4 space-y-4">
                <Field label="Papel">
                  <Select name="role" defaultValue={user.role}>
                    <option value="CUSTOMER">Cliente</option>
                    <option value="SUPPORT">Atendente</option>
                    <option value="MANAGER">Gerente</option>
                    <option value="ADMIN">Administrador</option>
                  </Select>
                </Field>
                <Field label="Status">
                  <Select name="status" defaultValue={user.status}>
                    <option value="ACTIVE">Ativo</option>
                    <option value="BLOCKED">Bloqueado</option>
                    <option value="PENDING_VERIFICATION">Pendente</option>
                  </Select>
                </Field>
                <Button type="submit" variant="solid" loading={saving} className="w-full justify-center">
                  Salvar
                </Button>
              </form>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-[11px] uppercase tracking-widest text-white/40">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
