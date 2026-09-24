'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminRole, requireAdminSession, type AdminModuleName } from '@/lib/admin-session';
import {
  blockEmployee,
  listEmployees,
  purgeEmployee,
  reactivateEmployee,
  removeEmployee,
  restoreEmployee,
  updateEmployeePermissions,
  type EmployeeListItem,
} from '@/lib/admin-data';
import { AdminApiError, adminPost, adminPut } from '@/lib/admin-api';

export type EmployeeRole = EmployeeListItem['role'];

/** `superAdminConfirmation` só vale pra SUPER_ADMIN: o backend exige o texto
 *  exato digitado e ignora `moduleAccess` (acesso total sempre). */
export interface CreateEmployeeActionInput {
  name: string;
  phone: string;
  pin: string;
  role: EmployeeRole;
  moduleAccess: AdminModuleName[];
  superAdminConfirmation?: string;
}

/**
 * Sistema de autorização de funcionários — "Ele [Anderson] poderá criar,
 * autorizar, bloquear, reativar e remover funcionários" e "Funcionários
 * não podem gerenciar usuários nem alterar permissões". `requireAdminRole`
 * com 'SUPER_ADMIN' aqui não é satisfeito por ADMIN comum (mesma
 * hierarquia absoluta do backend — ver satisfiesRole em
 * admin-role.guard.ts); é só a segunda camada, o AdminEmployeesController
 * já recusa de qualquer forma.
 */
function revalidateEmployeesPath() {
  revalidatePath('/closetadmin/funcionarios');
}

export async function createEmployeeAction(input: CreateEmployeeActionInput): Promise<{ employee: EmployeeListItem | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'SUPER_ADMIN');

  try {
    // Campos explícitos: nada além do que o formulário manda chega à API.
    const { name, phone, pin, role, moduleAccess, superAdminConfirmation } = input;
    const employee = await adminPost<EmployeeListItem>('/admin/employees', { name, phone, pin, role, moduleAccess, superAdminConfirmation, adminUserId: session.id });
    revalidateEmployeesPath();
    return { employee, error: null };
  } catch (err) {
    return { employee: null, error: err instanceof AdminApiError ? err.message : 'Não foi possível criar o funcionário.' };
  }
}

export async function blockEmployeeAction(id: string): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'SUPER_ADMIN');

  try {
    await blockEmployee(id, session.id);
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível bloquear o funcionário.' };
  }
  revalidateEmployeesPath();
  return { error: null };
}

export async function reactivateEmployeeAction(id: string): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'SUPER_ADMIN');

  try {
    await reactivateEmployee(id, session.id);
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível reativar o funcionário.' };
  }
  revalidateEmployeesPath();
  return { error: null };
}

export async function removeEmployeeAction(id: string): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'SUPER_ADMIN');

  try {
    await removeEmployee(id, session.id);
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível remover o funcionário.' };
  }
  revalidateEmployeesPath();
  return { error: null };
}

/** "Mostrar removidos" — usado pra atualizar a lista sem recarregar a
 *  página (o cliente chama de novo depois de qualquer ação, respeitando
 *  se o filtro está ligado ou não). */
export async function listEmployeesAction(includeRemoved: boolean): Promise<{ employees: EmployeeListItem[] | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'SUPER_ADMIN');

  try {
    const employees = await listEmployees(session.id, includeRemoved);
    return { employees, error: null };
  } catch (err) {
    return { employees: null, error: err instanceof AdminApiError ? err.message : 'Não foi possível carregar os funcionários.' };
  }
}

export async function restoreEmployeeAction(id: string): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'SUPER_ADMIN');

  try {
    await restoreEmployee(id, session.id);
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível restaurar o funcionário.' };
  }
  revalidateEmployeesPath();
  return { error: null };
}

/** "Excluir permanentemente" — DELETE físico real. Backend recusa se
 *  ativo, SUPER_ADMIN, ou o próprio ator; frontend também esconde o
 *  botão nesses casos (defesa em profundidade, nunca a única camada). */
export async function purgeEmployeeAction(id: string): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'SUPER_ADMIN');

  try {
    await purgeEmployee(id, session.id);
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível excluir o funcionário.' };
  }
  revalidateEmployeesPath();
  return { error: null };
}

export async function updateEmployeePermissionsAction(id: string, moduleAccess: AdminModuleName[]): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'SUPER_ADMIN');

  try {
    await updateEmployeePermissions(id, moduleAccess, session.id);
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível atualizar as permissões.' };
  }
  revalidateEmployeesPath();
  return { error: null };
}

/** Promover/rebaixar — inclusive a SUPER_ADMIN. O backend confere de novo o
 *  papel do ator, a confirmação, a própria conta e o último SUPER_ADMIN. */
export async function updateEmployeeRoleAction(
  id: string,
  input: { role: EmployeeRole; moduleAccess?: AdminModuleName[]; superAdminConfirmation?: string },
): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'SUPER_ADMIN');

  try {
    const { role, moduleAccess, superAdminConfirmation } = input;
    await adminPut(`/admin/employees/${encodeURIComponent(id)}/role`, { role, moduleAccess, superAdminConfirmation, adminUserId: session.id });
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível alterar o papel.' };
  }
  revalidateEmployeesPath();
  return { error: null };
}
