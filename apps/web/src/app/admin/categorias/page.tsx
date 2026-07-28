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
  Select,
  Table,
  Td,
  Textarea,
  Th,
} from '@/components/admin/ui';
import type { AdminCategory } from '@/lib/admin-types';

export default function AdminCategoriesPage() {
  const [items, setItems] = useState<AdminCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<AdminCategory | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    adminApi
      .get<AdminCategory[]>('/categories/admin')
      .then(setItems)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  function openNew() {
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(category: AdminCategory) {
    setEditing(category);
    setModalOpen(true);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const payload: Record<string, unknown> = {
      name: form.get('name'),
      isActive: form.get('isActive') === 'on',
      position: Number(form.get('position')) || 0,
    };
    for (const key of ['slug', 'description', 'imageUrl', 'parentId'] as const) {
      const value = form.get(key);
      if (value) payload[key] = value;
    }

    try {
      if (editing) await adminApi.patch(`/categories/admin/${editing.id}`, payload);
      else await adminApi.post('/categories/admin', payload);
      setModalOpen(false);
      load();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function handleDelete(category: AdminCategory) {
    if (!confirm(`Excluir a categoria "${category.name}"?`)) return;
    try {
      await adminApi.delete(`/categories/admin/${category.id}`);
      load();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  const parentName = (parentId: string | null) =>
    parentId ? (items.find((c) => c.id === parentId)?.name ?? '—') : '—';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl text-white">Categorias</h1>
          <p className="mt-1 text-sm text-white/50">{items.length} categoria(s)</p>
        </div>
        <Button variant="solid" onClick={openNew}>
          <Plus size={14} /> Nova categoria
        </Button>
      </div>

      {error ? (
        <ErrorState message={error} />
      ) : loading ? (
        <LoadingState />
      ) : items.length === 0 ? (
        <EmptyState message="Nenhuma categoria cadastrada." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Nome</Th>
              <Th>Slug</Th>
              <Th>Categoria pai</Th>
              <Th className="text-right">Produtos</Th>
              <Th>Status</Th>
              <Th className="text-right">Ações</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <Td className="text-white">{c.name}</Td>
                <Td className="text-white/50">{c.slug}</Td>
                <Td className="text-white/50">{parentName(c.parentId)}</Td>
                <Td className="text-right text-white/70">{c._count?.products ?? 0}</Td>
                <Td>
                  <Badge tone={c.isActive ? 'success' : 'neutral'}>
                    {c.isActive ? 'Ativa' : 'Inativa'}
                  </Badge>
                </Td>
                <Td>
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" className="px-3 py-1.5" onClick={() => openEdit(c)}>
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
        title={editing ? 'Editar categoria' : 'Nova categoria'}
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
            <Field label="Categoria pai">
              <Select name="parentId" defaultValue={editing?.parentId ?? ''}>
                <option value="">Nenhuma (raiz)</option>
                {items
                  .filter((c) => c.id !== editing?.id)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Posição">
              <Input name="position" type="number" min="0" defaultValue={editing?.position ?? 0} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Imagem (URL)">
                <Input name="imageUrl" defaultValue={editing?.imageUrl ?? ''} />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="Descrição">
                <Textarea name="description" rows={3} defaultValue={editing?.description ?? ''} />
              </Field>
            </div>
          </div>
          <Checkbox name="isActive" label="Categoria ativa" defaultChecked={editing?.isActive ?? true} />
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
