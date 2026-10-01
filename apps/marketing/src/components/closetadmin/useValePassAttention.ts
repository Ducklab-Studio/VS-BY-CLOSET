'use client';

import { getValePassAttentionAction } from '@/app/closetadmin/(protected)/valle-pass/actions';
import { VALLE_PASS_ATTENTION_CHANNEL, VALLE_PASS_ATTENTION_EVENT } from '@/lib/valle-pass-attention';
import { notifyAttentionChanged, useAdminAttention, type AdminAttention, type AdminAttentionSource } from './useAdminAttention';

export type ValePassAttention = AdminAttention;

const SOURCE: AdminAttentionSource = {
  fetchCount: () => getValePassAttentionAction(),
  event: VALLE_PASS_ATTENTION_EVENT,
  channel: VALLE_PASS_ATTENTION_CHANNEL,
};

/** Contador do Valle Pass para o menu — ver useAdminAttention. */
export function useValePassAttention(enabled: boolean): ValePassAttention {
  return useAdminAttention(enabled, SOURCE);
}

/** Avisa o menu desta aba e das outras abas que a contagem mudou. */
export function notifyValePassAttentionChanged(): void {
  notifyAttentionChanged(VALLE_PASS_ATTENTION_EVENT, VALLE_PASS_ATTENTION_CHANNEL);
}
