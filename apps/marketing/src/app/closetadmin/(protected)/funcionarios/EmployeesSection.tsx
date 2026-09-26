'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Ban, Crown, Eye, Flame, Plus, RotateCcw, ShieldCheck, Trash2, UserCog, UserPlus, Wrench } from 'lucide-react';
import type { AdminModuleName } from '@/lib/admin-permissions';
import type { EmployeeListItem } from '@/lib/admin-data';
import { PRESENCE_POLL_MS, formatLastSeen, type EmployeePresence } from '@/lib/closetadmin-presence';
import { ConfirmDialog } from '@/components/closetadmin/ConfirmDialog';
import { PhoneInput } from '@/components/closetadmin/PhoneInput';
import { EmptyState } from '@/components/closetadmin/ui';
import {
  blockEmployeeAction,
  createEmployeeAction,
  listEmployeesAction,
  listPresenceAction,
  purgeEmployeeAction,
  reactivateEmployeeAction,
  removeEmployeeAction,
  restoreEmployeeAction,
  updateEmployeePermissionsAction,
  updateEmployeeRoleAction,
  type EmployeeRole,
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
  { value: 'VALLE_PASS', label: 'Valle Pass' },
];

const ROLE_LABELS: Record<string, string> = { SUPER_ADMIN: 'Proprietário', ADMIN: 'Administrador', STAFF: 'Equipe' };

/** Texto que precisa ser digitado pra criar/promover SUPER_ADMIN — o backend
 *  confere o mesmo valor (a tela só evita o envio antes da hora). */
const SUPER_ADMIN_CONFIRMATION = 'SUPER_ADMIN';

function roleOptions(canGrantSuperAdmin: boolean): { value: EmployeeRole; label: string }[] {
  return [
    { value: 'STAFF', label: 'Equipe' },
    { value: 'ADMIN', label: 'Administrador' },
    ...(canGrantSuperAdmin ? [{ value: 'SUPER_ADMIN' as const, label: 'SUPER_ADMIN (Proprietário)' }] : []),
  ];
}

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
export function EmployeesSection({
  employees: initialEmployees,
  initialPresence,
  currentUserId,
  canGrantSuperAdmin,
}: {
  employees: EmployeeListItem[];
  initialPresence: EmployeePresence[] | null;
  currentUserId: string;
  /** Só quem já é SUPER_ADMIN vê a opção — o backend recusa de qualquer forma. */
  canGrantSuperAdmin: boolean;
}) {
  const [employees, setEmployees] = useState(initialEmployees);
  const [showRemoved, setShowRemoved] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [presence, setPresence] = useState(() => presenceById(initialPresence));
  // `null` até montar no navegador: o "visto há X min" depende do relógio local.
  const [now, setNow] = useState<number | null>(null);

  // Online/offline dos outros sem recarregar: a cada 15 s, só com a aba visível
  // (e na hora em que ela volta a ficar visível) — nenhuma consulta em segundo plano.
  useEffect(() => {
    let cancelled = false;
    async function refreshPresence() {
      if (document.visibilityState !== 'visible') return;
      const { presence: fresh } = await listPresenceAction();
      if (cancelled) return;
      if (fresh) setPresence(presenceById(fresh));
      setNow(Date.now());
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refreshPresence();
    };
    const first = setTimeout(() => setNow(Date.now()), 0);
    // A lista inicial vem do servidor antes do 1º heartbeat desta aba: uma
    // atualização logo depois de abrir já traz o estado real (inclusive o
    // do próprio usuário — nada é forçado como Online aqui).
    const early = setTimeout(() => void refreshPresence(), 3_000);
    const timer = setInterval(() => void refreshPresence(), PRESENCE_POLL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearTimeout(early);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

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
      <CreateEmployeeForm canGrantSuperAdmin={canGrantSuperAdmin} onCreated={() => refresh(showRemoved)} />

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
            // `key` inclui papel e módulos: depois de salvar, o card recomeça do estado do servidor.
            <EmployeeCard
              key={`${employee.id}:${employee.role}:${employee.moduleAccess.join(',')}`}
              employee={employee}
              currentUserId={currentUserId}
              canGrantSuperAdmin={canGrantSuperAdmin}
              presence={presence.get(employee.id)}
              now={now}
              onChanged={() => refresh(showRemoved)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateEmployeeForm({ canGrantSuperAdmin, onCreated }: { canGrantSuperAdmin: boolean; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [role, setRole] = useState<EmployeeRole>('STAFF');
  const [moduleAccess, setModuleAccess] = useState<AdminModuleName[]>([]);
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSuperAdmin = role === 'SUPER_ADMIN';
  const confirmed = confirmation === SUPER_ADMIN_CONFIRMATION;

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
    if (isSuperAdmin && !confirmed) {
      setError(`Para criar um SUPER_ADMIN, digite ${SUPER_ADMIN_CONFIRMATION} na confirmação.`);
      return;
    }

    setPending(true);
    setError(null);
    const { employee, error: createError } = await createEmployeeAction({
      name: name.trim(),
      phone: phone.trim(),
      pin,
      role,
      // SUPER_ADMIN: o backend grava todos os módulos, independente do que vier.
      moduleAccess: isSuperAdmin ? [] : moduleAccess,
      ...(isSuperAdmin ? { superAdminConfirmation: confirmation } : {}),
    });
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
    setConfirmation('');
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
          <select
            value={role}
            onChange={(event) => {
              setRole(event.target.value as EmployeeRole);
              setConfirmation('');
            }}
            className={`${inputClass} mt-1.5`}
          >
            {roleOptions(canGrantSuperAdmin).map((option) => (
              <option key={option.value} value={option.value} className="bg-white text-ink dark:bg-dark-popover dark:text-dark-text">
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-4">
        <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">Módulos concedidos</span>
        {isSuperAdmin ? <AllModules /> : <ModuleToggles moduleAccess={moduleAccess} onToggle={toggleModule} />}
      </div>

      {isSuperAdmin ? <SuperAdminRisk confirmation={confirmation} onConfirmationChange={setConfirmation} disabled={pending} action="criar" /> : null}

      <div className="mt-4 flex justify-end">
        <button
          type="submit"
          disabled={pending || (isSuperAdmin && !confirmed)}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-marsala px-4 py-2.5 text-sm font-medium text-cream shadow-sm transition hover:bg-marsala/90 disabled:opacity-50 dark:bg-marsala-light dark:text-sand dark:hover:bg-marsala-glow"
        >
          <Plus size={15} />
          {pending ? 'Criando…' : isSuperAdmin ? 'Criar SUPER_ADMIN' : 'Criar funcionário'}
        </button>
      </div>

      {error ? <p className="mt-3 rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3.5 py-2.5 text-sm text-red-400">{error}</p> : null}
    </form>
  );
}

function EmployeeCard({
  employee,
  currentUserId,
  canGrantSuperAdmin,
  presence,
  now,
  onChanged,
}: {
  employee: EmployeeListItem;
  currentUserId: string;
  canGrantSuperAdmin: boolean;
  presence: EmployeePresence | undefined;
  now: number | null;
  onChanged: () => void;
}) {
  const [moduleAccess, setModuleAccess] = useState<AdminModuleName[]>([...employee.moduleAccess]);
  const [savingPermissions, setSavingPermissions] = useState(false);
  const [role, setRole] = useState<EmployeeRole>(employee.role);
  const [confirmation, setConfirmation] = useState('');
  const [savingRole, setSavingRole] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify([...moduleAccess].sort()) !== JSON.stringify([...employee.moduleAccess].sort());

  const removed = Boolean(employee.removedAt);
  const isSelf = employee.id === currentUserId;
  const isSuperAdmin = employee.role === 'SUPER_ADMIN';
  const roleChanged = role !== employee.role;
  const promoting = roleChanged && role === 'SUPER_ADMIN';
  const demotingSuperAdmin = roleChanged && isSuperAdmin;
  // Ninguém altera o próprio papel; SUPER_ADMIN só é tocado por quem é SUPER_ADMIN.
  const canEditRole = !removed && !isSelf && (canGrantSuperAdmin || !isSuperAdmin);

  function toggleModule(module: AdminModuleName) {
    setModuleAccess((current) => (current.includes(module) ? current.filter((m) => m !== module) : [...current, module]));
  }

  function changeRole(next: EmployeeRole) {
    setRole(next);
    setConfirmation('');
    setError(null);
    // Rebaixando um SUPER_ADMIN: começa sem módulos, pra escolha ser explícita.
    setModuleAccess(isSuperAdmin && next !== 'SUPER_ADMIN' ? [] : [...employee.moduleAccess]);
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

  async function saveRole() {
    setSavingRole(true);
    setError(null);
    const { error: saveError } = await updateEmployeeRoleAction(employee.id, {
      role,
      ...(role === 'SUPER_ADMIN' ? { superAdminConfirmation: confirmation } : { moduleAccess }),
    });
    setSavingRole(false);
    if (saveError) {
      setError(saveError);
      throw new Error(saveError);
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
            {isSelf ? (
              <span className="rounded-full border border-marsala/20 bg-marsala/[0.07] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-marsala dark:border-gold/20 dark:bg-gold/10 dark:text-gold">
                Você
              </span>
            ) : null}
            {employee.isTechnical ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/20 bg-sky-500/[0.07] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-500">
                <Wrench size={10} /> Técnico
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-ink/45 dark:text-dark-subtle">{employee.phone}</p>
          {/* Presença é separada de "Ativo": bloqueado/removido não tem presença, só o status da conta. */}
          {!removed && employee.active ? <PresenceIndicator presence={presence} now={now} /> : null}
        </div>

        <StatusPill employee={employee} />
      </div>

      {!removed ? (
        <div className="mt-4">
          {canEditRole ? (
            <label className="mb-3 block max-w-xs">
              <span className="text-[11px] uppercase tracking-wide text-ink/35 dark:text-dark-subtle">Papel</span>
              <select value={role} onChange={(event) => changeRole(event.target.value as EmployeeRole)} disabled={savingRole} className={`${inputClass} mt-1.5`}>
                {roleOptions(canGrantSuperAdmin).map((option) => (
                  <option key={option.value} value={option.value} className="bg-white text-ink dark:bg-dark-popover dark:text-dark-text">
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <p className="text-[11px] uppercase tracking-wide text-ink/35 dark:text-dark-subtle">Módulos concedidos</p>
          {role === 'SUPER_ADMIN' ? <AllModules /> : <ModuleToggles moduleAccess={moduleAccess} onToggle={toggleModule} />}
          {demotingSuperAdmin ? (
            <p className="mt-2 text-xs text-ink/50 dark:text-dark-muted">Marque os módulos que ele vai manter como {ROLE_LABELS[role]}.</p>
          ) : null}

          {promoting ? (
            <>
              <SuperAdminRisk confirmation={confirmation} onConfirmationChange={setConfirmation} disabled={savingRole} action="promover" />
              <button
                type="button"
                disabled={savingRole || confirmation !== SUPER_ADMIN_CONFIRMATION}
                onClick={() => saveRole().catch(() => undefined)}
                className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-red-700 disabled:opacity-50 dark:bg-red-700 dark:hover:bg-red-600"
              >
                <Crown size={13} />
                {savingRole ? 'Promovendo…' : 'Promover a SUPER_ADMIN'}
              </button>
            </>
          ) : roleChanged ? (
            <ConfirmDialog
              trigger={
                <button
                  type="button"
                  className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-marsala px-3 py-1.5 text-xs font-medium text-cream shadow-sm transition hover:bg-marsala/90 dark:bg-marsala-light dark:text-sand dark:hover:bg-marsala-glow"
                >
                  <UserCog size={13} /> Salvar papel
                </button>
              }
              title={demotingSuperAdmin ? `Rebaixar ${employee.name}?` : `Alterar o papel de ${employee.name}?`}
              description={
                demotingSuperAdmin
                  ? `${employee.name} deixa de ser SUPER_ADMIN na hora: perde a gestão de funcionários e a auditoria privada, e passa a ${ROLE_LABELS[role]} só com os módulos marcados.`
                  : `${employee.name} passa a ${ROLE_LABELS[role]}, com os módulos marcados.`
              }
              confirmLabel={demotingSuperAdmin ? 'Rebaixar' : 'Salvar papel'}
              danger={demotingSuperAdmin}
              onConfirm={saveRole}
            />
          ) : null}

          {dirty && !roleChanged && !isSuperAdmin ? (
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

      {/* A própria conta não tem bloquear/remover — o backend também recusa. */}
      {!isSelf ? (
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

          {removed ? (
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
      ) : null}

      {error ? <p className="mt-3 rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3.5 py-2.5 text-sm text-red-400">{error}</p> : null}
    </article>
  );
}

function ModuleToggles({ moduleAccess, onToggle }: { moduleAccess: AdminModuleName[]; onToggle: (module: AdminModuleName) => void }) {
  return (
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
          <input type="checkbox" checked={moduleAccess.includes(module.value)} onChange={() => onToggle(module.value)} className="hidden" />
          {module.label}
        </label>
      ))}
    </div>
  );
}

/** SUPER_ADMIN: todos os módulos, sempre — sem botões individuais. */
function AllModules() {
  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap gap-2">
        {MODULES.map((module) => (
          <span
            key={module.value}
            className="inline-flex items-center gap-1.5 rounded-lg border border-marsala/40 bg-marsala/10 px-3 py-1.5 text-xs font-medium text-marsala dark:border-gold/40 dark:bg-gold/10 dark:text-gold"
          >
            {module.label}
          </span>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-ink/45 dark:text-dark-subtle">Acesso total — SUPER_ADMIN recebe todos os módulos automaticamente.</p>
    </div>
  );
}

function SuperAdminRisk({
  confirmation,
  onConfirmationChange,
  disabled,
  action,
}: {
  confirmation: string;
  onConfirmationChange: (value: string) => void;
  disabled: boolean;
  action: 'criar' | 'promover';
}) {
  return (
    <div role="alert" className="mt-4 rounded-lg border border-red-500/30 bg-red-500/[0.07] p-3.5">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-red-500">
        <AlertTriangle size={15} /> Risco: acesso total e irrestrito
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-ink/70 dark:text-dark-muted">
        Um SUPER_ADMIN vê e altera tudo: todos os módulos, a auditoria privada e a gestão de funcionários — pode criar, promover, bloquear,
        rebaixar e remover qualquer pessoa, inclusive outros SUPER_ADMINs. Só {action === 'criar' ? 'crie' : 'promova'} alguém que precise
        desse nível de acesso.
      </p>
      <label className="mt-3 block max-w-xs">
        <span className="text-xs font-medium text-ink/60 dark:text-dark-muted">
          Para confirmar, digite <strong>{SUPER_ADMIN_CONFIRMATION}</strong>
        </span>
        <input
          value={confirmation}
          onChange={(event) => onConfirmationChange(event.target.value)}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          placeholder={SUPER_ADMIN_CONFIRMATION}
          className={`${inputClass} mt-1.5`}
        />
      </label>
    </div>
  );
}

function presenceById(list: EmployeePresence[] | null): Map<string, EmployeePresence> {
  return new Map((list ?? []).map((p) => [p.adminUserId, p]));
}

/** Bolinha verde + "Online" ou cinza + "Offline" (com "visto por último" quando houver). */
function PresenceIndicator({ presence, now }: { presence: EmployeePresence | undefined; now: number | null }) {
  if (!presence) return null;
  const lastSeen = !presence.online && now !== null ? formatLastSeen(presence.lastSeenAt, now) : null;
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs" data-presence={presence.online ? 'online' : 'offline'}>
      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${presence.online ? 'bg-emerald-500' : 'bg-neutral-400 dark:bg-white/30'}`} aria-hidden />
      <span className={presence.online ? 'font-medium text-emerald-700 dark:text-emerald-300' : 'text-ink/60 dark:text-dark-muted'}>
        {presence.online ? 'Online' : 'Offline'}
      </span>
      {lastSeen ? <span className="text-ink/45 dark:text-dark-subtle">· {lastSeen}</span> : null}
    </p>
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
