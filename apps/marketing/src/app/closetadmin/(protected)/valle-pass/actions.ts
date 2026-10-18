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
  getValePassEmailSummary,
  listValePassEmailEvents,
  listValePassEmails,
  resendValePassEmail,
  listValePassCampaigns,
  replaceValePassBenefits,
  dismissValePassHold,
  resumeValePassHeldPayments,
  getValePassFlowStatus,
  getValePassOperationalAlerts,
  verifyValePassPaymentTime,
  confirmValePassPaymentTime,
  regularizeValePassOrder,
  type ValePassFlowStatus,
  type ValePassResumeReport,
  resolveValePassRefundReview,
  type ValePassRefundReviewAction,
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
  type ValePassEmailItem,
  type ValePassEmailStatus,
  type ValePassEmailSummary,
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

/** Acompanhamento dos e-mails dos vouchers (somente leitura; qualquer perfil com o módulo). Tudo mascarado pela API. */
export async function loadValePassEmailsAction(status?: ValePassEmailStatus): Promise<{ summary: ValePassEmailSummary | null; items: ValePassEmailItem[]; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  try {
    const [summary, items] = await Promise.all([getValePassEmailSummary(session.id), listValePassEmails(session.id, status)]);
    return { summary, items, error: null };
  } catch (err) {
    return { summary: null, items: [], error: err instanceof AdminApiError ? err.message : 'Não foi possível carregar os e-mails dos vouchers.' };
  }
}

export async function loadValePassEmailEventsAction(id: string): Promise<{ events: { type: string; detail: unknown; createdAt: string }[]; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  try {
    return { events: await listValePassEmailEvents(id, session.id), error: null };
  } catch (err) {
    return { events: [], error: err instanceof AdminApiError ? err.message : 'Não foi possível carregar o histórico.' };
  }
}

/** Reenvio dos códigos por e-mail: só ADMIN, com justificativa (≥ 10 caracteres) e confirmação; a API revalida e audita. */
export async function resendValePassEmailAction(id: string, input: { note: string; toEmail?: string }): Promise<{ mayDuplicate: boolean; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  requireAdminRole(session, 'ADMIN');
  if (input.note.trim().length < 10) return { mayDuplicate: false, error: 'Informe a justificativa (mínimo de 10 caracteres).' };
  try {
    const result = await resendValePassEmail(id, { note: input.note.trim(), ...(input.toEmail?.trim() ? { toEmail: input.toEmail.trim() } : {}) }, session.id);
    revalidateValePassPath();
    return { mayDuplicate: result.mayDuplicate, error: null };
  } catch (err) {
    return { mayDuplicate: false, error: err instanceof AdminApiError ? err.message : 'Não foi possível reenviar.' };
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

/** Decisão sobre um reembolso em revisão: manter tudo ou cancelar os vouchers ainda ativos das unidades propostas. Só ADMIN, justificativa ≥ 10. */
export async function resolveValePassRefundReviewAction(id: string, action: ValePassRefundReviewAction, note: string): Promise<{ error: string | null; notice?: string }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  requireAdminRole(session, 'ADMIN');
  if (action !== 'KEEP_VOUCHERS' && action !== 'CANCEL_ACTIVE_VOUCHERS') return { error: 'Ação inválida.' };
  if (note.trim().length < 10) return { error: 'Informe a justificativa (mínimo de 10 caracteres).' };
  try {
    const result = await resolveValePassRefundReview(id, { action, note: note.trim() }, session.id);
    revalidateValePassPath();
    // Decisão de cancelar que não cancelou nenhum voucher: a decisão ficou registrada, mas a ocorrência pode exigir providência operacional.
    if (action === 'CANCEL_ACTIVE_VOUCHERS' && result.vouchersCancelled === 0) {
      return {
        error: null,
        notice:
          result.unissuedUnitsApplied > 0
            ? `Decisão registrada: nenhum voucher foi cancelado (não havia voucher ativo), mas ${result.unissuedUnitsApplied} unidade(s) ainda não emitida(s) foi(ram) descontada(s) da emissão. Confira o pedido na Shopify.`
            : 'Decisão registrada, mas NENHUM voucher foi cancelado (não havia voucher ativo nas unidades propostas). Isso não significa que o reembolso esteja resolvido: confira o pedido e os códigos manualmente, se necessário.',
      };
    }
    return { error: null };
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível registrar a decisão.' };
  }
}

/** Estado das chaves e das pendências da integração financeira (leitura: módulo VALLE_PASS). */
export async function getValePassFlowStatusAction(): Promise<{ status: ValePassFlowStatus | null; error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  try {
    return { status: await getValePassFlowStatus(session.id), error: null };
  } catch (err) {
    return { status: null, error: err instanceof AdminApiError ? err.message : 'Não foi possível carregar o estado da integração.' };
  }
}

const REGULARIZE_MESSAGES: Record<string, string> = {
  ISSUED: 'Pedido regularizado: vouchers emitidos e e-mail(s) registrado(s) na fila (nenhum e-mail é enviado por aqui).',
  HELD: 'Os fatos financeiros do pedido NÃO fecham: nada foi emitido e o pedido ficou na fila de retenções com os motivos.',
  NOTHING_TO_DO: 'Nada a regularizar: o pedido já tem todas as unidades emitidas.',
  CAMPAIGN_UNRESOLVED: 'Não há campanha única para este pedido: cadastre a campanha da variante comprada antes de regularizar.',
  FACTS_MISMATCH: 'Os dados financeiros guardados não são deste pedido. Nada foi emitido.',
  LEGACY_ORDER: 'Pedido do modelo antigo: não é regularizado por aqui.',
  NOT_PAID: 'O pedido não está pago/ativo. Nada foi emitido.',
};

/** Regularização de pedido pago com unidades sem voucher (só ADMIN, justificativa ≥ 10; a API revalida o pagamento e audita). */
export async function regularizeValePassOrderAction(orderId: string, note: string): Promise<{ error: string | null; message?: string }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  requireAdminRole(session, 'ADMIN');
  if (note.trim().length < 10) return { error: 'Informe a justificativa (mínimo de 10 caracteres).' };
  try {
    const result = await regularizeValePassOrder({ orderId, note: note.trim() }, session.id);
    revalidateValePassPath();
    return { error: null, message: REGULARIZE_MESSAGES[result.outcome.status] ?? 'Pedido avaliado.' };
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível regularizar o pedido.' };
  }
}

/**
 * Segundo contador do menu: pagamentos confirmados SEM benefício (`count`) e, destes, os críticos (`alerts`: prazo de 72 h vencido ou e-mail vencido).
 * Chamado em segundo plano pelo menu de qualquer página; nunca redireciona. Leitura: módulo VALLE_PASS.
 */
export async function getValePassFinancialAttentionAction(): Promise<{ count: number; alerts: number } | { forbidden: true } | { error: true }> {
  const session = await getAdminSession();
  if (!session || !hasAdminModule(session, 'VALLE_PASS')) return { forbidden: true };
  try {
    const snapshot = await getValePassOperationalAlerts(session.id);
    return { count: snapshot.withoutBenefit.orders + (snapshot.emailsOverdue.units > 0 ? 1 : 0), alerts: snapshot.overdue.orders + (snapshot.emailsOverdue.units > 0 ? 1 : 0) };
  } catch (err) {
    return err instanceof AdminApiError && (err.status === 401 || err.status === 403) ? { forbidden: true } : { error: true };
  }
}

const PAYMENT_TIME_REASONS: Record<string, string> = {
  TRANSACTION_DIVERGENT: 'a transação da Shopify e o webhook divergem: confira o horário na Shopify e confirme manualmente',
  NO_SUCCESS_TRANSACTION: 'a Shopify não mostra transação concluída (Pix pendente, só autorização ou falha)',
  PARTIAL_PAYMENT: 'as transações concluídas não cobrem o total do pedido',
  ONLY_TEST_TRANSACTIONS: 'só há transações de teste',
  TOTAL_UNKNOWN: 'a Shopify não informou o total do pedido',
  PROCESSED_AT_UNKNOWN: 'a transação não tem horário de processamento',
  AMOUNT_UNKNOWN: 'valor de transação ilegível',
  CURRENCY_MISMATCH: 'moeda da transação diferente da do pedido',
};

/** Confere o horário do pagamento na Shopify (leitura) e só confirma se a transação concordar com o webhook. Só ADMIN. */
export async function verifyValePassPaymentTimeAction(orderId: string, note: string): Promise<{ error: string | null; message?: string }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  requireAdminRole(session, 'ADMIN');
  if (note.trim().length < 10) return { error: 'Informe a justificativa (mínimo de 10 caracteres).' };
  try {
    const result = await verifyValePassPaymentTime({ orderId, note: note.trim() }, session.id);
    revalidateValePassPath();
    if (result.status === 'CONFIRMED') return { error: null, message: 'Horário confirmado pela transação da Shopify. Agora use "Retomar retenções" para emitir.' };
    if (result.status === 'ALREADY_CONFIRMED') return { error: null, message: 'O horário deste pedido já estava confirmado.' };
    return { error: null, message: `Horário NÃO confirmado: ${PAYMENT_TIME_REASONS[result.reason] ?? result.reason}.` };
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível conferir o horário na Shopify.' };
  }
}

/** O ADMIN informa o horário do pagamento (ex.: 2026-10-18T14:30:00-03:00), com justificativa. Só ADMIN. */
export async function confirmValePassPaymentTimeAction(orderId: string, confirmedAt: string, note: string): Promise<{ error: string | null }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  requireAdminRole(session, 'ADMIN');
  if (note.trim().length < 10) return { error: 'Informe a justificativa (mínimo de 10 caracteres).' };
  try {
    await confirmValePassPaymentTime({ orderId, confirmedAt: confirmedAt.trim(), note: note.trim() }, session.id);
    revalidateValePassPath();
    return { error: null };
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível confirmar o horário.' };
  }
}

/** Retomada das retenções feitas com a integração desligada (só ADMIN, justificativa ≥ 10). A API exige a chave ligada e processa as mais antigas primeiro. */
export async function resumeHeldPaymentsAction(note: string): Promise<{ error: string | null; report?: ValePassResumeReport }> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');
  requireAdminRole(session, 'ADMIN');
  if (note.trim().length < 10) return { error: 'Informe a justificativa (mínimo de 10 caracteres).' };
  try {
    const report = await resumeValePassHeldPayments({ note: note.trim() }, session.id);
    revalidateValePassPath();
    return { error: null, report };
  } catch (err) {
    return { error: err instanceof AdminApiError ? err.message : 'Não foi possível retomar as retenções.' };
  }
}
