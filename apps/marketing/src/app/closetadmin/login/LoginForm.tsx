'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { PhoneInput } from '@/components/closetadmin/PhoneInput';
import { loginAction, type LoginFormState } from './actions';

const initialState: LoginFormState = { error: null };

const fieldClass = 'flex flex-col gap-1.5 text-sm';
// text-base no celular: abaixo de 16px o iOS dá zoom ao focar o campo.
const inputClass =
  'w-full rounded-lg border border-ink/15 dark:border-white/15 bg-white dark:bg-dark-surface px-3.5 py-2.5 text-base sm:text-sm text-ink dark:text-dark-text outline-none transition focus:border-marsala dark:focus:border-gold focus:ring-2 focus:ring-marsala/20 dark:focus:ring-gold/20 disabled:opacity-60 placeholder:text-ink/40 dark:placeholder:text-dark-subtle';

/**
 * Campos controlados: depois de uma tentativa recusada, nome e telefone
 * continuam preenchidos (a ação de formulário do React limparia campos
 * não controlados). O erro some assim que a pessoa edita qualquer campo.
 */
export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [dismissedState, setDismissedState] = useState<LoginFormState | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!pending) inFlight.current = false;
  }, [pending]);

  const error = state.error && dismissedState !== state ? state.error : null;
  function edited() {
    setDismissedState(state);
  }

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        // Duplo clique/Enter repetido antes do botão desabilitar: um envio só.
        if (inFlight.current) event.preventDefault();
        else inFlight.current = true;
      }}
      aria-busy={pending}
      className="flex flex-col gap-4"
    >
      <label className={fieldClass}>
        <span className="font-medium text-ink/70 dark:text-dark-muted">Nome</span>
        <input
          name="name"
          type="text"
          autoComplete="username"
          required
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            edited();
          }}
          disabled={pending}
          className={inputClass}
        />
      </label>

      <label className={fieldClass}>
        <span className="font-medium text-ink/70 dark:text-dark-muted">Telefone</span>
        <PhoneInput
          name="phone"
          value={phone}
          onChange={(value) => {
            setPhone(value);
            edited();
          }}
          required
          disabled={pending}
        />
      </label>

      <label className={fieldClass}>
        <span className="font-medium text-ink/70 dark:text-dark-muted">PIN</span>
        <div className="relative">
          <input
            name="pin"
            type={showPin ? 'text' : 'password'}
            inputMode="numeric"
            pattern="\d{4,8}"
            title="O PIN tem de 4 a 8 números."
            autoComplete="current-password"
            minLength={4}
            maxLength={8}
            required
            value={pin}
            onChange={(event) => {
              setPin(event.target.value.replace(/\D/g, ''));
              edited();
            }}
            disabled={pending}
            className={`${inputClass} pr-11`}
          />
          <button
            type="button"
            onClick={() => setShowPin((v) => !v)}
            aria-label={showPin ? 'Ocultar PIN' : 'Mostrar PIN'}
            aria-pressed={showPin}
            disabled={pending}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-ink/45 transition hover:text-ink/70 disabled:opacity-60 dark:text-dark-subtle dark:hover:text-dark-muted"
          >
            {showPin ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        </div>
      </label>

      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/40 px-3.5 py-2.5 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="mt-1 inline-flex items-center justify-center gap-2 rounded-lg bg-marsala dark:bg-marsala-light px-4 py-3 sm:py-2.5 font-medium text-cream dark:text-sand transition hover:bg-marsala/90 dark:hover:bg-marsala-glow dark:border dark:border-gold/20 shadow-md disabled:opacity-60"
      >
        {pending ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null}
        {pending ? 'Entrando…' : 'Entrar'}
      </button>
    </form>
  );
}
