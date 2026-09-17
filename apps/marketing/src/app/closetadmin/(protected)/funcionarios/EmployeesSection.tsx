'use client';

import { useState } from 'react';
import { Ban, Eye, Flame, Plus, RotateCcw, ShieldCheck, Trash2, UserPlus, Wrench } from 'lucide-react';
import type { AdminModuleName } from '@/lib/admin-permissions';
import type { EmployeeListItem } from '@/lib/admin-data';
import { ConfirmDialog } from '@/components/closetadmin/ConfirmDialog';
import { PhoneInput } from '@/components/closetadmin/PhoneInput';
import { EmptyState } from '@/components/closetadmin/ui';
import {
  blockEmployeeAction,
  createEmployeeAction,
  listEmployeesAction,
  purgeEmployeeAction,
  reactivateEmployeeAction,
  removeEmployeeAction,
  restoreEmployeeAction,
  updateEmployeePermissionsAction,
} from './actions';

const inputClass =
  'w-full rounded-lg border border-ink/15 bg-white px-3 py-2.5 text-sm text-ink outline-none transition focus:border-marsala focus:ring-2 focus:ring-marsala/20 dark:border-white/15 dark:bg-dark-surface dark:text-dark-text dark:focus:border-gold dark:focus:ring-gold/20';

const MODULES: { value: AdminModuleName; label: string }[] = [
  { value: 'RESERVATIONS', label: 'Reservas' },
  { value: 'CALENDAR', label: 'Calendário' },
  { value: 'PIECES', label: 'Peças' },
  { value: 'RULES', label: 'Regras' },
  { value: 'REPORTS', label: 'Relatórios' },
  { value: 'AUDIT', label: 'Auditoria' },
];

const ROLE_LABELS: Record<string, string> = { SUPER_ADMIN: 'Proprietário', ADMIN: 'Administrador', STAFF: 'Equipe' };

/**
 * "A lista padrão deve mostrar apenas funcionários ativos... Adicione,
 * somente para SUPER_ADMIN, um filtro opcional 'Mostrar removidos'" —
 * como esta tela inteira já é exclusiva de SUPER_ADMIN (page.tsx),
 * mostrar o filtro aqui não precisa de checagem extra de papel.
 *
 * `employees` vem do servidor já filtrado (sem removidos, por padrão).
 * Depois de montado, toda leitura/ação passa a vir de
 * `listEmployeesAction`/as próprias ações — nunca `router.refresh()`:
 * assim a lista atualiza sozinha (sem recarregar a página) e sempre
 * respeita o estado atual do filtro "Mostrar removidos".
 */
export function EmployeesSection({ employees: initialEmployees, currentUserId }: { employees: EmployeeListItem[]; currentUserId: string }) {
  const [employees, setEmployees] = useState(initialEmployees);
  const [showRemoved, setShowRemoved] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  async function refresh(includeRemoved: boolean) {
    const { employees: fresh, error } = await listEmployeesAction(includeRemoved);
    if (error || !fresh) {
      setRefreshError(error ?? 'Não foi possível atualizar a lista.');
      return;
    }
    setRefreshError(null);
    setEmployees(fresh);
  }

  async function handleToggleShowRemoved(checked: boolean) {
    setShowRemoved(checked);
    await refresh(checked);
  }

  const visibleEmployees = showRemoved ? employees : employees.filter((e) => !e.removedAt);

  return (
    <div className="space-y-4">
      <CreateEmployeeForm onCreated={() => refresh(showRemoved)} />

      <label className="flex w-fit cursor-pointer items-center gap-2 text-xs font-medium text-ink/60 dark:text-dark-muted">
        <input type="checkbox" checked={showRemoved} onChange={(event) => handleToggleShowRemoved(event.target.checked)} className="rounded border-ink/20 dark:border-white/20" />
        <Eye size={14} />
        Mostrar removidos
      </label>

      {refreshError ? <p className="rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3.5 py-2.5 text-sm text-red-400">{refreshError}</p> : null}

      {visibleEmployees.length === 0 ? (
        <EmptyState
          title={showRemoved ? 'Nenhum funcionário encontrado' : 'Nenhum funcionário ativo cadastrado ainda'}
          description={showRemoved ? undefined : 'Use o formulário acima para criar o primeiro acesso.'}
        />
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {visibleEmployees.map((employee) => (
            <EmployeeCard key={employee.id} employee={employee} currentUserId={currentUserId} onChanged={() => refresh(showRemoved)} />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateEmployeeForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [role, setRole] = useState<'ADMIN' | 'STAFF'>('STAFF');
  const [moduleAccess, setModuleAccess] = useState<AdminModuleName[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleModule(module: AdminModuleName) {
    setModuleAccess((current) => (current.includes(module) ? current.filter((m) => m !== module) : [...current, module]));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    if (name.trim().length < 1 || phone.trim().length < 3) {
      setError('Preencha nome e telefone.');
      return;
    }
    if (!/^\d{4,8}$/.test(pin)) {
      setError('O PIN precisa ter entre 4 e 8 dígitos numéricos.');
      return;
    }

    setPending(true);
    setError(null);
    const { employee, error: createError } = await createEmployeeAction({ name: name.trim(), phone: phone.trim(), pin, role, moduleAccess });
    setPending(false);

    if (createError || !employee) {
      setError(createError ?? 'Não foi possível criar o funcionário.');
      return;
    }

    setName('');
    setPhone('');
    setPin('');
    setRole('STAFF');
    setModuleAccess([]);
    onCreated();
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-ink/10 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-dark-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink dark:text-dark-text">Criar novo funcionário</h3>
          <p className="mt-1 text-xs text-ink/45 dark:text-dark-subtle">Login próprio (telefone + PIN) — nunca credenciais compartilhadas.</p>
        </div>
        <div className="rounded-lg bg-marsala/10 p-2 text-marsala dark:bg-gold/10 dark:text-gold">
          <UserPlus size={18} />
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-12">
        <label className="lg:col-span-4">
          <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">Nome</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nome completo" className={`${inputClass} mt-1.5`} />
        </label>

        <label className="lg:col-span-3">
          <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">Telefone</span>
          <div className="mt-1.5">
            <PhoneInput value={phone} onChange={setPhone} disabled={pending} required />
          </div>
        </label>

        <label className="lg:col-span-2">
          <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">PIN (4–8 dígitos)</span>
          <input
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            placeholder="1234"
            className={`${inputClass} mt-1.5`}
          />
        </label>

        <label className="lg:col-span-3">
          <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">Papel</span>
          <select value={role} onChange={(event) => setRole(event.target.value as 'ADMIN' | 'STAFF')} className={`${inputClass} mt-1.5`}>
            <option value="STAFF" className="bg-white text-ink dark:bg-dark-popover dark:text-dark-text">Equipe</option>
            <option value="ADMIN" className="bg-white text-ink dark:bg-dark-popover dark:text-dark-text">Administrador</option>
          </select>
        </label>
      </div>

      <div className="mt-4">
        <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">Módulos concedidos</span>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {MODULES.map((module) => (
            <label
              key={module.value}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                moduleAccess.includes(module.value)
                  ? 'border-marsala/40 bg-marsala/10 text-marsala dark:border-gold/40 dark:bg-gold/10 dark:text-gold'
                  : 'border-ink/15 text-ink/55 hover:bg-ink/5 dark:border-white/15 dark:text-dark-muted dark:hover:bg-white/5'
              }`}
            >
              <input type="checkbox" checked={moduleAccess.includes(module.value)} onChange={() => toggleModule(module.value)} className="hidden" />
              {module.label}
            </label>
          ))}
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <button type="submit" disabled={pending} className="inline-flex items-center justify-center gap-2 rounded-lg bg-marsala px-4 py-2.5 text-sm font-medium text-cream shadow-sm transition hover:bg-marsala/90 disabled:opacity-50 dark:bg-marsala-light dark:text-sand dark:hover:bg-marsala-glow">
          <Plus size={15} />
          {pending ? 'Criando…' : 'Criar funcionário'}
        </button>
      </div>

      {error ? <p className="mt-3 rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3.5 py-2.5 text-sm text-red-400">{error}</p> : null}
    </form>
  );
}

function EmployeeCard({ employee, currentUserId, onChanged }: { employee: EmployeeListItem; currentUserId: string; onChanged: () => void }) {
  const [moduleAccess, setModuleAccess] = useState<AdminModuleName[]>([...employee.moduleAccess]);
  const [savingPermissions, setSavingPermissions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify([...moduleAccess].sort()) !== JSON.stringify([...employee.moduleAccess].sort());

  const removed = Boolean(employee.removedAt);
  const isSelf = employee.id === currentUserId;

  function toggleModule(module: AdminModuleName) {
    setModuleAccess((current) => (current.includes(module) ? current.filter((m) => m !== module) : [...current, module]));
  }

  async function savePermissions() {
    setSavingPermissions(true);
    setError(null);
    const { error: saveError } = await updateEmployeePermissionsAction(employee.id, moduleAccess);
    setSavingPermissions(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    onChanged();
  }

  async function runAction(action: () => Promise<{ error: string | null }>) {
    setError(null);
    const { error: actionError } = await action();
    if (actionError) {
      setError(actionError);
      throw new Error(actionError);
    }
    onChanged();
  }

  return (
    <article className="rounded-xl border border-ink/10 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-dark-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-ink dark:text-dark-text">{employee.name}</h3>
            <span className="rounded-full border border-ink/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink/45 dark:border-white/10 dark:text-dark-subtle">
              {ROLE_LABELS[employee.role] ?? employee.role}
            </span>
            {employee.isTechnical ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/20 bg-sky-500/[0.07] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-500">
                <Wrench size={10} /> Técnico
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-ink/45 dark:text-dark-subtle">{employee.phone}</p>
        </div>

        <StatusPill employee={employee} />
      </div>

      {!removed ? (
        <div className="mt-4">
          <p className="text-[11px] uppercase tracking-wide text-ink/35 dark:text-dark-subtle">Módulos concedidos</p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {MODULES.map((module) => (
              <label
                key={module.value}
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                  moduleAccess.includes(module.value)
                    ? 'border-marsala/40 bg-marsala/10 text-marsala dark:border-gold/40 dark:bg-gold/10 dark:text-gold'
                    : 'border-ink/15 text-ink/55 hover:bg-ink/5 dark:border-white/15 dark:text-dark-muted dark:hover:bg-white/5'
                }`}
              >
                <input type="checkbox" checked={moduleAccess.includes(module.value)} onChange={() => toggleModule(module.value)} className="hidden" />
                {module.label}
              </label>
            ))}
          </div>
          {dirty ? (
            <button
              type="button"
              disabled={savingPermissions}
              onClick={savePermissions}
              className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-marsala px-3 py-1.5 text-xs font-medium text-cream shadow-sm transition hover:bg-marsala/90 disabled:opacity-50 dark:bg-marsala-light dark:text-sand dark:hover:bg-marsala-glow"
            >
              <ShieldCheck size={13} />
              {savingPermissions ? 'Salvando…' : 'Salvar permissões'}
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 text-xs text-ink/45 dark:text-dark-subtle">Removido em {formatDateTimePt(employee.removedAt!)}.</p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {!removed && employee.active ? (
          <ConfirmDialog
            trigger={
              <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/[0.05] px-2.5 py-1.5 text-xs font-medium text-amber-500 transition hover:bg-amber-500/10">
                <Ban size={13} /> Bloquear
              </button>
            }
            title={`Bloquear ${employee.name}?`}
            description="O acesso é suspenso imediatamente (sessões ativas são revogadas). Pode ser reativado depois — nenhum dado é apagado."
            confirmLabel="Bloquear"
            danger
            onConfirm={() => runAction(() => blockEmployeeAction(employee.id))}
          />
        ) : null}

        {!removed && !employee.active ? (
          <ConfirmDialog
            trigger={
              <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.05] px-2.5 py-1.5 text-xs font-medium text-emerald-500 transition hover:bg-emerald-500/10">
                <RotateCcw size={13} /> Reativar
              </button>
            }
            title={`Reativar ${employee.name}?`}
            description="O funcionário volta a poder fazer login com o telefone e o PIN já cadastrados."
            confirmLabel="Reativar"
            onConfirm={() => runAction(() => reactivateEmployeeAction(employee.id))}
          />
        ) : null}

        {!removed ? (
          <ConfirmDialog
            trigger={
              <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/[0.05] px-2.5 py-1.5 text-xs font-medium text-red-400 transition hover:bg-red-500/10">
                <Trash2 size={13} /> Remover
              </button>
            }
            title={`Remover ${employee.name}?`}
            description="O acesso é encerrado imediatamente (sessões ativas são revogadas) e ele some da lista principal. Nada é apagado — o registro e a auditoria continuam guardados, e dá pra restaurar depois em 'Mostrar removidos'."
            confirmLabel="Remover"
            danger
            onConfirm={() => runAction(() => removeEmployeeAction(employee.id))}
          />
        ) : (
          <ConfirmDialog
            trigger={
              <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.05] px-2.5 py-1.5 text-xs font-medium text-emerald-500 transition hover:bg-emerald-500/10">
                <RotateCcw size={13} /> Restaurar
              </button>
            }
            title={`Restaurar ${employee.name}?`}
            description="Ele volta a aparecer na lista principal e a poder fazer login com o telefone e o PIN já cadastrados."
            confirmLabel="Restaurar"
            onConfirm={() => runAction(() => restoreEmployeeAction(employee.id))}
          />
        )}

        {removed && !isSelf ? (
          <ConfirmDialog
            trigger={
              <button type="button" className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600">
                <Flame size={13} /> Excluir permanentemente
              </button>
            }
            title={`Excluir ${employee.name} permanentemente?`}
            description={
              <>
                <strong>Isso não pode ser desfeito.</strong> O registro deste funcionário é apagado do banco — ele não vai mais
                aparecer nem em &quot;Mostrar removidos&quot;. O histórico de auditoria dele é preservado (sem PIN nem telefone
                nas ações antigas), e esta exclusão fica registrada com o nome, telefone e papel dele antes de apagar. Digite
                qualquer confirmação abaixo pra prosseguir.
              </>
            }
            confirmLabel="Excluir permanentemente"
            requireReason
            danger
            onConfirm={() => runAction(() => purgeEmployeeAction(employee.id))}
          />
        ) : null}
      </div>

      {error ? <p className="mt-3 rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3.5 py-2.5 text-sm text-red-400">{error}</p> : null}
    </article>
  );
}

function StatusPill({ employee }: { employee: EmployeeListItem }) {
  if (employee.removedAt) {
    return <span className="rounded-full bg-neutral-200/70 px-2.5 py-1 text-xs font-medium text-neutral-600 dark:bg-white/5 dark:text-dark-subtle">Removido</span>;
  }
  if (!employee.active) {
    return <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">Bloqueado</span>;
  }
  return <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">Ativo</span>;
}

function formatDateTimePt(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}
