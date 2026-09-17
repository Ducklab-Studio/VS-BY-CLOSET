'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminRole, requireAdminSession, type AdminModuleName } from '@/lib/admin-session';
import {
  blockEmployee,
  createEmployee,
  reactivateEmployee,
  removeEmployee,
  updateEmployeePermissions,
  type CreateEmployeeInput,
  type EmployeeListItem,
} from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';

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

export async function createEmployeeAction(input: CreateEmployeeInput): Promise<{ employee: EmployeeListItem | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminRole(session, 'SUPER_ADMIN');

  try {
    const employee = await createEmployee(input, session.id);
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
