'use client';

import { useActionState, useState } from 'react';
import { PhoneInput } from '@/components/closetadmin/PhoneInput';
import { loginAction, type LoginFormState } from './actions';

const initialState: LoginFormState = { error: null };

const fieldClass = 'flex flex-col gap-1.5 text-sm';
const inputClass =
  'rounded-lg border border-ink/15 dark:border-white/15 bg-white dark:bg-dark-surface px-3.5 py-2.5 text-ink dark:text-dark-text outline-none transition focus:border-marsala dark:focus:border-gold focus:ring-2 focus:ring-marsala/20 dark:focus:ring-gold/20 disabled:opacity-60 placeholder:text-ink/40 dark:placeholder:text-dark-subtle';

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);
  const [phone, setPhone] = useState('');

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <label className={fieldClass}>
        <span className="font-medium text-ink/70 dark:text-dark-muted">Nome</span>
        <input name="name" type="text" autoComplete="name" required disabled={pending} className={inputClass} />
      </label>

      <label className={fieldClass}>
        <span className="font-medium text-ink/70 dark:text-dark-muted">Telefone</span>
        <PhoneInput name="phone" value={phone} onChange={setPhone} required disabled={pending} />
      </label>

      <label className={fieldClass}>
        <span className="font-medium text-ink/70 dark:text-dark-muted">PIN</span>
        <input
          name="pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          minLength={4}
          maxLength={8}
          required
          disabled={pending}
          className={inputClass}
        />
      </label>

      {state.error ? (
        <p role="alert" className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/40 px-3.5 py-2.5 text-sm text-red-700 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="mt-1 rounded-lg bg-marsala dark:bg-marsala-light px-4 py-2.5 font-medium text-cream dark:text-sand transition hover:bg-marsala/90 dark:hover:bg-marsala-glow dark:border dark:border-gold/20 shadow-md disabled:opacity-60"
      >
        {pending ? 'Entrando…' : 'Entrar'}
      </button>
    </form>
  );
}
