'use client';

import { useEffect, useState } from 'react';
import { getValePassAttentionAction } from '@/app/closetadmin/(protected)/valle-pass/actions';
import {
  INITIAL_ATTENTION_STATE,
  VALLE_PASS_ATTENTION_CHANNEL,
  VALLE_PASS_ATTENTION_EVENT,
  startAttentionPoller,
  type AttentionState,
} from '@/lib/valle-pass-attention';

export interface ValePassAttention extends AttentionState {
  /** Sobe a cada aumento da contagem (pedido novo): destaque discreto no badge. */
  readonly bump: number;
}

/**
 * Contador do Valle Pass para o menu (uma instância por aba, no AdminShell).
 * Atualiza sozinho: a cada 30 s com a aba visível, ao voltar para a aba e
 * quando a tela do Valle Pass marca pedidos como vistos — nesta aba (evento)
 * ou em outra (BroadcastChannel). O estado vem sempre do servidor, então
 * login, logout, recarregar e outras abas enxergam o mesmo número.
 */
export function useValePassAttention(enabled: boolean): ValePassAttention {
  const [attention, setAttention] = useState<ValePassAttention>({ ...INITIAL_ATTENTION_STATE, bump: 0 });

  useEffect(() => {
    if (!enabled) return;
    const poller = startAttentionPoller({
      fetchCount: () => getValePassAttentionAction(),
      isVisible: () => document.visibilityState === 'visible',
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (handle) => window.clearInterval(handle as number),
      onChange: (next) =>
        setAttention((prev) => ({
          ...next,
          bump: prev.count !== null && next.count !== null && next.count > prev.count ? prev.bump + 1 : prev.bump,
        })),
    });
    const refresh = () => void poller.refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(VALLE_PASS_ATTENTION_CHANNEL) : null;
    channel?.addEventListener('message', refresh);
    window.addEventListener(VALLE_PASS_ATTENTION_EVENT, refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      poller.stop();
      channel?.close();
      window.removeEventListener(VALLE_PASS_ATTENTION_EVENT, refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);

  return attention;
}

/** Avisa o menu desta aba e das outras abas que a contagem mudou. */
export function notifyValePassAttentionChanged(): void {
  window.dispatchEvent(new Event(VALLE_PASS_ATTENTION_EVENT));
  if (typeof BroadcastChannel !== 'function') return;
  const channel = new BroadcastChannel(VALLE_PASS_ATTENTION_CHANNEL);
  channel.postMessage('changed');
  channel.close();
}
