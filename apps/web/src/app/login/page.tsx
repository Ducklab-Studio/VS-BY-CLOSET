'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { isStaff, saveSession, type SessionUser } from '@/lib/auth';
import { apiBase } from '@/lib/api-url';

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch(`${apiBase()}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: form.get('email'),
          password: form.get('password'),
        }),
      });
      const data = (await res.json()) as
        | { accessToken: string; user: SessionUser }
        | { message?: string };
      if (!res.ok) throw new Error((data as { message?: string }).message ?? 'Falha no login');

      const { accessToken, user } = data as { accessToken: string; user: SessionUser };
      saveSession(accessToken, user);

      const next = searchParams.get('next');
      router.push(next ?? (isStaff(user) ? '/admin' : '/conta'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro inesperado');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col px-4 py-16">
      <h1 className="font-heading text-2xl text-white">Entrar</h1>
      <p className="mt-1 text-sm text-white/50">Acesse sua conta para continuar.</p>

      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        {error && (
          <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}
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
            autoComplete="current-password"
            className="w-full rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-white outline-none focus:border-white/40"
          />
          <Link href="/recuperar-senha" className="mt-1 block text-right text-xs text-white/60 hover:underline">
            Esqueci minha senha
          </Link>
        </div>
        <button type="submit" disabled={loading} className="btn-pill btn-pill-solid w-full justify-center disabled:opacity-60">
          {loading ? 'Entrando...' : 'Entrar'}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-white/50">
        Não tem conta?{' '}
        <Link href="/cadastro" className="font-medium text-white hover:underline">
          Cadastre-se
        </Link>
      </p>
    </div>
  );
}
