'use server';

import { revalidatePath } from 'next/cache';
import { getAdminSession, hasAdminModule, requireAdminModule, requireAdminRole, requireAdminSession } from '@/lib/admin-session';
import {
  activateValePassCampaign,
  actOnValePassLot,
  cancelValePassVoucher,
  createValePassCampaign,
  createValePassLot,
  deactivateValePassCampaign,
  getValePassAttention,
  getValePassCapacity,
  listValePassCampaigns,
  replaceValePassBenefits,
  dismissValePassHold,
  getValePassHoldPreview,
  issueValePassHold,
  type IssueValePassHoldInput,
  type ValePassBenefitInput,
  type ValePassHoldProjection,
  listValePassOrders,
  listValePassVouchers,
  markValePassOrdersViewed,
  markValePassVoucherUsed,
  restoreValePassVoucher,
  updateValePassCampaign,
  updateValePassLot,
  type CreateValePassCampaignInput,
  type UpdateValePassCampaignInput,
  type ValePassCampaign,
  type ValePassCapacity,
  type ValePassLot,
  type ValePassLotAction,
  type ValePassOrder,
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

/** Devolve a campanha ATUALIZADA (com o novo `updatedAt`): a tela precisa dessa versão para a próxima edição não receber 409 indevido. */
export async function toggleValePassCampaignAction(id: string, active: boolean): Promise<{ campaign: ValePassCampaign | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  requireAdminRole(session, 'ADMIN');
  try {
    const campaign = active ? await activateValePassCampaign(id, session.id) : await deactivateValePassCampaign(id, session.id);
    revalidateValePassPath();
    return { campaign, error: null };
  } catch (err) {
    return { campaign: null, error: err instanceof AdminApiError ? err.message : 'Não foi possível atualizar a campanha.' };
  }
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

export async function listValePassOrdersAction(options: { includeDeleted?: boolean } = {}): Promise<{ orders: ValePassOrder[] | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  try {
    const orders = await listValePassOrders(session.id, { includeDeleted: options.includeDeleted === true });
    return { orders, error: null };
  } catch (err) {
    return { orders: null, error: err instanceof AdminApiError ? err.message : 'Não foi possível carregar os pedidos.' };
  }
}

/**
 * Contador do menu. Chamado em segundo plano pelo menu de qualquer página do
 * painel, então nunca redireciona: sem sessão ou sem o módulo VALLE_PASS
 * devolve `forbidden` (o menu esconde o badge e para de perguntar) e não
 * consulta a API.
 */
export async function getValePassAttentionAction(): Promise<{ count: number } | { forbidden: true } | { error: true }> {
  const session = await getAdminSession();
  if (!session || !hasAdminModule(session, 'VALLE_PASS')) return { forbidden: true };
  try {
    return { count: (await getValePassAttention(session.id)).count };
  } catch (err) {
    return err instanceof AdminApiError && (err.status === 401 || err.status === 403) ? { forbidden: true } : { error: true };
  }
}

/** A tela do Valle Pass marca como vistos os pedidos que exibiu. Só visualização. */
export async function markValePassOrdersViewedAction(orders: readonly { id: string; statusChangedAt: string }[]): Promise<{ marked: number } | { error: true }> {
  const session = await getAdminSession();
  if (!session || !hasAdminModule(session, 'VALLE_PASS') || orders.length === 0) return { marked: 0 };
  try {
    return await markValePassOrdersViewed(orders.slice(0, 300).map(({ id, statusChangedAt }) => ({ id, statusChangedAt })));
  } catch {
    return { error: true };
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


// ── Capacidade, lotes e edição de campanha ───────────────────────────────────
// Leitura: módulo VALLE_PASS. Qualquer escrita: ADMIN por cima do módulo (o backend confere de novo). Nada aqui
// altera a Shopify nem a emissão de vales; a API devolve mensagens explicativas que são repassadas como estão.

export async function getValePassCapacityAction(campaignId: string): Promise<{ capacity: ValePassCapacity | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  try {
    return { capacity: await getValePassCapacity(campaignId, session.id), error: null };
  } catch (err) {
    return { capacity: null, error: err instanceof AdminApiError ? err.message : 'Não foi possível carregar a capacidade da campanha.' };
  }
}

export async function updateValePassCampaignAction(id: string, input: UpdateValePassCampaignInput): Promise<{ campaign: ValePassCampaign | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  requireAdminRole(session, 'ADMIN');
  try {
    const campaign = await updateValePassCampaign(id, input, session.id);
    revalidateValePassPath();
    return { campaign, error: null };
  } catch (err) {
    return { campaign: null, error: err instanceof AdminApiError ? err.message : 'Não foi possível salvar a campanha.' };
  }
}

export async function createValePassLotAction(campaignId: string, input: { name: string; quantity: number }): Promise<{ lot: ValePassLot | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  requireAdminRole(session, 'ADMIN');
  try {
    const lot = await createValePassLot(campaignId, input, session.id);
    revalidateValePassPath();
    return { lot, error: null };
  } catch (err) {
    return { lot: null, error: err instanceof AdminApiError ? err.message : 'Não foi possível criar o lote.' };
  }
}

export async function updateValePassLotAction(
  campaignId: string,
  lotId: string,
  input: { expectedUpdatedAt: string; name?: string; quantity?: number },
): Promise<{ lot: ValePassLot | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  requireAdminRole(session, 'ADMIN');
  try {
    const lot = await updateValePassLot(campaignId, lotId, input, session.id);
    revalidateValePassPath();
    return { lot, error: null };
  } catch (err) {
    return { lot: null, error: err instanceof AdminApiError ? err.message : 'Não foi possível alterar o lote.' };
  }
}

/** Descartar um pagamento retido cujo pedido deixou de estar pago. Só ADMIN, com justificativa. */
export async function resolveValePassHoldAction(holdId: string, action: 'dismiss', note: string): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  requireAdminRole(session, 'ADMIN');
  if (action !== 'dismiss') return { error: 'Ação inválida.' };
  if (note.trim().length < 3) return { error: 'Informe a justificativa (mínimo de 3 caracteres).' };
  try {
    await dismissValePassHold(holdId, note.trim(), session.id);
    revalidateValePassPath();
    return { error: null };
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível resolver a retenção.' };
  }
}

/** Números da confirmação reforçada da emissão acima do limite (somente leitura; só ADMIN). */
export async function previewValePassHoldAction(holdId: string): Promise<{ projection: ValePassHoldProjection | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  requireAdminRole(session, 'ADMIN');
  try {
    return { projection: await getValePassHoldPreview(holdId, session.id), error: null };
  } catch (err) {
    return { projection: null, error: err instanceof AdminApiError ? err.message : 'Não foi possível carregar a confirmação.' };
  }
}

/** Emissão excepcional acima do limite: justificativa ≥ 10 caracteres, total projetado digitado e os números vistos. A API revalida tudo. */
export async function issueValePassHoldAction(holdId: string, input: IssueValePassHoldInput): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  requireAdminRole(session, 'ADMIN');
  if (input.note.trim().length < 10) return { error: 'Informe a justificativa (mínimo de 10 caracteres).' };
  if (!Number.isInteger(input.confirmTotal)) return { error: 'Digite o total projetado para confirmar.' };
  try {
    await issueValePassHold(holdId, { ...input, note: input.note.trim() }, session.id);
    revalidateValePassPath();
    return { error: null };
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível emitir os vouchers.' };
  }
}

/** Salva os benefícios da campanha (voucher por empresa + descontos descritivos). Só ADMIN; auditado na API. */
export async function replaceValePassBenefitsAction(campaignId: string, benefits: readonly ValePassBenefitInput[]): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  requireAdminRole(session, 'ADMIN');
  try {
    await replaceValePassBenefits(campaignId, benefits, session.id);
    revalidateValePassPath();
    return { error: null };
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível salvar os benefícios.' };
  }
}

/** Abrir, encerrar ou cancelar um lote (a API valida o estado e a versão que a pessoa viu). */
export async function actOnValePassLotAction(
  campaignId: string,
  lotId: string,
  action: ValePassLotAction,
  expectedUpdatedAt: string,
): Promise<{ lot: ValePassLot | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  requireAdminRole(session, 'ADMIN');
  if (action !== 'open' && action !== 'close' && action !== 'cancel') return { lot: null, error: 'Ação inválida.' };
  try {
    const lot = await actOnValePassLot(campaignId, lotId, action, expectedUpdatedAt, session.id);
    revalidateValePassPath();
    return { lot, error: null };
  } catch (err) {
    return { lot: null, error: err instanceof AdminApiError ? err.message : 'Não foi possível concluir a ação no lote.' };
  }
}
