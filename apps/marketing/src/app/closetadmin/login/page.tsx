import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getAdminSession } from '@/lib/admin-session';
import { LoginForm } from './LoginForm';
import { SESSION_NOTICE_MESSAGES, parseSessionNotice } from './login-errors';
import { AdminThemeToggle } from '@/components/closetadmin/AdminThemeToggle';

export const metadata: Metadata = { title: 'Entrar', robots: { index: false, follow: false } };

export default async function ClosetAdminLoginPage({ searchParams }: { searchParams: Promise<{ motivo?: string | string[] }> }) {
  const notice = parseSessionNotice((await searchParams).motivo);
  const session = await getAdminSession();
  if (session) redirect('/closetadmin');

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-sand/40 dark:bg-dark-bg px-4 py-16 transition-colors duration-200">
      <div className="absolute top-4 right-4 z-10">
        <AdminThemeToggle />
      </div>
      <div className="w-full max-w-sm rounded-2xl border border-ink/10 dark:border-white/10 bg-white dark:bg-dark-card p-6 sm:p-8 shadow-xl transition-colors">
        <h1 className="font-heading text-2xl font-bold text-marsala dark:text-gold tracking-wide">ClosetAdmin</h1>
        <p className="mt-1 text-sm text-ink/60 dark:text-dark-muted">Painel operacional de aluguel — VS by Closet</p>
        {notice ? (
          <p
            role="status"
            data-testid="login-notice"
            data-notice={notice}
            className="mt-5 rounded-lg border border-amber-300/60 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200"
          >
            {SESSION_NOTICE_MESSAGES[notice]}
          </p>
        ) : null}
        <div className="mt-6">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
