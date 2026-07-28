import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Combina classes Tailwind sem conflitos. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Formata um número como moeda BRL. */
export function formatPrice(value: number | string): string {
  const n = typeof value === 'string' ? Number(value) : value;
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(n);
}

/** Calcula parcelas sem juros. */
export function installments(total: number, max: number): string {
  if (max <= 1) return formatPrice(total);
  const value = total / max;
  return `${max}x de ${formatPrice(value)} sem juros`;
}
