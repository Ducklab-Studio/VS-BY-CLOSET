'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

export function AdminThemeToggle({ className = '' }: { className?: string }) {
  const [mounted, setMounted] = useState(false);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setMounted(true);
    const stored = localStorage.getItem('closetadmin_theme');
    const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const initialIsDark = stored ? stored === 'dark' : systemPrefersDark;

    setIsDark(initialIsDark);
    if (initialIsDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, []);

  function toggleTheme() {
    const nextIsDark = !isDark;
    setIsDark(nextIsDark);

    if (nextIsDark) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('closetadmin_theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('closetadmin_theme', 'light');
    }
  }

  if (!mounted) {
    return (
      <div
        className={`h-8 w-8 rounded-lg border border-ink/10 dark:border-white/10 bg-transparent ${className}`}
        aria-hidden="true"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={isDark ? 'Mudar para modo claro' : 'Mudar para modo escuro'}
      aria-label={isDark ? 'Mudar para modo claro' : 'Mudar para modo escuro'}
      className={`group relative flex h-8 w-8 items-center justify-center rounded-lg border border-ink/10 dark:border-white/15 bg-white/50 dark:bg-white/5 text-ink/70 dark:text-gold transition-all duration-200 hover:border-marsala/40 dark:hover:border-gold/50 hover:bg-marsala/5 dark:hover:bg-gold/10 hover:text-marsala dark:hover:text-gold focus:outline-none focus:ring-2 focus:ring-marsala/20 dark:focus:ring-gold/30 ${className}`}
    >
      {isDark ? (
        <Sun size={17} className="transition-transform duration-300 group-hover:rotate-45 text-gold drop-shadow-[0_0_8px_rgba(242,217,160,0.5)]" />
      ) : (
        <Moon size={17} className="transition-transform duration-300 group-hover:-rotate-12 text-ink/80 group-hover:text-marsala" />
      )}
    </button>
  );
}
