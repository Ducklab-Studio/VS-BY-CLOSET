'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Pencil } from 'lucide-react';
import { adminApi } from '@/lib/admin-api';
import { formatPrice } from '@/lib/utils';
import { COUPON_TYPE, formatDate } from '@/lib/admin-format';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Modal,
  Select,
  Table,
  Td,
  Textarea,
  Th,
} from '@/components/admin/ui';
import type { AdminCoupon } from '@/lib/admin-types';

const dateInput = (value: string | null) => (value ? value.slice(0, 10) : '');

export default function AdminCouponsPage() {
  const [items, setItems] = useState<AdminCoupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<AdminCoupon | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    adminApi
      .get<AdminCoupon[]>('/admin/coupons')
      .then(setItems)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const payload: Record<string, unknown> = {
      code: form.get('code'),
      type: form.get('type'),
      value: Number(form.get('value')),
      maxUsesPerUser: Number(form.get('maxUsesPerUser')) || 1,
      isActive: form.get('isActive') === 'on',
    };
    const description = form.get('description');
    if (description) payload.description = description;
    for (const key of ['minOrderValue', 'maxUses'] as const) {
      const value = form.get(key);
      if (value) payload[key] = Number(value);
    }
    for (const key of ['startsAt', 'expiresAt'] as const) {
      const value = form.get(key);
      if (value) payload[key] = new Date(`${value}T00:00:00`).toISOString();
    }

    try {
      if (editing) await adminApi.patch(`/admin/coupons/${editing.id}`, payload);
      else await adminApi.post('/admin/coupons', payload);
      setModalOpen(false);
      load();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function handleDelete(coupon: AdminCoupon) {
    if (!confirm(`Excluir o cupom "${coupon.code}"?`)) return;
    try {
      await adminApi.delete(`/admin/coupons/${coupon.id}`);
      load();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  function couponValue(c: AdminCoupon) {
    if (c.type === 'PERCENTAGE') return `${Number(c.value)}%`;
    if (c.type === 'FREE_SHIPPING') return 'Frete grátis';
    return formatPrice(c.value);
  }

  function isExpired(c: AdminCoupon) {
    return !!c.expiresAt && new Date(c.expiresAt) < new Date();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl text-white">Cupons</h1>
          <p className="mt-1 text-sm text-white/50">{items.length} cupom(ns)</p>
        </div>
        <Button
          variant="solid"
          onClick={() => {
            setEditing(null);
            setModalOpen(true);
          }}
        >
          <Plus size={14} /> Novo cupom
        </Button>
      </div>

      {error ? (
        <ErrorState message={error} />
      ) : loading ? (
        <LoadingState />
      ) : items.length === 0 ? (
        <EmptyState message="Nenhum cupom cadastrado." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Código</Th>
              <Th>Tipo</Th>
              <Th className="text-right">Valor</Th>
              <Th className="text-right">Usos</Th>
              <Th>Validade</Th>
              <Th>Status</Th>
              <Th className="text-right">Ações</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <Td>
                  <p className="font-mono text-white">{c.code}</p>
                  {c.description && <p className="text-xs text-white/40">{c.description}</p>}
                </Td>
                <Td className="text-white/70">{COUPON_TYPE[c.type]}</Td>
                <Td className="text-right text-white">{couponValue(c)}</Td>
                <Td className="text-right text-white/70">
                  {c.usedCount}
                  {c.maxUses ? ` / ${c.maxUses}` : ''}
                </Td>
                <Td className="text-white/50">
                  {c.expiresAt ? formatDate(c.expiresAt) : 'Sem prazo'}
                </Td>
                <Td>
                  {isExpired(c) ? (
                    <Badge tone="danger">Expirado</Badge>
                  ) : (
                    <Badge tone={c.isActive ? 'success' : 'neutral'}>
                      {c.isActive ? 'Ativo' : 'Inativo'}
                    </Badge>
                  )}
                </Td>
                <Td>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      className="px-3 py-1.5"
                      onClick={() => {
                        setEditing(c);
                        setModalOpen(true);
                      }}
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-3 py-1.5 text-red-300"
                      onClick={() => handleDelete(c)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal
        open={modalOpen}
        title={editing ? 'Editar cupom' : 'Novo cupom'}
        onClose={() => setModalOpen(false)}
      >
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Código *">
              <Input name="code" required defaultValue={editing?.code ?? ''} placeholder="INVERNO20" />
            </Field>
            <Field label="Tipo *">
              <Select name="type" defaultValue={editing?.type ?? 'PERCENTAGE'}>
                <option value="PERCENTAGE">Percentual (%)</option>
                <option value="FIXED">Valor fixo (R$)</option>
                <option value="FREE_SHIPPING">Frete grátis</option>
              </Select>
            </Field>
            <Field label="Valor *" hint="Percentual ou valor em reais.">
              <Input
                name="value"
                type="number"
                step="0.01"
                min="0"
                required
                defaultValue={editing?.value ?? ''}
              />
            </Field>
            <Field label="Pedido mínimo (R$)">
              <Input
                name="minOrderValue"
                type="number"
                step="0.01"
                min="0"
                defaultValue={editing?.minOrderValue ?? ''}
              />
            </Field>
            <Field label="Máx. usos (total)">
              <Input name="maxUses" type="number" min="1" defaultValue={editing?.maxUses ?? ''} />
            </Field>
            <Field label="Máx. usos por cliente">
              <Input
                name="maxUsesPerUser"
                type="number"
                min="1"
                defaultValue={editing?.maxUsesPerUser ?? 1}
              />
            </Field>
            <Field label="Início">
              <Input name="startsAt" type="date" defaultValue={dateInput(editing?.startsAt ?? null)} />
            </Field>
            <Field label="Expira em">
              <Input name="expiresAt" type="date" defaultValue={dateInput(editing?.expiresAt ?? null)} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Descrição">
                <Textarea name="description" rows={2} defaultValue={editing?.description ?? ''} />
              </Field>
            </div>
          </div>
          <Checkbox name="isActive" label="Cupom ativo" defaultChecked={editing?.isActive ?? true} />
          <div className="flex justify-end gap-3">
            <Button type="button" variant="ghost" onClick={() => setModalOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="solid">
              {editing ? 'Salvar' : 'Criar'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
