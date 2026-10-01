'use client';

import { useEffect, useState } from 'react';
import { INITIAL_ATTENTION_STATE, startAttentionPoller, type AttentionFetchResult, type AttentionState } from '@/lib/valle-pass-attention';

export interface AdminAttention extends AttentionState {
  /** Sobe a cada aumento da contagem (item novo): destaque discreto no badge. */
  readonly bump: number;
}

export interface AdminAttentionSource {
  /** Server action do contador (nunca redireciona). */
  fetchCount(): Promise<AttentionFetchResult>;
  /** Evento desta aba disparado quando a tela marca itens como vistos. */
  readonly event: string;
  /** BroadcastChannel para as outras abas do mesmo navegador. */
  readonly channel: string;
}

/**
 * Contador do menu do ClosetAdmin (uma instância por aba e por contador, no
 * AdminShell). Atualiza sozinho: a cada 30 s com a aba visível, ao voltar
 * para a aba e quando a tela correspondente marca itens como vistos — nesta
 * aba (evento) ou em outra (BroadcastChannel). O estado vem sempre do
 * servidor, então login, logout, recarregar e outras abas enxergam o mesmo
 * número. Usado pelo Valle Pass e pelas Reservas.
 */
export function useAdminAttention(enabled: boolean, source: AdminAttentionSource): AdminAttention {
  const [attention, setAttention] = useState<AdminAttention>({ ...INITIAL_ATTENTION_STATE, bump: 0 });
  const { fetchCount, event, channel: channelName } = source;

  useEffect(() => {
    if (!enabled) return;
    const poller = startAttentionPoller({
      fetchCount,
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
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(channelName) : null;
    channel?.addEventListener('message', refresh);
    window.addEventListener(event, refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      poller.stop();
      channel?.close();
      window.removeEventListener(event, refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, fetchCount, event, channelName]);

  return attention;
}

/** Avisa o menu desta aba e das outras abas que a contagem mudou. */
export function notifyAttentionChanged(event: string, channelName: string): void {
  window.dispatchEvent(new Event(event));
  if (typeof BroadcastChannel !== 'function') return;
  const channel = new BroadcastChannel(channelName);
  channel.postMessage('changed');
  channel.close();
}
