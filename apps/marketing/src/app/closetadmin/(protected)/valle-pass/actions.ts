'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminModule, requireAdminRole, requireAdminSession } from '@/lib/admin-session';
import {
  activateValePassCampaign,
  cancelValePassVoucher,
  createValePassCampaign,
  deactivateValePassCampaign,
  listValePassCampaigns,
  listValePassVouchers,
  markValePassVoucherUsed,
  restoreValePassVoucher,
  type CreateValePassCampaignInput,
  type ValePassCampaign,
  type ValePassVoucher,
  type ValePassVoucherFilters,
} from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';

/**
 * Valle Pass — produto totalmente separado do fluxo de aluguel. Só o
 * módulo VALLE_PASS já libera listar/buscar/validar/marcar como
 * utilizado (operação do dia a dia); configurar campanha e cancelar um
 * vale já vendido exigem ADMIN por cima do módulo — mesmo padrão do
 * backend (ver ValePassCampaignsController/ValePassVouchersController).
 */
function revalidateValePassPath() {
  revalidatePath('/closetadmin/valle-pass');
}

export async function listValePassCampaignsAction(): Promise<{ campaigns: ValePassCampaign[] | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  try {
    const campaigns = await listValePassCampaigns(session.id);
    return { campaigns, error: null };
  } catch (err) {
    return { campaigns: null, error: err instanceof AdminApiError ? err.message : 'Não foi possível carregar as campanhas.' };
  }
}

export async function createValePassCampaignAction(input: CreateValePassCampaignInput): Promise<{ campaign: ValePassCampaign | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  requireAdminRole(session, 'ADMIN');
  try {
    const campaign = await createValePassCampaign(input, session.id);
    revalidateValePassPath();
    return { campaign, error: null };
  } catch (err) {
    return { campaign: null, error: err instanceof AdminApiError ? err.message : 'Não foi possível criar a campanha.' };
  }
}

export async function toggleValePassCampaignAction(id: string, active: boolean): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  requireAdminRole(session, 'ADMIN');
  try {
    if (active) await activateValePassCampaign(id, session.id);
    else await deactivateValePassCampaign(id, session.id);
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível atualizar a campanha.' };
  }
  revalidateValePassPath();
  return { error: null };
}

export async function listValePassVouchersAction(filters: ValePassVoucherFilters): Promise<{ vouchers: ValePassVoucher[] | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  try {
    const vouchers = await listValePassVouchers(session.id, filters);
    return { vouchers, error: null };
  } catch (err) {
    return { vouchers: null, error: err instanceof AdminApiError ? err.message : 'Não foi possível carregar os vales.' };
  }
}

export async function markValePassVoucherUsedAction(code: string): Promise<{ voucher: ValePassVoucher | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  try {
    const voucher = await markValePassVoucherUsed(code, session.id);
    revalidateValePassPath();
    return { voucher, error: null };
  } catch (err) {
    return { voucher: null, error: err instanceof AdminApiError ? err.message : 'Não foi possível marcar o vale como utilizado.' };
  }
}

export async function cancelValePassVoucherAction(code: string, reason: string): Promise<{ voucher: ValePassVoucher | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  requireAdminRole(session, 'ADMIN');
  try {
    const voucher = await cancelValePassVoucher(code, reason, session.id);
    revalidateValePassPath();
    return { voucher, error: null };
  } catch (err) {
    return { voucher: null, error: err instanceof AdminApiError ? err.message : 'Não foi possível cancelar o vale.' };
  }
}

/** Reverte um cancelamento — reabre um crédito já vendido, mesma
 *  sensibilidade de cancelar: exige ADMIN por cima do módulo. O backend
 *  é quem decide se é permitido (nunca utilizado, não expirado, cancelado
 *  por um admin — não pela Shopify — e sem conflito com o pedido); esta
 *  action só encaminha e traduz o erro. */
export async function restoreValePassVoucherAction(code: string, reason: string): Promise<{ voucher: ValePassVoucher | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  requireAdminRole(session, 'ADMIN');
  try {
    const voucher = await restoreValePassVoucher(code, reason);
    revalidateValePassPath();
    return { voucher, error: null };
  } catch (err) {
    return { voucher: null, error: err instanceof AdminApiError ? err.message : 'Não foi possível restaurar o vale.' };
  }
}

