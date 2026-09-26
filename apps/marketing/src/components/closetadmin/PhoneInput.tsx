'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { CountryFlag } from './CountryFlag';
import {
  DEFAULT_PHONE_COUNTRY,
  PHONE_COUNTRIES,
  composePhone,
  countryCodeOf,
  findPhoneCountry,
  formatNationalNumber,
  resolvePhoneInput,
} from '@/lib/closetadmin-phone';

const inputClass =
  'w-full rounded-r-lg border border-ink/15 dark:border-white/15 bg-white dark:bg-dark-surface px-3.5 py-2.5 text-base sm:text-sm text-ink dark:text-dark-text outline-none transition focus:border-marsala dark:focus:border-gold focus:ring-2 focus:ring-marsala/20 dark:focus:ring-gold/20 placeholder:text-ink/40 dark:placeholder:text-dark-subtle disabled:opacity-60';

/**
 * Campo de telefone com seletor de país (DDI) mostrando a bandeira real
 * — `<select>` nativo não aceita SVG dentro de `<option>`, por isso é um
 * dropdown próprio. `value`/`onChange` trafegam a string completa já
 * composta ("+56 9 1234 5678"), mesmo formato que os DTOs do
 * reservations-api já esperavam — nenhuma mudança de contrato.
 *
 * Número colado com DDI ("+55 11 98765-4321") ou maior que o país
 * selecionado troca o país sozinho (`resolvePhoneInput`) em vez de cortar
 * dígitos em silêncio.
 */
export function PhoneInput({
  name,
  value,
  onChange,
  disabled,
  required,
}: {
  name?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
}) {
  const [countryCode, setCountryCode] = useState(() => countryCodeOf(value) ?? DEFAULT_PHONE_COUNTRY.code);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const country = findPhoneCountry(countryCode);
  const nationalPart = value.replace(/^\+\d+\s?/, '');

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function selectCountry(nextCode: string) {
    setCountryCode(nextCode);
    setOpen(false);
    const nextCountry = findPhoneCountry(nextCode);
    onChange(composePhone(nextCode, formatNationalNumber(nationalPart, nextCountry)));
  }

  function handleNumberChange(raw: string) {
    const next = resolvePhoneInput(raw, countryCode);
    if (next.code !== countryCode) setCountryCode(next.code);
    onChange(composePhone(next.code, next.national));
  }

  return (
    <div ref={rootRef} className="relative flex">
      {name ? <input type="hidden" name={name} value={value} /> : null}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="flex items-center gap-1.5 rounded-l-lg border border-r-0 border-ink/15 dark:border-white/15 bg-white dark:bg-dark-surface px-2.5 py-2.5 text-sm text-ink dark:text-dark-text outline-none focus:border-marsala dark:focus:border-gold focus:ring-2 focus:ring-marsala/20 dark:focus:ring-gold/20 disabled:opacity-60 transition"
      >
        <CountryFlag code={country.code} />
        <span className="font-medium">+{country.code}</span>
        <ChevronDown size={14} className="text-ink/40 dark:text-dark-subtle" />
      </button>

      {open ? (
        <ul className="absolute top-full left-0 z-20 mt-1 w-40 overflow-hidden rounded-xl border border-ink/10 dark:border-white/15 bg-white dark:bg-dark-popover py-1 shadow-2xl transition">
          {PHONE_COUNTRIES.map((c) => (
            <li key={c.code}>
              <button
                type="button"
                onClick={() => selectCountry(c.code)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink dark:text-dark-text hover:bg-ink/5 dark:hover:bg-white/10 transition"
              >
                <CountryFlag code={c.code} />
                <span className="font-medium">{c.label}</span>
                <span className="ml-auto text-ink/40 dark:text-dark-subtle font-mono text-xs">+{c.code}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <input
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        placeholder={country.placeholder}
        value={nationalPart}
        onChange={(e) => handleNumberChange(e.target.value)}
        disabled={disabled}
        required={required}
        className={inputClass}
      />
    </div>
  );
}
