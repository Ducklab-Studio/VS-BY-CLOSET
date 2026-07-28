'use client';

import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Card ───────────────────────────────────────────────────────────────────

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('rounded-2xl border border-white/10 bg-dusk p-6', className)}>{children}</div>
  );
}

export function CardTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="font-heading text-sm tracking-widest text-white/80">{children}</h2>;
}

// ── Badge ──────────────────────────────────────────────────────────────────

const badgeTones = {
  neutral: 'border-white/20 text-white/70',
  success: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300',
  warning: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  danger: 'border-red-400/40 bg-red-400/10 text-red-300',
  info: 'border-sky-400/40 bg-sky-400/10 text-sky-300',
} as const;

export type BadgeTone = keyof typeof badgeTones;

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest',
        badgeTones[tone],
      )}
    >
      {children}
    </span>
  );
}

// ── Button ─────────────────────────────────────────────────────────────────

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'solid' | 'outline' | 'ghost' | 'danger';
  loading?: boolean;
};

export function Button({
  variant = 'outline',
  loading,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  const variants = {
    solid: 'bg-white text-ink border-white hover:bg-white/85',
    outline: 'border-white/25 text-white hover:bg-white/10',
    ghost: 'border-transparent text-white/70 hover:text-white hover:bg-white/5',
    danger: 'border-red-400/40 text-red-300 hover:bg-red-400/10',
  };
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-full border px-5 py-2.5 text-xs font-semibold uppercase tracking-widest transition disabled:opacity-50',
        variants[variant],
        className,
      )}
    >
      {loading && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  );
}

// ── Inputs ─────────────────────────────────────────────────────────────────

const fieldClass =
  'w-full rounded-lg border border-white/15 bg-white/5 px-3.5 py-2.5 text-sm text-white outline-none transition placeholder:text-white/30 focus:border-white/40 disabled:opacity-50';

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-widest text-white/60">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-white/40">{hint}</span>}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(fieldClass, props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(fieldClass, props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn(fieldClass, '[&>option]:bg-ink', props.className)} />;
}

export function Checkbox({
  label,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-white/80">
      <input
        type="checkbox"
        {...props}
        className="h-4 w-4 rounded border-white/25 bg-white/5 accent-white"
      />
      {label}
    </label>
  );
}

// ── Tabela ─────────────────────────────────────────────────────────────────

export function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-white/10">
      <table className="w-full min-w-[640px] text-left text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'border-b border-white/10 bg-white/[0.03] px-4 py-3 text-[11px] font-semibold uppercase tracking-widest text-white/50',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <td className={cn('border-b border-white/5 px-4 py-3 text-white/80', className)}>{children}</td>
  );
}

// ── Estados ────────────────────────────────────────────────────────────────

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/15 p-12 text-center text-sm text-white/50">
      {message}
    </div>
  );
}

export function LoadingState() {
  return (
    <div className="flex items-center justify-center gap-2 rounded-2xl border border-white/10 p-12 text-sm text-white/50">
      <Loader2 size={16} className="animate-spin" /> Carregando...
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-red-400/30 bg-red-400/10 p-6 text-sm text-red-300">
      {message}
    </div>
  );
}

// ── Paginação ──────────────────────────────────────────────────────────────

export function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  const pages = Array.from({ length: totalPages }, (_, i) => i + 1).filter(
    (n) => n === 1 || n === totalPages || Math.abs(n - page) <= 2,
  );

  return (
    <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
      {pages.map((n, i) => (
        <span key={n} className="flex items-center gap-2">
          {i > 0 && pages[i - 1] !== n - 1 && <span className="text-white/30">…</span>}
          <button
            onClick={() => onChange(n)}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-lg text-sm transition',
              n === page
                ? 'bg-white text-ink'
                : 'border border-white/15 text-white/70 hover:border-white/40',
            )}
          >
            {n}
          </button>
        </span>
      ))}
    </div>
  );
}

// ── Modal ──────────────────────────────────────────────────────────────────

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm">
      <div className="my-8 w-full max-w-2xl rounded-2xl border border-white/10 bg-dusk p-6">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="font-heading text-lg text-white">{title}</h2>
          <button onClick={onClose} className="text-sm text-white/50 hover:text-white">
            Fechar
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
