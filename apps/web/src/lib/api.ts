import type { Product, Paginated } from './types';
import { apiBase } from './api-url';

/** Wrapper de fetch com tratamento de erro e tipagem. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    // revalida catálogo a cada 60s (ISR-friendly)
    next: { revalidate: 60 },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `Erro ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  products: {
    list: (query: Record<string, string | number | undefined> = {}) => {
      const params = new URLSearchParams();
      Object.entries(query).forEach(([k, v]) => {
        if (v !== undefined && v !== '') params.set(k, String(v));
      });
      const qs = params.toString();
      return request<Paginated<Product>>(`/products${qs ? `?${qs}` : ''}`);
    },
    bySlug: (slug: string) => request<Product>(`/products/${slug}`),
    autocomplete: (q: string) =>
      request<{ name: string; slug: string }[]>(
        `/products/autocomplete?q=${encodeURIComponent(q)}`,
      ),
  },
};
