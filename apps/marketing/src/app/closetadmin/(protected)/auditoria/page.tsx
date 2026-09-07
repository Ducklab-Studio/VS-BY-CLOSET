import type { Metadata } from 'next';
import { requireAdminSession, requireAdminRole } from '@/lib/admin-session';
import { listAudit } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { EmptyState, ErrorState, PageHeader } from '@/components/closetadmin/ui';

export const metadata: Metadata = { title: 'Auditoria' };

const ACTION_LABELS: Record<string, string> = {
  LOGIN: 'Login',
  LOGIN_FAILED: 'Tentativa de login falhou',
  LOGOUT: 'Logout',
  MANUAL_RESERVATION_CREATED: 'Reserva manual criada',
  MANUAL_RESERVATION_CANCELLED: 'Reserva manual cancelada',
  SHOPIFY_UNITS_IMPORTED: 'Peças importadas da Shopify',
  UNIT_ACTIVATED: 'Peça ativada',
  UNIT_DEACTIVATED: 'Peça desativada',
  UNIT_UPDATED: 'Peça atualizada',
  RULE_MODIFIED: 'Regra modificada',
  BLOCK_CREATED: 'Bloqueio criado',
  BLOCK_REMOVED: 'Bloqueio removido',
};

/**
 * Fase 9, item 14 — /closetadmin/auditoria. Exclusivo de ADMIN
 * ("auditoria completa" no RBAC). Só exibe o que
 * `AdminAuditService.list` já devolve — nunca PIN/hash/token/secret
 * (isso nunca chega a existir nessas tabelas, ver admin-audit.ts no
 * backend).
 */
export default async function ClosetAdminAuditPage() {
  const session = await requireAdminSession();
  requireAdminRole(session, 'ADMIN');

  let entries: Awaited<ReturnType<typeof listAudit>> | null = null;
  let errorMessage: string | null = null;
  try {
    entries = await listAudit(session.id, 200);
  } catch (err) {
    errorMessage = err instanceof AdminApiError ? err.message : 'Erro inesperado.';
  }

  if (!entries) {
    return <ErrorState message={errorMessage ?? 'Erro inesperado.'} />;
  }

  {
    return (
      <div>
        <PageHeader title="Auditoria" description={`${entries.length} evento(s) mais recentes`} />

        {entries.length === 0 ? (
          <EmptyState title="Nenhum evento registrado ainda" />
        ) : (
          <ul className="divide-y divide-ink/5 dark:divide-white/5 rounded-xl border border-ink/10 dark:border-white/10 bg-white dark:bg-dark-card shadow-sm transition-colors">
            {entries.map((entry) => (
              <li key={`${entry.source}-${entry.id}`} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-ink dark:text-dark-text">{ACTION_LABELS[entry.action] ?? entry.action}</span>
                    {entry.adminUserName ? <span className="text-ink/50 dark:text-dark-muted">por <strong className="font-medium text-ink/70 dark:text-dark-text">{entry.adminUserName}</strong></span> : null}
                  </div>
                  <span className="text-xs text-ink/65 dark:text-dark-subtle font-mono">{formatDateTimePt(entry.createdAt)}</span>
                </div>
                {entry.entityType ? (
                  <p className="mt-0.5 text-xs text-ink/65 dark:text-dark-subtle font-mono">
                    {entry.entityType} {entry.entityId ? `· ${entry.entityId}` : ''}
                  </p>
                ) : null}
                {hasContent(entry.detail) || hasContent(entry.before) || hasContent(entry.after) ? (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-xs font-medium text-marsala dark:text-gold hover:underline">Ver detalhes</summary>
                    <pre className="mt-1 overflow-x-auto rounded-lg bg-ink/5 dark:bg-black/40 border border-ink/5 dark:border-white/5 p-2 text-xs text-ink/60 dark:text-sand/80 font-mono">
                      {JSON.stringify({ before: entry.before, after: entry.after, detail: entry.detail }, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
}

function hasContent(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function formatDateTimePt(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Santiago' });
}
