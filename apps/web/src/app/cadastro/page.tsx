'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { saveSession, type SessionUser } from '@/lib/auth';
import { apiBase } from '@/lib/api-url';

export default function RegisterPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch(`${apiBase()}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: form.get('name'),
          email: form.get('email'),
          password: form.get('password'),
        }),
      });
      const data = await res.json();
      if (!res.ok)
        throw new Error(Array.isArray(data.message) ? data.message[0] : (data.message ?? 'Falha'));
      saveSession(data.accessToken, data.user as SessionUser);
      router.push('/conta');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro inesperado');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col px-4 py-16">
      <h1 className="font-heading text-2xl text-white">Criar conta</h1>
      <p className="mt-1 text-sm text-white/50">Ganhe 10% de desconto na primeira compra.</p>

      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        {error && (
          <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}
        <div>
          <label htmlFor="name" className="mb-1 block text-sm font-medium text-white/80">
            Nome completo
          </label>
          <input
            id="name"
            name="name"
            required
            autoComplete="name"
            className="w-full rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-white outline-none focus:border-white/40"
          />
        </div>
        <div>
          <label htmlFor="email" className="mb-1 block text-sm font-medium text-white/80">
            E-mail
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className="w-full rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-white outline-none focus:border-white/40"
          />
        </div>
        <div>
          <label htmlFor="password" className="mb-1 block text-sm font-medium text-white/80">
            Senha
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className="w-full rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-white outline-none focus:border-white/40"
          />
          <p className="mt-1 text-xs text-white/40">
            Mínimo 8 caracteres, com maiúscula, minúscula e número.
          </p>
        </div>
        <button type="submit" disabled={loading} className="btn-pill btn-pill-solid w-full justify-center disabled:opacity-60">
          {loading ? 'Criando...' : 'Criar conta'}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-white/50">
        Já tem conta?{' '}
        <Link href="/login" className="font-medium text-white hover:underline">
          Entrar
        </Link>
      </p>
    </div>
  );
}
