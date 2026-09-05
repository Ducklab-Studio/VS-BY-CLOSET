'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { CalendarDays, ClipboardList, LayoutDashboard, LogOut, Menu, Scale, Shirt, ShieldCheck, X } from 'lucide-react';
import type { AdminSessionUser } from '@/lib/admin-session';
import { logoutAction } from '@/app/closetadmin/actions';
import { AdminThemeToggle } from './AdminThemeToggle';

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: React.ComponentType<{ size?: number; className?: string }>;
  readonly adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/closetadmin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/closetadmin/calendario', label: 'Calendário', icon: CalendarDays },
  { href: '/closetadmin/reservas', label: 'Reservas', icon: ClipboardList },
  { href: '/closetadmin/pecas', label: 'Peças', icon: Shirt },
  { href: '/closetadmin/regras', label: 'Regras e bloqueios', icon: Scale, adminOnly: true },
  { href: '/closetadmin/auditoria', label: 'Auditoria', icon: ShieldCheck, adminOnly: true },
];

/**
 * Fase 9 — chrome próprio do painel (item "UX/Design": sidebar, header,
 * nav mobile). Itens ADMIN-only somem do menu pra STAFF, mas isso é só
 * conveniência de navegação — "não confiar em esconder botão no
 * frontend": cada página ADMIN-only chama `requireAdminRole` server-side
 * de qualquer forma (ver src/lib/admin-session.ts), e o reservations-api
 * revalida de novo (`AdminRoleGuard`).
 */
export function AdminShell({ session, children }: { session: AdminSessionUser; children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const items = NAV_ITEMS.filter((item) => !item.adminOnly || session.role === 'ADMIN');
  const isActive = (href: string) => (href === '/closetadmin' ? pathname === href : pathname?.startsWith(href));

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-dark-bg text-ink dark:text-dark-text transition-colors duration-200 lg:flex">
      {/* Sidebar — desktop */}
      <aside className="hidden w-64 shrink-0 border-r border-ink/10 dark:border-white/10 bg-white dark:bg-dark-surface lg:flex lg:flex-col transition-colors duration-200">
        <SidebarContent items={items} isActive={isActive} session={session} />
      </aside>

      {/* Nav mobile — overlay */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button aria-label="Fechar menu" className="absolute inset-0 bg-black/40 dark:bg-black/70 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col bg-white dark:bg-dark-surface shadow-2xl border-r border-ink/10 dark:border-white/10">
            <SidebarContent items={items} isActive={isActive} session={session} onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-ink/10 dark:border-white/10 bg-white dark:bg-dark-surface px-4 py-3 lg:px-6 transition-colors duration-200">
          <button
            aria-label="Abrir menu"
            className="rounded-md p-2 text-ink/70 dark:text-dark-muted hover:bg-ink/5 dark:hover:bg-white/5 lg:hidden"
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={22} />
          </button>
          <div className="hidden font-heading text-lg text-marsala dark:text-gold tracking-wide lg:block font-bold">
            ClosetAdmin
          </div>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <AdminThemeToggle />
            <div className="h-4 w-[1px] bg-ink/10 dark:bg-white/10" />
            <span className="text-ink/70 dark:text-dark-muted">
              <strong className="font-medium text-ink dark:text-dark-text">{session.name}</strong> <span className="text-ink/40 dark:text-white/20">·</span> {session.role === 'ADMIN' ? 'Administrador' : 'Equipe'}
            </span>
            <form action={logoutAction}>
              <button type="submit" className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-ink/60 dark:text-dark-muted hover:bg-ink/5 dark:hover:bg-white/5 hover:text-ink dark:hover:text-dark-text transition">
                <LogOut size={16} /> Sair
              </button>
            </form>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}

function SidebarContent({
  items,
  isActive,
  session,
  onNavigate,
}: {
  items: NavItem[];
  isActive: (href: string) => boolean | undefined;
  session: AdminSessionUser;
  onNavigate?: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between px-5 py-5 border-b border-ink/5 dark:border-white/5">
        <div className="flex flex-col">
          <span className="font-heading text-xl font-bold text-marsala dark:text-gold tracking-wide">ClosetAdmin</span>
          <span className="text-[11px] text-ink/40 dark:text-dark-subtle tracking-wider uppercase">Painel de Operações</span>
        </div>
        {onNavigate ? (
          <button aria-label="Fechar menu" className="rounded-md p-1 text-ink/50 dark:text-dark-muted hover:bg-ink/5 dark:hover:bg-white/5" onClick={onNavigate}>
            <X size={20} />
          </button>
        ) : null}
      </div>
      <nav className="flex flex-1 flex-col gap-1.5 px-3 py-4">
        {items.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              className={`flex items-center gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium transition-all ${
                active
                  ? 'bg-marsala/10 dark:bg-marsala/40 text-marsala dark:text-gold font-semibold shadow-sm border-l-2 border-marsala dark:border-gold'
                  : 'text-ink/70 dark:text-dark-muted hover:bg-ink/5 dark:hover:bg-white/5 hover:text-ink dark:hover:text-dark-text'
              }`}
            >
              <Icon size={18} className={active ? 'text-marsala dark:text-gold' : 'opacity-70'} />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-ink/10 dark:border-white/10 px-5 py-4 text-xs text-ink/40 dark:text-dark-subtle">
        Sessão: <span className="font-medium text-ink/60 dark:text-dark-muted">{session.name}</span> ({session.role})
      </div>
    </>
  );
}

