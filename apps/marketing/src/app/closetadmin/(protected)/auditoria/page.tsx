import type { Metadata } from 'next';
import { hasAdminRole, requireAdminModule, requireAdminSession } from '@/lib/admin-session';
import { listAudit } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { EmptyState, ErrorState, PageHeader } from '@/components/closetadmin/ui';
import { ClearAuditButton } from './ClearAuditButton';

export const metadata: Metadata = { title: 'Auditoria' };

/**
 * Cobre TODA ação que o backend grava — a lista de referência é
 * CRITICAL_ACTIONS em admin-audit.ts mais as de reserva/lembrete.
 * Faltavam 14 (funcionários inteiros, Valle Pass inteiro, arquivamento,
 * AUDIT_CLEARED, ADMIN_SEED_APPLIED): o fallback imprimia o
 * identificador cru em maiúsculas justamente na tela de conferência.
 * Visto de verdade no painel: "ADMIN_SEED_APPLIED" no meio de "Login" e
 * "Reserva manual criada".
 */
const ACTION_LABELS: Record<string, string> = {
  LOGIN: 'Login',
  LOGIN_FAILED: 'Tentativa de login falhou',
  LOGOUT: 'Logout',
  MANUAL_RESERVATION_CREATED: 'Reserva manual criada',
  MANUAL_RESERVATION_CANCELLED: 'Reserva manual cancelada',
  RESERVATION_MANUAL_STATUS_CORRECTION: 'Status da reserva corrigido manualmente',
  RESERVATIONS_ARCHIVED: 'Reservas arquivadas',
  RESERVATION_RESTORED: 'Reserva restaurada',
  SHOPIFY_UNITS_IMPORTED: 'Peças importadas da Shopify',
  UNIT_ACTIVATED: 'Peça ativada',
  UNIT_DEACTIVATED: 'Peça desativada',
  UNIT_UPDATED: 'Peça atualizada',
  RULE_MODIFIED: 'Regra modificada',
  BLOCK_CREATED: 'Bloqueio criado',
  BLOCK_REMOVED: 'Bloqueio removido',
  PICKUP_REMINDER_48H_SENT: 'Lembrete de retirada enviado',
  AUDIT_CLEARED: 'Logs de auditoria limpos',
  ADMIN_SEED_APPLIED: 'Usuário administrativo criado por script',
  EMPLOYEE_CREATED: 'Funcionário criado',
  EMPLOYEE_BLOCKED: 'Funcionário bloqueado',
  EMPLOYEE_REACTIVATED: 'Funcionário reativado',
  EMPLOYEE_REMOVED: 'Funcionário removido',
  EMPLOYEE_RESTORED: 'Funcionário restaurado',
  EMPLOYEE_PURGED: 'Funcionário excluído permanentemente',
  EMPLOYEE_PERMISSIONS_CHANGED: 'Permissões de funcionário alteradas',
  VALE_PASS_CAMPAIGN_CREATED: 'Campanha Valle Pass criada',
  VALE_PASS_CAMPAIGN_ACTIVATED: 'Campanha Valle Pass ativada',
  VALE_PASS_CAMPAIGN_DEACTIVATED: 'Campanha Valle Pass desativada',
  VALE_PASS_MARKED_USED: 'Valle Pass marcado como utilizado',
  VALE_PASS_CANCELLED_BY_ADMIN: 'Valle Pass cancelado',
};

export default async function ClosetAdminAuditPage() {
  const session = await requireAdminSession();
  requireAdminModule(session, 'AUDIT');

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

  return (
    <div>
      <PageHeader
        title="Auditoria"
        description={`${entries.length} evento(s) mais recentes`}
        action={hasAdminRole(session, 'SUPER_ADMIN') ? <ClearAuditButton disabled={entries.length === 0} /> : null}
      />

      {entries.length === 0 ? (
        <EmptyState title="Nenhum evento registrado ainda" />
      ) : (
        <ul className="divide-y divide-ink/5 rounded-xl border border-ink/10 bg-white shadow-sm transition-colors dark:divide-white/5 dark:border-white/10 dark:bg-dark-card">
          {entries.map((entry) => (
            <li key={`${entry.source}-${entry.id}`} className="px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-ink dark:text-dark-text">{ACTION_LABELS[entry.action] ?? entry.action}</span>
                  {entry.adminUserName ? (
                    <span className="text-ink/50 dark:text-dark-muted">
                      por <strong className="font-medium text-ink/70 dark:text-dark-text">{entry.adminUserName}</strong>
                    </span>
                  ) : null}
                </div>
                <span className="font-mono text-xs text-ink/65 dark:text-dark-subtle">{formatDateTimePt(entry.createdAt)}</span>
              </div>
              {entry.entityType ? (
                <p className="mt-0.5 font-mono text-xs text-ink/65 dark:text-dark-subtle">
                  {entry.entityType} {entry.entityId ? `· ${entry.entityId}` : ''}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatDateTimePt(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Santiago' });
}
