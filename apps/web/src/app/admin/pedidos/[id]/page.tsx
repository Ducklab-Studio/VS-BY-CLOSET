'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { adminApi } from '@/lib/admin-api';
import { formatPrice } from '@/lib/utils';
import { ORDER_STATUS, ORDER_STATUS_OPTIONS, formatDateTime } from '@/lib/admin-format';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Select,
  Table,
  Td,
  Textarea,
  Th,
} from '@/components/admin/ui';
import type { AdminOrderDetail } from '@/lib/admin-types';

export default function AdminOrderDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [order, setOrder] = useState<AdminOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    adminApi
      .get<AdminOrderDetail>(`/admin/orders/${id}`)
      .then(setOrder)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(load, [load]);

  async function updateStatus(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setNotice('');
    const form = new FormData(e.currentTarget);
    const payload: Record<string, unknown> = { status: form.get('status') };
    for (const key of ['note', 'trackingCode', 'shippingCarrier'] as const) {
      const value = form.get(key);
      if (value) payload[key] = value;
    }

    try {
      await adminApi.patch(`/admin/orders/${id}/status`, payload);
      setNotice('Status atualizado.');
      load();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState />;
  if (!order) return <ErrorState message={error || 'Pedido não encontrado.'} />;

  const address = order.shippingAddress;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link href="/admin/pedidos" className="text-white/50 hover:text-white">
            <ArrowLeft size={20} />
          </Link>
          <div>
            <h1 className="font-heading text-2xl text-white">Pedido #{order.number}</h1>
            <p className="mt-1 text-sm text-white/50">{formatDateTime(order.createdAt)}</p>
          </div>
        </div>
        <Badge tone={ORDER_STATUS[order.status]?.tone}>
          {ORDER_STATUS[order.status]?.label ?? order.status}
        </Badge>
      </div>

      {notice && (
        <div className="rounded-2xl border border-emerald-400/30 bg-emerald-400/10 p-4 text-sm text-emerald-300">
          {notice}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* Itens */}
          <Card>
            <CardTitle>Itens do pedido</CardTitle>
            <div className="mt-4">
              <Table>
                <thead>
                  <tr>
                    <Th>Produto</Th>
                    <Th>SKU</Th>
                    <Th className="text-right">Qtd</Th>
                    <Th className="text-right">Unit.</Th>
                    <Th className="text-right">Total</Th>
                  </tr>
                </thead>
                <tbody>
                  {order.items.map((item) => (
                    <tr key={item.id}>
                      <Td>
                        <p className="text-white">{item.productName}</p>
                        {item.variantName && (
                          <p className="text-xs text-white/40">{item.variantName}</p>
                        )}
                      </Td>
                      <Td className="text-white/50">{item.sku}</Td>
                      <Td className="text-right text-white/70">{item.quantity}</Td>
                      <Td className="text-right text-white/70">{formatPrice(item.unitPrice)}</Td>
                      <Td className="text-right text-white">{formatPrice(item.total)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>

            <div className="mt-4 space-y-1.5 border-t border-white/10 pt-4 text-sm">
              <Row label="Subtotal" value={formatPrice(order.subtotal)} />
              {Number(order.discountTotal) > 0 && (
                <Row
                  label={`Desconto${order.coupon ? ` (${order.coupon.code})` : ''}`}
                  value={`- ${formatPrice(order.discountTotal)}`}
                />
              )}
              <Row label="Frete" value={formatPrice(order.shippingTotal)} />
              <div className="flex justify-between border-t border-white/10 pt-2 text-base">
                <span className="text-white/60">Total</span>
                <span className="font-heading text-white">{formatPrice(order.total)}</span>
              </div>
            </div>
          </Card>

          {/* Histórico */}
          <Card>
            <CardTitle>Histórico de status</CardTitle>
            {order.statusHistory.length === 0 ? (
              <p className="mt-4 text-sm text-white/40">Nenhuma alteração registrada.</p>
            ) : (
              <ol className="mt-4 space-y-4">
                {order.statusHistory.map((h) => (
                  <li key={h.id} className="flex gap-3">
                    <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-white/40" />
                    <div>
                      <p className="text-sm text-white">
                        {ORDER_STATUS[h.status]?.label ?? h.status}
                      </p>
                      <p className="text-xs text-white/40">{formatDateTime(h.createdAt)}</p>
                      {h.note && <p className="mt-1 text-xs text-white/60">{h.note}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          {/* Atualizar status */}
          <Card>
            <CardTitle>Atualizar status</CardTitle>
            <form onSubmit={updateStatus} className="mt-4 space-y-4">
              <Field label="Novo status">
                <Select name="status" defaultValue={order.status}>
                  {ORDER_STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Transportadora">
                <Input name="shippingCarrier" defaultValue={order.shippingCarrier ?? ''} />
              </Field>
              <Field label="Código de rastreio">
                <Input name="trackingCode" defaultValue={order.trackingCode ?? ''} />
              </Field>
              <Field label="Observação">
                <Textarea name="note" rows={3} placeholder="Visível no histórico do pedido" />
              </Field>
              <Button type="submit" variant="solid" loading={saving} className="w-full justify-center">
                Salvar
              </Button>
            </form>
          </Card>

          {/* Cliente */}
          <Card>
            <CardTitle>Cliente</CardTitle>
            <div className="mt-4 space-y-1 text-sm">
              <Link href={`/admin/clientes/${order.user.id}`} className="text-white hover:underline">
                {order.user.name}
              </Link>
              <p className="text-white/50">{order.user.email}</p>
              {order.user.phone && <p className="text-white/50">{order.user.phone}</p>}
            </div>
          </Card>

          {/* Entrega */}
          <Card>
            <CardTitle>Entrega</CardTitle>
            {address ? (
              <div className="mt-4 space-y-1 text-sm text-white/70">
                <p className="text-white">{address.recipient}</p>
                <p>
                  {address.street}, {address.number}
                  {address.complement ? ` — ${address.complement}` : ''}
                </p>
                <p>
                  {address.district} · {address.city}/{address.state}
                </p>
                <p>CEP {address.zipCode}</p>
              </div>
            ) : (
              <p className="mt-4 text-sm text-white/40">Sem endereço cadastrado.</p>
            )}
            {order.trackingCode && (
              <p className="mt-3 text-sm text-white/60">
                Rastreio: <span className="text-white">{order.trackingCode}</span>
              </p>
            )}
          </Card>

          {/* Pagamento */}
          <Card>
            <CardTitle>Pagamento</CardTitle>
            {order.payments.length === 0 ? (
              <p className="mt-4 text-sm text-white/40">Nenhum pagamento registrado.</p>
            ) : (
              <div className="mt-4 space-y-3 text-sm">
                {order.payments.map((p) => (
                  <div key={p.id} className="border-b border-white/5 pb-3 last:border-0 last:pb-0">
                    <div className="flex items-center justify-between">
                      <span className="text-white">{p.provider}</span>
                      <Badge tone={p.status === 'PAID' ? 'success' : 'warning'}>{p.status}</Badge>
                    </div>
                    <p className="mt-1 text-white/50">
                      {formatPrice(p.amount)}
                      {p.installments > 1 ? ` em ${p.installments}x` : ''}
                    </p>
                    {p.paidAt && (
                      <p className="text-xs text-white/40">Pago em {formatDateTime(p.paidAt)}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-white/50">{label}</span>
      <span className="text-white/80">{value}</span>
    </div>
  );
}
