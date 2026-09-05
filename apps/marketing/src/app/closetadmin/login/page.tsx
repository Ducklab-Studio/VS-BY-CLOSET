import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getAdminSession } from '@/lib/admin-session';
import { LoginForm } from './LoginForm';
import { AdminThemeToggle } from '@/components/closetadmin/AdminThemeToggle';

export const metadata: Metadata = { title: 'Entrar', robots: { index: false, follow: false } };

export default async function ClosetAdminLoginPage() {
  const session = await getAdminSession();
  if (session) redirect('/closetadmin');

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-sand/40 dark:bg-dark-bg px-4 transition-colors duration-200">
      <div className="absolute top-4 right-4 z-10">
        <AdminThemeToggle />
      </div>
      <div className="w-full max-w-sm rounded-2xl border border-ink/10 dark:border-white/10 bg-white dark:bg-dark-card p-8 shadow-xl transition-colors">
        <h1 className="font-heading text-2xl font-bold text-marsala dark:text-gold tracking-wide">ClosetAdmin</h1>
        <p className="mt-1 text-sm text-ink/60 dark:text-dark-muted">Painel operacional de aluguel — VS by Closet</p>
        <div className="mt-6">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
