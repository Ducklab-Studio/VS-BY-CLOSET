'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Pencil } from 'lucide-react';
import { adminApi } from '@/lib/admin-api';
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
  Table,
  Td,
  Textarea,
  Th,
} from '@/components/admin/ui';
import type { AdminBrand } from '@/lib/admin-types';

export default function AdminBrandsPage() {
  const [items, setItems] = useState<AdminBrand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<AdminBrand | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    adminApi
      .get<AdminBrand[]>('/brands/admin')
      .then(setItems)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const payload: Record<string, unknown> = {
      name: form.get('name'),
      isActive: form.get('isActive') === 'on',
    };
    for (const key of ['slug', 'description', 'logoUrl'] as const) {
      const value = form.get(key);
      if (value) payload[key] = value;
    }

    try {
      if (editing) await adminApi.patch(`/brands/admin/${editing.id}`, payload);
      else await adminApi.post('/brands/admin', payload);
      setModalOpen(false);
      load();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function handleDelete(brand: AdminBrand) {
    if (!confirm(`Excluir a marca "${brand.name}"?`)) return;
    try {
      await adminApi.delete(`/brands/admin/${brand.id}`);
      load();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl text-white">Marcas</h1>
          <p className="mt-1 text-sm text-white/50">{items.length} marca(s)</p>
        </div>
        <Button
          variant="solid"
          onClick={() => {
            setEditing(null);
            setModalOpen(true);
          }}
        >
          <Plus size={14} /> Nova marca
        </Button>
      </div>

      {error ? (
        <ErrorState message={error} />
      ) : loading ? (
        <LoadingState />
      ) : items.length === 0 ? (
        <EmptyState message="Nenhuma marca cadastrada." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Marca</Th>
              <Th>Slug</Th>
              <Th className="text-right">Produtos</Th>
              <Th>Status</Th>
              <Th className="text-right">Ações</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((b) => (
              <tr key={b.id}>
                <Td>
                  <div className="flex items-center gap-3">
                    {b.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={b.logoUrl} alt={b.name} className="h-8 w-8 rounded object-contain" />
                    ) : (
                      <div className="h-8 w-8 rounded bg-white/5" />
                    )}
                    <span className="text-white">{b.name}</span>
                  </div>
                </Td>
                <Td className="text-white/50">{b.slug}</Td>
                <Td className="text-right text-white/70">{b._count?.products ?? 0}</Td>
                <Td>
                  <Badge tone={b.isActive ? 'success' : 'neutral'}>
                    {b.isActive ? 'Ativa' : 'Inativa'}
                  </Badge>
                </Td>
                <Td>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      className="px-3 py-1.5"
                      onClick={() => {
                        setEditing(b);
                        setModalOpen(true);
                      }}
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-3 py-1.5 text-red-300"
                      onClick={() => handleDelete(b)}
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
        title={editing ? 'Editar marca' : 'Nova marca'}
        onClose={() => setModalOpen(false)}
      >
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome *">
              <Input name="name" required defaultValue={editing?.name ?? ''} />
            </Field>
            <Field label="Slug" hint="Vazio = gerado a partir do nome.">
              <Input name="slug" defaultValue={editing?.slug ?? ''} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Logo (URL)">
                <Input name="logoUrl" defaultValue={editing?.logoUrl ?? ''} />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="Descrição">
                <Textarea name="description" rows={3} defaultValue={editing?.description ?? ''} />
              </Field>
            </div>
          </div>
          <Checkbox name="isActive" label="Marca ativa" defaultChecked={editing?.isActive ?? true} />
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
