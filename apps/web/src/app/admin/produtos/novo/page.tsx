'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { adminApi } from '@/lib/admin-api';
import {
  Button,
  Card,
  CardTitle,
  Checkbox,
  ErrorState,
  Field,
  Input,
  Select,
  Textarea,
} from '@/components/admin/ui';
import type { AdminBrand, AdminCategory, AdminProduct } from '@/lib/admin-types';

export default function NewProductPage() {
  const router = useRouter();
  const [brands, setBrands] = useState<AdminBrand[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      adminApi.get<AdminBrand[]>('/brands/admin'),
      adminApi.get<AdminCategory[]>('/categories/admin'),
    ])
      .then(([b, c]) => {
        setBrands(b);
        setCategories(c);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setSaving(true);
    const form = new FormData(e.currentTarget);

    const payload: Record<string, unknown> = {
      name: form.get('name'),
      sku: form.get('sku'),
      description: form.get('description'),
      price: Number(form.get('price')),
      status: form.get('status'),
      isFeatured: form.get('isFeatured') === 'on',
      isNewArrival: form.get('isNewArrival') === 'on',
      maxInstallments: Number(form.get('maxInstallments')) || 1,
    };

    const optionalText = ['slug', 'material', 'metaTitle', 'metaDescription', 'brandId'] as const;
    for (const key of optionalText) {
      const value = form.get(key);
      if (value) payload[key] = value;
    }

    const optionalNumbers = ['promoPrice', 'pixDiscountPct', 'weightGrams'] as const;
    for (const key of optionalNumbers) {
      const value = form.get(key);
      if (value) payload[key] = Number(value);
    }

    if (selectedCategories.length > 0) payload.categoryIds = selectedCategories;

    try {
      const created = await adminApi.post<AdminProduct>('/admin/products', payload);
      router.push(`/admin/produtos/${created.id}`);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/admin/produtos" className="text-white/50 hover:text-white">
          <ArrowLeft size={20} />
        </Link>
        <h1 className="font-heading text-2xl text-white">Novo produto</h1>
      </div>

      {error && <ErrorState message={error} />}

      <form onSubmit={onSubmit} className="space-y-6">
        <Card>
          <CardTitle>Informações básicas</CardTitle>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Field label="Nome *">
              <Input name="name" required placeholder="Moon Boot Icon White" />
            </Field>
            <Field label="SKU *">
              <Input name="sku" required placeholder="MB-ICON-WHT" />
            </Field>
            <Field label="Slug" hint="Deixe vazio para gerar a partir do nome.">
              <Input name="slug" placeholder="moon-boot-icon-white" />
            </Field>
            <Field label="Material">
              <Input name="material" placeholder="Nylon impermeável / forro térmico" />
            </Field>
            <div className="md:col-span-2">
              <Field label="Descrição *">
                <Textarea name="description" required rows={5} />
              </Field>
            </div>
          </div>
        </Card>

        <Card>
          <CardTitle>Preços</CardTitle>
          <div className="mt-4 grid gap-4 md:grid-cols-4">
            <Field label="Preço *">
              <Input name="price" type="number" step="0.01" min="0" required />
            </Field>
            <Field label="Preço promocional">
              <Input name="promoPrice" type="number" step="0.01" min="0" />
            </Field>
            <Field label="Desconto PIX (%)">
              <Input name="pixDiscountPct" type="number" step="0.01" min="0" max="100" />
            </Field>
            <Field label="Máx. parcelas">
              <Input name="maxInstallments" type="number" min="1" defaultValue={1} />
            </Field>
          </div>
        </Card>

        <Card>
          <CardTitle>Organização</CardTitle>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Field label="Status">
              <Select name="status" defaultValue="DRAFT">
                <option value="DRAFT">Rascunho</option>
                <option value="ACTIVE">Ativo</option>
                <option value="ARCHIVED">Arquivado</option>
              </Select>
            </Field>
            <Field label="Marca">
              <Select name="brandId" defaultValue="">
                <option value="">Sem marca</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Peso (g)">
              <Input name="weightGrams" type="number" min="0" />
            </Field>
            <div className="flex items-end gap-6 pb-2">
              <Checkbox name="isFeatured" label="Destaque" />
              <Checkbox name="isNewArrival" label="Lançamento" />
            </div>
          </div>

          {categories.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-widest text-white/60">
                Categorias
              </p>
              <div className="flex flex-wrap gap-2">
                {categories.map((c) => {
                  const active = selectedCategories.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() =>
                        setSelectedCategories((prev) =>
                          active ? prev.filter((id) => id !== c.id) : [...prev, c.id],
                        )
                      }
                      className={`rounded-full border px-3.5 py-1.5 text-xs uppercase tracking-widest transition ${
                        active
                          ? 'border-white bg-white text-ink'
                          : 'border-white/20 text-white/60 hover:border-white/40'
                      }`}
                    >
                      {c.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </Card>

        <Card>
          <CardTitle>SEO</CardTitle>
          <div className="mt-4 grid gap-4">
            <Field label="Meta título">
              <Input name="metaTitle" maxLength={160} />
            </Field>
            <Field label="Meta descrição">
              <Textarea name="metaDescription" rows={2} maxLength={300} />
            </Field>
          </div>
        </Card>

        <div className="flex justify-end gap-3">
          <Link href="/admin/produtos">
            <Button type="button" variant="ghost">
              Cancelar
            </Button>
          </Link>
          <Button type="submit" variant="solid" loading={saving}>
            Criar produto
          </Button>
        </div>

        <p className="text-xs text-white/40">
          Após criar, você poderá adicionar imagens, variações (cor/tamanho) e estoque.
        </p>
      </form>
    </div>
  );
}
