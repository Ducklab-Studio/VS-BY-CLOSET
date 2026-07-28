'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  Package,
  ShoppingCart,
  Tags,
  Award,
  Ticket,
  Users,
  Star,
  LogOut,
  Menu,
  X,
  Store,
} from 'lucide-react';
import { clearSession, getUser, isStaff, type SessionUser } from '@/lib/auth';
import { adminApi } from '@/lib/admin-api';
import { cn } from '@/lib/utils';

const navItems = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { href: '/admin/produtos', label: 'Produtos', icon: Package },
  { href: '/admin/pedidos', label: 'Pedidos', icon: ShoppingCart },
  { href: '/admin/categorias', label: 'Categorias', icon: Tags },
  { href: '/admin/marcas', label: 'Marcas', icon: Award },
  { href: '/admin/cupons', label: 'Cupons', icon: Ticket },
  { href: '/admin/clientes', label: 'Clientes', icon: Users },
  { href: '/admin/avaliacoes', label: 'Avaliações', icon: Star },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const current = getUser();
    if (!isStaff(current)) {
      router.replace('/login?next=/admin');
      return;
    }
    setUser(current);
    setChecking(false);
  }, [router]);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  async function handleLogout() {
    try {
      await adminApi.post('/auth/logout');
    } catch {
      // logout local mesmo se a API falhar
    }
    clearSession();
    router.push('/login');
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-white/50">
        Verificando acesso...
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-64 shrink-0 border-r border-white/10 bg-dusk transition-transform lg:static lg:translate-x-0',
          menuOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-16 items-center justify-between border-b border-white/10 px-5">
          <Link href="/admin" className="font-heading text-sm tracking-widest text-white">
            ADMIN
          </Link>
          <button className="text-white/60 lg:hidden" onClick={() => setMenuOpen(false)}>
            <X size={20} />
          </button>
        </div>

        <nav className="flex flex-col gap-1 p-3">
          {navItems.map((item) => {
            const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-xs font-medium uppercase tracking-widest transition',
                  active ? 'bg-white text-ink' : 'text-white/60 hover:bg-white/5 hover:text-white',
                )}
              >
                <item.icon size={16} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="absolute inset-x-0 bottom-0 border-t border-white/10 p-3">
          <Link
            href="/"
            className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-xs font-medium uppercase tracking-widest text-white/60 transition hover:bg-white/5 hover:text-white"
          >
            <Store size={16} /> Ver loja
          </Link>
          <button
            onClick={handleLogout}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-xs font-medium uppercase tracking-widest text-white/60 transition hover:bg-white/5 hover:text-white"
          >
            <LogOut size={16} /> Sair
          </button>
        </div>
      </aside>

      {menuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={() => setMenuOpen(false)}
        />
      )}

      {/* Conteúdo */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-white/10 bg-ink/90 px-4 backdrop-blur lg:px-8">
          <button className="text-white lg:hidden" onClick={() => setMenuOpen(true)}>
            <Menu size={22} />
          </button>
          <div className="ml-auto text-right">
            <p className="text-sm text-white">{user?.email}</p>
            <p className="text-[10px] uppercase tracking-widest text-white/40">{user?.role}</p>
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
