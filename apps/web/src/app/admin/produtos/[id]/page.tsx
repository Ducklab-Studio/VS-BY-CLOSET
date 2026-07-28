'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Trash2, ExternalLink } from 'lucide-react';
import { adminApi } from '@/lib/admin-api';
import { formatPrice } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Checkbox,
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
import { ImageUploader } from '@/components/admin/ImageUploader';
import type { AdminBrand, AdminCategory, AdminProduct, AdminVariant } from '@/lib/admin-types';

export default function EditProductPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [product, setProduct] = useState<AdminProduct | null>(null);
  const [brands, setBrands] = useState<AdminBrand[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  const [variantModal, setVariantModal] = useState(false);
  const [stockVariant, setStockVariant] = useState<AdminVariant | null>(null);

  const load = useCallback(() => {
    adminApi
      .get<AdminProduct>(`/admin/products/${id}`)
      .then((p) => {
        setProduct(p);
        setSelectedCategories(p.categories?.map((c) => c.categoryId) ?? []);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
    Promise.all([
      adminApi.get<AdminBrand[]>('/brands/admin'),
      adminApi.get<AdminCategory[]>('/categories/admin'),
    ]).then(([b, c]) => {
      setBrands(b);
      setCategories(c);
    });
  }, [load]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setNotice('');
    setSaving(true);
    const form = new FormData(e.currentTarget);

    const payload: Record<string, unknown> = {
      name: form.get('name'),
      sku: form.get('sku'),
      slug: form.get('slug'),
      description: form.get('description'),
      price: Number(form.get('price')),
      status: form.get('status'),
      isFeatured: form.get('isFeatured') === 'on',
      isNewArrival: form.get('isNewArrival') === 'on',
      maxInstallments: Number(form.get('maxInstallments')) || 1,
      brandId: form.get('brandId') || undefined,
      categoryIds: selectedCategories,
    };

    for (const key of ['material', 'metaTitle', 'metaDescription'] as const) {
      const value = form.get(key);
      if (value) payload[key] = value;
    }
    for (const key of ['promoPrice', 'pixDiscountPct', 'weightGrams'] as const) {
      const value = form.get(key);
      if (value) payload[key] = Number(value);
    }

    try {
      await adminApi.patch(`/admin/products/${id}`, payload);
      setNotice('Produto salvo com sucesso.');
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function addVariant(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const payload: Record<string, unknown> = {
      sku: form.get('sku'),
      initialQuantity: Number(form.get('initialQuantity')) || 0,
      lowStockAt: Number(form.get('lowStockAt')) || 5,
    };
    for (const key of ['color', 'colorHex', 'size'] as const) {
      const value = form.get(key);
      if (value) payload[key] = value;
    }
    const price = form.get('price');
    if (price) payload.price = Number(price);

    try {
      await adminApi.post(`/admin/products/${id}/variants`, payload);
      setVariantModal(false);
      load();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function removeVariant(variantId: string) {
    if (!confirm('Excluir esta variação?')) return;
    try {
      await adminApi.delete(`/admin/products/${id}/variants/${variantId}`);
      load();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function saveStock(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!stockVariant) return;
    const form = new FormData(e.currentTarget);
    try {
      await adminApi.patch(`/admin/products/${id}/variants/${stockVariant.id}/inventory`, {
        quantity: Number(form.get('quantity')),
        lowStockAt: Number(form.get('lowStockAt')),
        reason: form.get('reason') || undefined,
      });
      setStockVariant(null);
      load();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function addMedia(url: string) {
    await adminApi.post(`/admin/products/${id}/media`, { url });
    load();
  }

  async function removeMedia(mediaId: string) {
    try {
      await adminApi.delete(`/admin/products/${id}/media/${mediaId}`);
      load();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function handleDelete() {
    if (!product) return;
    if (!confirm(`Excluir "${product.name}"? Esta ação não pode ser desfeita.`)) return;
    try {
      await adminApi.delete(`/admin/products/${id}`);
      router.push('/admin/produtos');
    } catch (err) {
      alert((err as Error).message);
    }
  }

  if (loading) return <LoadingState />;
  if (!product) return <ErrorState message={error || 'Produto não encontrado.'} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link href="/admin/produtos" className="text-white/50 hover:text-white">
            <ArrowLeft size={20} />
          </Link>
          <div>
            <h1 className="font-heading text-2xl text-white">{product.name}</h1>
            <p className="mt-1 text-sm text-white/50">SKU {product.sku}</p>
          </div>
        </div>
        <div className="flex gap-3">
          <Link href={`/produto/${product.slug}`} target="_blank">
            <Button variant="ghost">
              <ExternalLink size={14} /> Ver na loja
            </Button>
          </Link>
          <Button variant="danger" onClick={handleDelete}>
            <Trash2 size={14} /> Excluir
          </Button>
        </div>
      </div>

      {error && <ErrorState message={error} />}
      {notice && (
        <div className="rounded-2xl border border-emerald-400/30 bg-emerald-400/10 p-4 text-sm text-emerald-300">
          {notice}
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-6">
        <Card>
          <CardTitle>Informações básicas</CardTitle>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Field label="Nome *">
              <Input name="name" required defaultValue={product.name} />
            </Field>
            <Field label="SKU *">
              <Input name="sku" required defaultValue={product.sku} />
            </Field>
            <Field label="Slug">
              <Input name="slug" defaultValue={product.slug} />
            </Field>
            <Field label="Material">
              <Input name="material" defaultValue={product.material ?? ''} />
            </Field>
            <div className="md:col-span-2">
              <Field label="Descrição *">
                <Textarea name="description" required rows={5} defaultValue={product.description} />
              </Field>
            </div>
          </div>
        </Card>

        <Card>
          <CardTitle>Preços</CardTitle>
          <div className="mt-4 grid gap-4 md:grid-cols-4">
            <Field label="Preço *">
              <Input name="price" type="number" step="0.01" min="0" required defaultValue={product.price} />
            </Field>
            <Field label="Preço promocional">
              <Input
                name="promoPrice"
                type="number"
                step="0.01"
                min="0"
                defaultValue={product.promoPrice ?? ''}
              />
            </Field>
            <Field label="Desconto PIX (%)">
              <Input
                name="pixDiscountPct"
                type="number"
                step="0.01"
                min="0"
                max="100"
                defaultValue={product.pixDiscountPct ?? ''}
              />
            </Field>
            <Field label="Máx. parcelas">
              <Input name="maxInstallments" type="number" min="1" defaultValue={product.maxInstallments} />
            </Field>
          </div>
        </Card>

        <Card>
          <CardTitle>Organização</CardTitle>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Field label="Status">
              <Select name="status" defaultValue={product.status}>
                <option value="DRAFT">Rascunho</option>
                <option value="ACTIVE">Ativo</option>
                <option value="ARCHIVED">Arquivado</option>
              </Select>
            </Field>
            <Field label="Marca">
              <Select name="brandId" defaultValue={product.brandId ?? ''}>
                <option value="">Sem marca</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end gap-6 pb-2 md:col-span-2">
              <Checkbox name="isFeatured" label="Destaque" defaultChecked={product.isFeatured} />
              <Checkbox name="isNewArrival" label="Lançamento" defaultChecked={product.isNewArrival} />
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
                          active ? prev.filter((x) => x !== c.id) : [...prev, c.id],
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
              <Input name="metaTitle" maxLength={160} defaultValue={product.metaTitle ?? ''} />
            </Field>
            <Field label="Meta descrição">
              <Textarea
                name="metaDescription"
                rows={2}
                maxLength={300}
                defaultValue={product.metaDescription ?? ''}
              />
            </Field>
          </div>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" variant="solid" loading={saving}>
            Salvar alterações
          </Button>
        </div>
      </form>

      {/* ── Imagens ─────────────────────────────────────────────────────── */}
      <Card>
        <CardTitle>Imagens</CardTitle>
        <div className="mt-4">
          <ImageUploader onUploaded={addMedia} />
        </div>
        {product.media.length === 0 ? (
          <p className="mt-4 text-sm text-white/40">Nenhuma imagem cadastrada.</p>
        ) : (
          <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-8">
            {product.media.map((m) => (
              <div key={m.id} className="group relative aspect-square overflow-hidden rounded-lg bg-mist">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={m.url} alt={m.alt ?? product.name} className="h-full w-full object-cover" />
                <button
                  onClick={() => removeMedia(m.id)}
                  className="absolute inset-0 flex items-center justify-center bg-black/70 text-red-300 opacity-0 transition group-hover:opacity-100"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ── Variações ───────────────────────────────────────────────────── */}
      <Card>
        <div className="flex items-center justify-between">
          <CardTitle>Variações e estoque</CardTitle>
          <Button onClick={() => setVariantModal(true)}>
            <Plus size={14} /> Nova variação
          </Button>
        </div>

        {product.variants.length === 0 ? (
          <p className="mt-4 text-sm text-white/40">
            Nenhuma variação. Adicione ao menos uma para controlar estoque.
          </p>
        ) : (
          <div className="mt-4">
            <Table>
              <thead>
                <tr>
                  <Th>SKU</Th>
                  <Th>Cor</Th>
                  <Th>Tamanho</Th>
                  <Th className="text-right">Preço</Th>
                  <Th className="text-right">Estoque</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Ações</Th>
                </tr>
              </thead>
              <tbody>
                {product.variants.map((v) => {
                  const qty = v.inventory?.quantity ?? 0;
                  const low = v.inventory?.lowStockAt ?? 5;
                  return (
                    <tr key={v.id}>
                      <Td className="text-white">{v.sku}</Td>
                      <Td>
                        <span className="flex items-center gap-2 text-white/70">
                          {v.colorHex && (
                            <span
                              className="h-4 w-4 rounded-full border border-white/20"
                              style={{ backgroundColor: v.colorHex }}
                            />
                          )}
                          {v.color ?? '—'}
                        </span>
                      </Td>
                      <Td className="text-white/70">{v.size ?? '—'}</Td>
                      <Td className="text-right text-white/70">
                        {v.price ? formatPrice(v.price) : 'Preço base'}
                      </Td>
                      <Td className="text-right">
                        <Badge tone={qty === 0 ? 'danger' : qty <= low ? 'warning' : 'neutral'}>
                          {qty}
                        </Badge>
                      </Td>
                      <Td>
                        <Badge tone={v.isActive ? 'success' : 'neutral'}>
                          {v.isActive ? 'Ativa' : 'Inativa'}
                        </Badge>
                      </Td>
                      <Td>
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" className="px-3 py-1.5" onClick={() => setStockVariant(v)}>
                            Estoque
                          </Button>
                          <Button
                            variant="ghost"
                            className="px-3 py-1.5 text-red-300"
                            onClick={() => removeVariant(v.id)}
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
          </div>
        )}
      </Card>

      {/* Modal: nova variação */}
      <Modal open={variantModal} title="Nova variação" onClose={() => setVariantModal(false)}>
        <form onSubmit={addVariant} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="SKU *">
              <Input name="sku" required placeholder={`${product.sku}-38`} />
            </Field>
            <Field label="Tamanho">
              <Input name="size" placeholder="38" />
            </Field>
            <Field label="Cor">
              <Input name="color" placeholder="Branco" />
            </Field>
            <Field label="Cor (hex)">
              <Input name="colorHex" placeholder="#ffffff" />
            </Field>
            <Field label="Preço" hint="Vazio = usa o preço base do produto.">
              <Input name="price" type="number" step="0.01" min="0" />
            </Field>
            <Field label="Estoque inicial">
              <Input name="initialQuantity" type="number" min="0" defaultValue={0} />
            </Field>
            <Field label="Alerta de estoque baixo">
              <Input name="lowStockAt" type="number" min="0" defaultValue={5} />
            </Field>
          </div>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="ghost" onClick={() => setVariantModal(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="solid">
              Adicionar
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal: ajustar estoque */}
      <Modal
        open={!!stockVariant}
        title={`Estoque — ${stockVariant?.sku ?? ''}`}
        onClose={() => setStockVariant(null)}
      >
        {stockVariant && (
          <form onSubmit={saveStock} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Quantidade em estoque">
                <Input
                  name="quantity"
                  type="number"
                  min="0"
                  required
                  defaultValue={stockVariant.inventory?.quantity ?? 0}
                />
              </Field>
              <Field label="Alerta de estoque baixo">
                <Input
                  name="lowStockAt"
                  type="number"
                  min="0"
                  defaultValue={stockVariant.inventory?.lowStockAt ?? 5}
                />
              </Field>
            </div>
            <Field label="Motivo do ajuste">
              <Input name="reason" placeholder="Recebimento de mercadoria, inventário..." />
            </Field>
            <div className="flex justify-end gap-3">
              <Button type="button" variant="ghost" onClick={() => setStockVariant(null)}>
                Cancelar
              </Button>
              <Button type="submit" variant="solid">
                Salvar estoque
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
