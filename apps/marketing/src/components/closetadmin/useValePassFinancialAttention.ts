'use client';

import { getValePassFinancialAttentionAction } from '@/app/closetadmin/(protected)/valle-pass/actions';
import { VALLE_PASS_FINANCIAL_CHANNEL, VALLE_PASS_FINANCIAL_EVENT } from '@/lib/valle-pass-attention';
import { notifyAttentionChanged, useAdminAttention, type AdminAttention, type AdminAttentionSource } from './useAdminAttention';

const SOURCE: AdminAttentionSource = {
  fetchCount: () => getValePassFinancialAttentionAction(),
  event: VALLE_PASS_FINANCIAL_EVENT,
  channel: VALLE_PASS_FINANCIAL_CHANNEL,
};

/**
 * Contador ESPECÍFICO do Valle Pass no menu: pagamentos confirmados sem benefício (retidos ou sem tratamento), com os críticos (prazo de 72 h / e-mail vencido)
 * em `alerts`. Independe do contador de "pedidos novos": aparece mesmo que alguém já tenha visto o pedido.
 */
export function useValePassFinancialAttention(enabled: boolean): AdminAttention {
  return useAdminAttention(enabled, SOURCE);
}

/** Avisa o menu desta aba e das outras abas que o painel financeiro mudou (ex.: depois de retomar/regularizar). */
export function notifyValePassFinancialChanged(): void {
  notifyAttentionChanged(VALLE_PASS_FINANCIAL_EVENT, VALLE_PASS_FINANCIAL_CHANNEL);
}
