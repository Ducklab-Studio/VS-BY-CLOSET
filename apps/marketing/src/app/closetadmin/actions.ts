'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { adminPost } from '@/lib/admin-api';
import { ADMIN_SESSION_COOKIE } from '@/lib/admin-session';

/** Item 2 — "logout real": revoga a sessão no banco (não só apaga o
 *  cookie local) e só então limpa o cookie. */
export async function logoutAction(): Promise<void> {
  const store = await cookies();
  const token = store.get(ADMIN_SESSION_COOKIE)?.value;

  if (token) {
    try {
      await adminPost('/admin/auth/logout', { token });
    } catch {
      // Mesmo se a revogação falhar (API fora do ar), o cookie local
      // ainda é apagado abaixo — nunca deixa a pessoa presa sem logout.
    }
  }

  store.delete(ADMIN_SESSION_COOKIE);
  redirect('/closetadmin/login');
}
